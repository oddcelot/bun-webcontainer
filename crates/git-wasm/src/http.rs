// HTTP for gix's smart-HTTP transport, through the host (import module `runbun`, NOTES.md "Network"). The host blocks
// until it has the response's status and headers, then hands the body over in chunks as it arrives (the playground: a
// streaming fetch on the page passing chunks to the git worker through shared memory, or one synchronous
// XMLHttpRequest where there is none), so this side is plain blocking code that reads a pack while it downloads.
//
// gix writes a POST's body after `post` returns and reads the response headers only once it has (HeadersThenBody in
// gix-transport), so a request is sent on the first read of its headers or body, with everything written by then.
use gix_transport::client::blocking_io::http::{GetResponse, Http, PostBodyDataKind, PostResponse};
use std::io::{BufRead, Read, Write};
use std::sync::{Arc, Mutex};

#[link(wasm_import_module = "runbun")]
unsafe extern "C" {
    /// Sends a request and waits for its status and headers. `head` is `METHOD URL\n` then one `Name: value\n` per
    /// header; `body` may be empty. `out` gets [status, length of the headers (`Name: value\n` lines), handle].
    /// Nonzero: the request failed; `out[1]` is then the length of a message `http_headers` gives instead.
    fn http_request(head: *const u8, head_len: usize, body: *const u8, body_len: usize, out: *mut u32) -> u32;
    /// Copies the headers (or the failure message) out, into a buffer of the length `http_request` gave.
    fn http_headers(handle: u32, buf: *mut u8) -> u32;
    /// Reads up to `len` bytes of the body, waiting for at least one: the count, 0 at its end, negative when the
    /// download failed.
    fn http_body(handle: u32, buf: *mut u8, len: usize) -> i32;
    /// Done with a request (its body need not have been read to the end).
    fn http_close(handle: u32);
    /// A line saying what the command is doing (`Connecting to github.com`), for a progress display.
    fn progress(text: *const u8, len: usize);
}

/// Tells the host what the command is doing now.
pub fn report(text: &str) {
    unsafe { progress(text.as_ptr(), text.len()) }
}

struct Response {
    status: u32,
    headers: Vec<u8>,
    handle: u32,
}

impl Drop for Response {
    fn drop(&mut self) {
        unsafe { http_close(self.handle) }
    }
}

fn send(head: &str, body: &[u8]) -> std::io::Result<Response> {
    let mut out = [0u32; 3];
    let failed = unsafe { http_request(head.as_ptr(), head.len(), body.as_ptr(), body.len(), out.as_mut_ptr()) };
    let mut headers = vec![0u8; out[1] as usize];
    unsafe { http_headers(out[2], headers.as_mut_ptr()) };
    let r = Response { status: out[0], headers, handle: out[2] };
    if failed != 0 {
        return Err(std::io::Error::other(String::from_utf8_lossy(&r.headers).into_owned()));
    }
    Ok(r)
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

/// The response's headers (all at once) or body (chunk by chunk from the host), sending the exchange on first read.
pub struct Part {
    ex: Shared,
    headers: bool,
    buf: Vec<u8>,
    at: usize,
    /// The headers were copied, or the body's end was reached.
    done: bool,
}

const CHUNK: usize = 256 * 1024;

impl Part {
    fn new(ex: &Shared, headers: bool) -> Self {
        Part { ex: ex.clone(), headers, buf: Vec::new(), at: 0, done: false }
    }
    /// What's left of the buffer, refilled from the response when used up.
    fn fill(&mut self) -> std::io::Result<&[u8]> {
        if self.at >= self.buf.len() && !self.done {
            let mut ex = self.ex.lock().expect("one thread");
            let r = ex.response()?;
            self.at = 0;
            if self.headers {
                self.buf = r.headers.clone();
                self.done = true;
            } else {
                self.buf.resize(CHUNK, 0);
                let n = unsafe { http_body(r.handle, self.buf.as_mut_ptr(), CHUNK) };
                if n < 0 {
                    self.buf.clear();
                    return Err(std::io::Error::other("the download broke off"));
                }
                self.buf.truncate(n as usize);
                self.done = n == 0;
            }
        }
        Ok(&self.buf[self.at.min(self.buf.len())..])
    }
}

impl Read for Part {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let rest = self.fill()?;
        let n = rest.len().min(buf.len());
        buf[..n].copy_from_slice(&rest[..n]);
        self.at += n;
        Ok(n)
    }
}

impl BufRead for Part {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        self.fill()
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
