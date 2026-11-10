// HTTP for gix's smart-HTTP transport, through the host: two imports (module `runbun`) that make a request and hand
// back the response. The host blocks until it has the whole response (in the playground: a synchronous
// XMLHttpRequest in the git worker, through the playground's git proxy), so this side is plain blocking code.
//
// gix writes a POST's body after `post` returns and reads the response headers only once it has (HeadersThenBody in
// gix-transport), so a request is sent on the first read of its headers or body, with everything written by then.
use gix_transport::client::blocking_io::http::{GetResponse, Http, PostBodyDataKind, PostResponse};
use std::io::{BufRead, Read, Write};
use std::sync::{Arc, Mutex};

#[link(wasm_import_module = "runbun")]
unsafe extern "C" {
    /// Makes a request. `head` is `METHOD URL\n` then one `Name: value\n` per header; `body` may be empty.
    /// On success (0) `out` holds the status, the response headers' length (the same `Name: value\n` lines), the body's
    /// length and a handle for `http_read`. Nonzero: the request failed (`out[0]` is the length of a message `http_read`
    /// gives as its headers).
    fn http_request(head: *const u8, head_len: usize, body: *const u8, body_len: usize, out: *mut u32) -> u32;
    /// Copies a response's headers and body out (buffers of the lengths `http_request` gave) and frees it.
    fn http_read(handle: u32, headers: *mut u8, body: *mut u8) -> u32;
}

struct Response {
    status: u32,
    headers: Vec<u8>,
    body: Vec<u8>,
}

fn send(head: &str, body: &[u8]) -> std::io::Result<Response> {
    let mut out = [0u32; 4];
    let failed = unsafe { http_request(head.as_ptr(), head.len(), body.as_ptr(), body.len(), out.as_mut_ptr()) };
    let (headers_len, body_len) = if failed != 0 { (out[0] as usize, 0) } else { (out[1] as usize, out[2] as usize) };
    let mut headers = vec![0u8; headers_len];
    let mut data = vec![0u8; body_len];
    unsafe { http_read(out[3], headers.as_mut_ptr(), data.as_mut_ptr()) };
    if failed != 0 {
        return Err(std::io::Error::other(String::from_utf8_lossy(&headers).into_owned()));
    }
    Ok(Response { status: out[0], headers, body: data })
}

/// One request: written to until the first read, then sent once.
struct Exchange {
    head: String,
    body: Vec<u8>,
    response: Option<std::io::Result<Response>>,
}

impl Exchange {
    fn response(&mut self) -> std::io::Result<&Response> {
        if self.response.is_none() {
            let r = send(&self.head, &self.body).and_then(|r| match r.status {
                200..=299 => Ok(r),
                401 => Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "authentication required (HTTP 401)")),
                403 => Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied (HTTP 403)")),
                404 => Err(std::io::Error::new(std::io::ErrorKind::NotFound, "repository not found (HTTP 404)")),
                s => Err(std::io::Error::other(format!("the server answered HTTP {s}"))),
            });
            self.response = Some(r);
            self.body = Vec::new();
        }
        match self.response.as_ref().expect("set above") {
            Ok(r) => Ok(r),
            Err(e) => Err(std::io::Error::new(e.kind(), e.to_string())),
        }
    }
}

// Shared between the request's parts: gix's boxed transports must be Send (one thread here, so the lock never waits).
type Shared = Arc<Mutex<Exchange>>;

/// The response's headers or body: sends the exchange on the first read, then reads its own copy.
pub struct Part {
    ex: Shared,
    headers: bool,
    data: Option<Vec<u8>>,
    at: usize,
}

impl Part {
    fn new(ex: &Shared, headers: bool) -> Self {
        Part { ex: ex.clone(), headers, data: None, at: 0 }
    }
    fn bytes(&mut self) -> std::io::Result<&[u8]> {
        if self.data.is_none() {
            let mut ex = self.ex.lock().expect("one thread");
            let headers = self.headers;
            ex.response()?;
            let r = ex.response.as_mut().expect("sent").as_mut().expect("ok");
            // The headers are read once (gix checks the content type); the body is read once, by gix's packet reader.
            self.data = Some(if headers { r.headers.clone() } else { std::mem::take(&mut r.body) });
        }
        let data = self.data.as_deref().expect("set above");
        Ok(&data[self.at.min(data.len())..])
    }
}

impl Read for Part {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let rest = self.bytes()?;
        let n = rest.len().min(buf.len());
        buf[..n].copy_from_slice(&rest[..n]);
        self.at += n;
        Ok(n)
    }
}

impl BufRead for Part {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        self.bytes()
    }
    fn consume(&mut self, n: usize) {
        self.at += n;
    }
}

/// A POST's body, gathered until the request is sent.
pub struct Body(Shared);

impl Write for Body {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("one thread").body.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// gix's HTTP backend over the host's requests.
#[derive(Default)]
pub struct Remote;

fn exchange(method: &str, url: &str, headers: impl IntoIterator<Item = impl AsRef<str>>) -> Shared {
    let mut head = format!("{method} {url}\n");
    for h in headers {
        head.push_str(h.as_ref());
        head.push('\n');
    }
    Arc::new(Mutex::new(Exchange { head, body: Vec::new(), response: None }))
}

impl Http for Remote {
    type Headers = Part;
    type ResponseBody = Part;
    type PostBody = Body;

    fn get(&mut self, url: &str, _base_url: &str, headers: impl IntoIterator<Item = impl AsRef<str>>) -> gix_error::Result<GetResponse<Part, Part>> {
        let ex = exchange("GET", url, headers);
        Ok(GetResponse { headers: Part::new(&ex, true), body: Part::new(&ex, false) })
    }

    fn post(
        &mut self,
        url: &str,
        _base_url: &str,
        headers: impl IntoIterator<Item = impl AsRef<str>>,
        _body: PostBodyDataKind,
    ) -> gix_error::Result<PostResponse<Part, Part, Body>> {
        let ex = exchange("POST", url, headers);
        Ok(PostResponse { post_body: Body(ex.clone()), headers: Part::new(&ex, true), body: Part::new(&ex, false) })
    }

    fn configure(&mut self, _config: &dyn std::any::Any) -> gix_error::Result {
        Ok(())
    }
}

/// Lets gix connect to `http(s)://` remotes through the host (the patched gix-transport's hook).
pub fn install() {
    let _ = gix_transport::client::blocking_io::HTTP_CONNECT.set(|url, version, trace| {
        Box::new(gix_transport::client::blocking_io::http::connect_http(Remote, url, version, trace))
    });
}
