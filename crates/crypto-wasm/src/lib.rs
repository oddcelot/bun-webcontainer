//! RustCrypto behind a byte-buffer ABI, for the playground's synchronous `node:crypto` APIs: AES (ECB, CBC, CTR,
//! CFB, OFB, GCM) and ChaCha20-Poly1305 as streaming ciphers, RSA (PKCS#1 v1.5, PSS, OAEP), ECDSA P-256/P-384 and
//! Ed25519 signatures, and the key formats around them (PKCS#1, PKCS#8, SPKI, SEC1, JWK components).
//!
//! One export does the work: `call(op, ptr, len)`. The input is a list of fields (`[u32 le length][bytes]` each);
//! the result is `[u32 total length][u32 status][fields...]` in a buffer from `alloc` that the host `dealloc`s.
//! Status 0 is success; 1 is an error whose fields are `code` and `message`.
//! The one import, `env.host_random(ptr, len)`, fills memory with random bytes (key generation, blinding).

mod cipher;
mod keys;

use std::alloc::{Layout, alloc as std_alloc, dealloc as std_dealloc};

/// An error as node:crypto reports it: a Node `code` (and the class, by its prefix) and a message.
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

pub type Result<T> = core::result::Result<T, Error>;

pub fn err<T>(code: &'static str, message: impl Into<String>) -> Result<T> {
    Err(Error { code, message: message.into() })
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::NonNull::dangling().as_ptr();
    }
    unsafe { std_alloc(Layout::from_size_align_unchecked(len, 1)) }
}

/// # Safety
/// `ptr`/`len` must come from `alloc` (or from `call`'s result).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len != 0 {
        unsafe { std_dealloc(ptr, Layout::from_size_align_unchecked(len, 1)) }
    }
}

/// The fields of an input buffer.
pub struct Args<'a>(Vec<&'a [u8]>);

impl<'a> Args<'a> {
    fn parse(mut buf: &'a [u8]) -> Result<Self> {
        let mut out = Vec::new();
        while !buf.is_empty() {
            if buf.len() < 4 {
                return err("ERR_INTERNAL", "truncated input");
            }
            let n = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
            if buf.len() < 4 + n {
                return err("ERR_INTERNAL", "truncated input");
            }
            out.push(&buf[4..4 + n]);
            buf = &buf[4 + n..];
        }
        Ok(Args(out))
    }

    pub fn get(&self, i: usize) -> &'a [u8] {
        self.0.get(i).copied().unwrap_or(&[])
    }

    pub fn str(&self, i: usize) -> &'a str {
        core::str::from_utf8(self.get(i)).unwrap_or("")
    }

    pub fn byte(&self, i: usize) -> u8 {
        self.get(i).first().copied().unwrap_or(0)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

/// Output fields.
#[derive(Default)]
pub struct Out(Vec<u8>);

impl Out {
    pub fn put(&mut self, field: &[u8]) -> &mut Self {
        self.0.extend_from_slice(&(field.len() as u32).to_le_bytes());
        self.0.extend_from_slice(field);
        self
    }
}

fn dispatch(op: u32, a: &Args) -> Result<Out> {
    match op {
        1..=9 => cipher::call(op, a),
        _ => keys::call(op, a),
    }
}

/// # Safety
/// `ptr`/`len` must be a readable range.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn call(op: u32, ptr: *const u8, len: usize) -> *mut u8 {
    let input = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(ptr, len) } };
    let (status, body) = match Args::parse(input).and_then(|a| dispatch(op, &a)) {
        Ok(out) => (0u32, out.0),
        Err(e) => {
            let mut o = Out::default();
            o.put(e.code.as_bytes()).put(e.message.as_bytes());
            (1, o.0)
        }
    };
    let total = 8 + body.len();
    let p = alloc(total);
    unsafe {
        core::ptr::copy_nonoverlapping((total as u32).to_le_bytes().as_ptr(), p, 4);
        core::ptr::copy_nonoverlapping(status.to_le_bytes().as_ptr(), p.add(4), 4);
        core::ptr::copy_nonoverlapping(body.as_ptr(), p.add(8), body.len());
    }
    p
}

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn host_random(ptr: *mut u8, len: usize);
}

/// Random bytes from the host (`crypto.getRandomValues`).
pub struct HostRng;

impl rand_core::RngCore for HostRng {
    fn next_u32(&mut self) -> u32 {
        let mut b = [0u8; 4];
        self.fill_bytes(&mut b);
        u32::from_le_bytes(b)
    }
    fn next_u64(&mut self) -> u64 {
        let mut b = [0u8; 8];
        self.fill_bytes(&mut b);
        u64::from_le_bytes(b)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        if !dest.is_empty() {
            unsafe { host_random(dest.as_mut_ptr(), dest.len()) }
        }
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> core::result::Result<(), rand_core::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

impl rand_core::CryptoRng for HostRng {}

// rand_core's `std` feature (turned on by the key crates) pulls in getrandom, which has no wasm backend without a
// browser's `js` glue; this one is the same host import.
fn getrandom_host(dest: &mut [u8]) -> core::result::Result<(), getrandom::Error> {
    rand_core::RngCore::fill_bytes(&mut HostRng, dest);
    Ok(())
}

getrandom::register_custom_getrandom!(getrandom_host);
