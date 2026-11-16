//! Streaming ciphers: one handle per `createCipheriv` / `createDecipheriv`.
//!
//! Ops: 1 new(mode, key, iv, encrypt, tag_len) -> handle; 2 update(handle, data) -> out; 3 final(handle) -> out, tag;
//! 4 set_aad(handle, data); 5 set_tag(handle, tag); 6 set_padding(handle, on); 7 free(handle).

use std::cell::RefCell;

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, KeyIvInit, StreamCipher};
use aes::{Aes128, Aes192, Aes256};
use chacha20::ChaCha20;
use ghash::GHash;
use ghash::universal_hash::UniversalHash;
use poly1305::Poly1305;

use crate::{Args, Out, Result, err};

enum Aes {
    A128(Aes128),
    A192(Aes192),
    A256(Aes256),
}

impl Aes {
    fn new(key: &[u8]) -> Option<Aes> {
        Some(match key.len() {
            16 => Aes::A128(Aes128::new(GenericArray::from_slice(key))),
            24 => Aes::A192(Aes192::new(GenericArray::from_slice(key))),
            32 => Aes::A256(Aes256::new(GenericArray::from_slice(key))),
            _ => return None,
        })
    }

    fn encrypt(&self, b: &mut [u8; 16]) {
        let g = GenericArray::from_mut_slice(b);
        match self {
            Aes::A128(c) => c.encrypt_block(g),
            Aes::A192(c) => c.encrypt_block(g),
            Aes::A256(c) => c.encrypt_block(g),
        }
    }

    fn decrypt(&self, b: &mut [u8; 16]) {
        let g = GenericArray::from_mut_slice(b);
        match self {
            Aes::A128(c) => c.decrypt_block(g),
            Aes::A192(c) => c.decrypt_block(g),
            Aes::A256(c) => c.decrypt_block(g),
        }
    }
}

fn block(b: &[u8]) -> [u8; 16] {
    let mut o = [0u8; 16];
    o.copy_from_slice(&b[..16]);
    o
}

fn xor16(a: &mut [u8; 16], b: &[u8; 16]) {
    for i in 0..16 {
        a[i] ^= b[i];
    }
}

/// OpenSSL's error text, as Bun (BoringSSL) words it.
fn cipher_error<T>(code: &'static str, hex: &str, reason: &str) -> Result<T> {
    err(code, format!("error:{hex}:Cipher functions:OPENSSL_internal:{reason}"))
}

fn bad_decrypt<T>() -> Result<T> {
    cipher_error("ERR_OSSL_BAD_DECRYPT", "1e000065", "BAD_DECRYPT")
}

fn auth_failed<T>() -> Result<T> {
    err("ERR_CRYPTO_UNSUPPORTED_STATE", "Unsupported state or unable to authenticate data")
}

/// ECB and CBC, with or without PKCS#7 padding.
struct Blocks {
    aes: Aes,
    cbc: bool,
    enc: bool,
    pad: bool,
    iv: [u8; 16],
    buf: Vec<u8>,
}

impl Blocks {
    fn run(&mut self, b: &[u8]) -> [u8; 16] {
        let mut x = block(b);
        if self.enc {
            if self.cbc {
                xor16(&mut x, &self.iv);
            }
            self.aes.encrypt(&mut x);
            self.iv = x;
        } else {
            self.aes.decrypt(&mut x);
            if self.cbc {
                xor16(&mut x, &self.iv);
                self.iv = block(b);
            }
        }
        x
    }

    fn update(&mut self, data: &[u8]) -> Vec<u8> {
        self.buf.extend_from_slice(data);
        let n = self.buf.len() / 16 * 16;
        // Decrypting with padding, the last full block may be the padding: it waits for `final`.
        let take = if !self.enc && self.pad && n == self.buf.len() { n.saturating_sub(16) } else { n };
        let input: Vec<u8> = self.buf.drain(..take).collect();
        let mut out = Vec::with_capacity(take);
        for c in input.chunks(16) {
            out.extend_from_slice(&self.run(c));
        }
        out
    }

    fn finish(&mut self) -> Result<Vec<u8>> {
        if self.enc {
            if !self.pad {
                if !self.buf.is_empty() {
                    return cipher_error("ERR_OSSL_DATA_NOT_MULTIPLE_OF_BLOCK_LENGTH", "1e00006a", "DATA_NOT_MULTIPLE_OF_BLOCK_LENGTH");
                }
                return Ok(Vec::new());
            }
            let n = 16 - self.buf.len();
            let mut last = core::mem::take(&mut self.buf);
            last.resize(16, n as u8);
            return Ok(self.run(&last).to_vec());
        }
        if !self.pad {
            if !self.buf.is_empty() {
                return cipher_error("ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH", "1e00007b", "WRONG_FINAL_BLOCK_LENGTH");
            }
            return Ok(Vec::new());
        }
        if self.buf.len() != 16 {
            return cipher_error("ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH", "1e00007b", "WRONG_FINAL_BLOCK_LENGTH");
        }
        let last = core::mem::take(&mut self.buf);
        let plain = self.run(&last);
        let n = plain[15] as usize;
        if n == 0 || n > 16 || plain[16 - n..].iter().any(|&b| b as usize != n) {
            return bad_decrypt();
        }
        Ok(plain[..16 - n].to_vec())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum StreamKind {
    Ctr,
    Cfb,
    Ofb,
}

/// CTR, CFB (128-bit segments) and OFB: a keystream XORed in, `pos` bytes into the current block.
struct Stream {
    aes: Aes,
    kind: StreamKind,
    enc: bool,
    reg: [u8; 16],
    ks: [u8; 16],
    pos: usize,
}

fn inc_be(c: &mut [u8; 16]) {
    for b in c.iter_mut().rev() {
        *b = b.wrapping_add(1);
        if *b != 0 {
            break;
        }
    }
}

impl Stream {
    fn update(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        for &b in data {
            if self.pos == 16 {
                let mut k = self.reg;
                self.aes.encrypt(&mut k);
                self.ks = k;
                match self.kind {
                    StreamKind::Ctr => inc_be(&mut self.reg),
                    StreamKind::Ofb => self.reg = k,
                    StreamKind::Cfb => {}
                }
                self.pos = 0;
            }
            let o = b ^ self.ks[self.pos];
            if self.kind == StreamKind::Cfb {
                self.reg[self.pos] = if self.enc { o } else { b };
            }
            self.pos += 1;
            out.push(o);
        }
        out
    }
}

/// A UniversalHash fed a byte stream: whole blocks as they complete, zero padding where a part ends.
struct Mac<U: UniversalHash> {
    u: U,
    buf: Vec<u8>,
}

impl<U: UniversalHash> Mac<U> {
    fn new(u: U) -> Self {
        Mac { u, buf: Vec::new() }
    }

    fn feed(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
        let n = self.buf.len() / 16 * 16;
        let full: Vec<u8> = self.buf.drain(..n).collect();
        self.u.update_padded(&full);
    }

    /// Ends a part (the AAD, the ciphertext): the tail is zero padded to a block.
    fn pad(&mut self) {
        let tail = core::mem::take(&mut self.buf);
        self.u.update_padded(&tail);
    }

    fn lengths(&mut self, a: u64, b: u64, big_endian: bool) {
        let mut l = [0u8; 16];
        if big_endian {
            l[..8].copy_from_slice(&a.to_be_bytes());
            l[8..].copy_from_slice(&b.to_be_bytes());
        } else {
            l[..8].copy_from_slice(&a.to_le_bytes());
            l[8..].copy_from_slice(&b.to_le_bytes());
        }
        self.u.update_padded(&l);
    }

    fn finish(self) -> Vec<u8> {
        self.u.finalize().as_slice().to_vec()
    }
}

struct Gcm {
    aes: Aes,
    enc: bool,
    ek_j0: [u8; 16],
    ctr: [u8; 16],
    ks: [u8; 16],
    pos: usize,
    mac: Mac<GHash>,
    aad_len: u64,
    ct_len: u64,
    started: bool,
}

fn inc32(c: &mut [u8; 16]) {
    let n = u32::from_be_bytes([c[12], c[13], c[14], c[15]]).wrapping_add(1);
    c[12..].copy_from_slice(&n.to_be_bytes());
}

impl Gcm {
    fn new(aes: Aes, iv: &[u8], enc: bool) -> Gcm {
        let mut h = [0u8; 16];
        aes.encrypt(&mut h);
        let key = GenericArray::from_slice(&h);
        let mut j0 = [0u8; 16];
        if iv.len() == 12 {
            j0[..12].copy_from_slice(iv);
            j0[15] = 1;
        } else {
            let mut g = Mac::new(GHash::new(key));
            g.feed(iv);
            g.pad();
            g.lengths(0, iv.len() as u64 * 8, true);
            j0.copy_from_slice(&g.finish());
        }
        let mut ek_j0 = j0;
        aes.encrypt(&mut ek_j0);
        let mut ctr = j0;
        inc32(&mut ctr);
        Gcm { aes, enc, ek_j0, ctr, ks: [0; 16], pos: 16, mac: Mac::new(GHash::new(key)), aad_len: 0, ct_len: 0, started: false }
    }

    fn start(&mut self) {
        if !self.started {
            self.mac.pad();
            self.started = true;
        }
    }

    fn update(&mut self, data: &[u8]) -> Vec<u8> {
        self.start();
        let mut out = Vec::with_capacity(data.len());
        for &b in data {
            if self.pos == 16 {
                let mut k = self.ctr;
                self.aes.encrypt(&mut k);
                self.ks = k;
                inc32(&mut self.ctr);
                self.pos = 0;
            }
            out.push(b ^ self.ks[self.pos]);
            self.pos += 1;
        }
        self.mac.feed(if self.enc { &out } else { data });
        self.ct_len += data.len() as u64;
        out
    }

    fn tag(mut self) -> Vec<u8> {
        self.start();
        self.mac.pad();
        self.mac.lengths(self.aad_len * 8, self.ct_len * 8, true);
        let mut t = self.mac.finish();
        for i in 0..16 {
            t[i] ^= self.ek_j0[i];
        }
        t
    }
}

struct Chacha {
    c: ChaCha20,
    enc: bool,
    mac: Mac<Poly1305>,
    aad_len: u64,
    ct_len: u64,
    started: bool,
}

impl Chacha {
    fn new(key: &[u8], iv: &[u8], enc: bool) -> Chacha {
        let mut c = ChaCha20::new(GenericArray::from_slice(key), GenericArray::from_slice(iv));
        let mut first = [0u8; 64];
        c.apply_keystream(&mut first);
        let mac = Mac::new(Poly1305::new(GenericArray::from_slice(&first[..32])));
        Chacha { c, enc, mac, aad_len: 0, ct_len: 0, started: false }
    }

    fn start(&mut self) {
        if !self.started {
            self.mac.pad();
            self.started = true;
        }
    }

    fn update(&mut self, data: &[u8]) -> Vec<u8> {
        self.start();
        let mut out = data.to_vec();
        self.c.apply_keystream(&mut out);
        self.mac.feed(if self.enc { &out } else { data });
        self.ct_len += data.len() as u64;
        out
    }

    fn tag(mut self) -> Vec<u8> {
        self.start();
        self.mac.pad();
        self.mac.lengths(self.aad_len, self.ct_len, false);
        self.mac.finish()
    }
}

enum Kind {
    Blocks(Blocks),
    Stream(Stream),
    Gcm(Box<Gcm>),
    Chacha(Box<Chacha>),
}

struct Cipher {
    kind: Option<Kind>,
    enc: bool,
    tag_len: usize,
    tag_in: Option<Vec<u8>>,
}

thread_local! {
    static CIPHERS: RefCell<Vec<Option<Cipher>>> = const { RefCell::new(Vec::new()) };
}

fn bad_key<T>() -> Result<T> {
    err("ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length")
}

fn bad_iv<T>() -> Result<T> {
    err("ERR_CRYPTO_INVALID_IV", "Invalid initialization vector")
}

fn create(mode: &str, key: &[u8], iv: &[u8], enc: bool, tag_len: usize) -> Result<Cipher> {
    if mode == "chacha20-poly1305" {
        if key.len() != 32 {
            return bad_key();
        }
        if iv.len() != 12 {
            return bad_iv();
        }
        let tag_len = if tag_len == 0 { 16 } else { tag_len };
        return Ok(Cipher { kind: Some(Kind::Chacha(Box::new(Chacha::new(key, iv, enc)))), enc, tag_len, tag_in: None });
    }
    // aes-<bits>-<mode>; "aes128" is aes-128-cbc
    let mut parts = mode.split('-');
    let (bits, m) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("aes"), Some(b), Some(m), None) => (b, m),
        (Some(a), None, None, None) if a.starts_with("aes") => (&a[3..], "cbc"),
        _ => return err("ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher"),
    };
    let want = match bits {
        "128" => 16,
        "192" => 24,
        "256" => 32,
        _ => return err("ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher"),
    };
    let ivlen = match m {
        "ecb" => 0,
        "gcm" => iv.len().max(1),
        "cbc" | "ctr" | "cfb" | "ofb" => 16,
        _ => return err("ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher"),
    };
    if key.len() != want {
        return bad_key();
    }
    if iv.len() != ivlen || (m == "gcm" && iv.is_empty()) {
        return bad_iv();
    }
    let aes = Aes::new(key).unwrap();
    let kind = match m {
        "ecb" | "cbc" => Kind::Blocks(Blocks { aes, cbc: m == "cbc", enc, pad: true, iv: if m == "cbc" { block(iv) } else { [0; 16] }, buf: Vec::new() }),
        "gcm" => Kind::Gcm(Box::new(Gcm::new(aes, iv, enc))),
        _ => {
            let kind = match m {
                "ctr" => StreamKind::Ctr,
                "cfb" => StreamKind::Cfb,
                _ => StreamKind::Ofb,
            };
            Kind::Stream(Stream { aes, kind, enc, reg: block(iv), ks: [0; 16], pos: 16 })
        }
    };
    Ok(Cipher { kind: Some(kind), enc, tag_len: if tag_len == 0 { 16 } else { tag_len }, tag_in: None })
}

fn handle(a: &Args) -> usize {
    let h = a.get(0);
    let mut b = [0u8; 4];
    b[..h.len().min(4)].copy_from_slice(&h[..h.len().min(4)]);
    u32::from_le_bytes(b) as usize
}

fn with<T>(a: &Args, f: impl FnOnce(&mut Cipher) -> Result<T>) -> Result<T> {
    CIPHERS.with(|c| match c.borrow_mut().get_mut(handle(a)).and_then(|c| c.as_mut()) {
        Some(c) => f(c),
        None => err("ERR_CRYPTO_INVALID_STATE", "Invalid state"),
    })
}

pub fn call(op: u32, a: &Args) -> Result<Out> {
    let mut out = Out::default();
    match op {
        1 => {
            let c = create(a.str(0), a.get(1), a.get(2), a.byte(3) != 0, a.byte(4) as usize)?;
            let h = CIPHERS.with(|t| {
                let mut t = t.borrow_mut();
                match t.iter().position(|s| s.is_none()) {
                    Some(i) => {
                        t[i] = Some(c);
                        i
                    }
                    None => {
                        t.push(Some(c));
                        t.len() - 1
                    }
                }
            });
            out.put(&(h as u32).to_le_bytes());
        }
        2 => {
            let data = a.get(1);
            let o = with(a, |c| {
                Ok(match c.kind.as_mut() {
                    Some(Kind::Blocks(b)) => b.update(data),
                    Some(Kind::Stream(s)) => s.update(data),
                    Some(Kind::Gcm(g)) => g.update(data),
                    Some(Kind::Chacha(k)) => k.update(data),
                    None => return err("ERR_CRYPTO_INVALID_STATE", "Invalid state"),
                })
            })?;
            out.put(&o);
        }
        3 => {
            let (o, tag) = with(a, |c| {
                let kind = c.kind.take().ok_or(()).or_else(|_| err("ERR_CRYPTO_INVALID_STATE", "Invalid state"))?;
                let (o, tag) = match kind {
                    Kind::Blocks(mut b) => (b.finish()?, Vec::new()),
                    Kind::Stream(_) => (Vec::new(), Vec::new()),
                    Kind::Gcm(g) => (Vec::new(), g.tag()),
                    Kind::Chacha(k) => (Vec::new(), k.tag()),
                };
                if c.enc || tag.is_empty() {
                    return Ok((o, tag[..tag.len().min(c.tag_len)].to_vec()));
                }
                // Decrypting: the tag set must match, compared in constant time over its length.
                let given = match c.tag_in.as_deref() {
                    Some(t) => t,
                    None => return auth_failed(),
                };
                let diff = given.iter().zip(tag.iter()).fold(0u8, |d, (x, y)| d | (x ^ y));
                if given.is_empty() || given.len() > tag.len() || diff != 0 {
                    return auth_failed();
                }
                Ok((o, Vec::new()))
            })?;
            out.put(&o).put(&tag);
        }
        4 => {
            let data = a.get(1);
            with(a, |c| match c.kind.as_mut() {
                Some(Kind::Gcm(g)) if !g.started => {
                    g.mac.feed(data);
                    g.aad_len += data.len() as u64;
                    Ok(())
                }
                Some(Kind::Chacha(k)) if !k.started => {
                    k.mac.feed(data);
                    k.aad_len += data.len() as u64;
                    Ok(())
                }
                _ => err("ERR_CRYPTO_UNSUPPORTED_STATE", "Unsupported state"),
            })?;
        }
        5 => {
            let tag = a.get(1);
            with(a, |c| {
                if c.enc || !matches!(c.kind, Some(Kind::Gcm(_)) | Some(Kind::Chacha(_))) {
                    return err("ERR_CRYPTO_UNSUPPORTED_STATE", "Unsupported state");
                }
                c.tag_in = Some(tag.to_vec());
                Ok(())
            })?;
        }
        6 => {
            let on = a.byte(1) != 0;
            with(a, |c| match c.kind.as_mut() {
                Some(Kind::Blocks(b)) => {
                    b.pad = on;
                    Ok(())
                }
                // The other modes have no padding: Node returns false and ignores it.
                _ => err("ERR_CRYPTO_UNSUPPORTED_STATE", "no padding"),
            })?;
        }
        7 => CIPHERS.with(|t| {
            if let Some(s) = t.borrow_mut().get_mut(handle(a)) {
                *s = None;
            }
        }),
        _ => return err("ERR_INTERNAL", "unknown op"),
    }
    Ok(out)
}
