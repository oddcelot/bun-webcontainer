//! Zstandard and Brotli behind a pointer+length C ABI for wasm64 (Bun.zstd*, node:zlib's brotli and zstd).
//!
//! The host writes the input into a buffer from `alloc`, calls an export, reads the result through `out_ptr` and
//! `out_len`, then calls `out_free` (and `dealloc` for the input). One result is alive at a time. Both codecs are
//! pure Rust: structured-zstd (zstd) and the `brotli` crate (Dropbox's port of Google's encoder and decoder).

use std::alloc::{Layout, alloc as std_alloc, dealloc as std_dealloc};
use std::cell::RefCell;
use std::io::Read;

use brotli::enc::BrotliEncoderParams;
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState, HeapAlloc, HuffmanCode};
use structured_zstd::decoding::StreamingDecoder;
use structured_zstd::encoding::{CompressionLevel, compress_slice_to_vec};

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_out(v: Vec<u8>) {
    OUT.with(|o| *o.borrow_mut() = v);
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::NonNull::dangling().as_ptr();
    }
    unsafe { std_alloc(Layout::from_size_align_unchecked(len, 1)) }
}

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len != 0 {
        unsafe { std_dealloc(ptr, Layout::from_size_align_unchecked(len, 1)) }
    }
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { core::slice::from_raw_parts(ptr, len) } }
}

#[unsafe(no_mangle)]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

#[unsafe(no_mangle)]
pub extern "C" fn out_free() {
    set_out(Vec::new());
}

// ---- zstd ----

/// Compresses at `level` (1..=22, or negative for the fast levels). Always 0; the output is in `out_ptr`.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zstd_compress(src: *const u8, len: usize, level: i32) -> i32 {
    let input = unsafe { bytes(src, len) };
    set_out(compress_slice_to_vec(input, CompressionLevel::from_level(level)));
    0
}

pub const ZSTD_OK: i32 = 0;
/// Not a zstd frame: bad magic number or header.
pub const ZSTD_BAD_FRAME: i32 = 1;
/// Corrupt block data.
pub const ZSTD_CORRUPT: i32 = 2;
/// The input ends inside a frame.
pub const ZSTD_TRUNCATED: i32 = 3;
/// The frame's content checksum does not match.
pub const ZSTD_BAD_CHECKSUM: i32 = 4;
/// A frame needs a dictionary, or a window larger than the decoder allows.
pub const ZSTD_UNSUPPORTED: i32 = 5;

/// Decompresses every frame in the input (skippable frames are skipped, like libzstd).
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zstd_decompress(src: *const u8, len: usize) -> i32 {
    let mut input = unsafe { bytes(src, len) };
    let mut out = Vec::new();
    while !input.is_empty() {
        // A skippable frame: magic 0x184D2A5? (4), payload size (4), payload.
        if input.len() >= 4 && u32::from_le_bytes([input[0], input[1], input[2], input[3]]) & 0xFFFF_FFF0 == 0x184D_2A50 {
            if input.len() < 8 {
                return ZSTD_TRUNCATED;
            }
            let skip = 8 + u32::from_le_bytes([input[4], input[5], input[6], input[7]]) as usize;
            if input.len() < skip {
                return ZSTD_TRUNCATED;
            }
            input = &input[skip..];
            continue;
        }
        let mut dec = StreamingDecoder::new(&mut input);
        let start = out.len();
        let res = dec.read_to_end(&mut out);
        drop(dec);
        if let Err(e) = res {
            out.truncate(start);
            return classify(&format!("{e:?}"), input.is_empty());
        }
    }
    set_out(out);
    ZSTD_OK
}

fn classify(msg: &str, exhausted: bool) -> i32 {
    if msg.contains("BadMagic") || msg.contains("MagicNumber") {
        ZSTD_BAD_FRAME
    } else if msg.contains("hecksum") {
        ZSTD_BAD_CHECKSUM
    } else if msg.contains("UnexpectedEof") || (exhausted && !msg.contains("Custom")) {
        ZSTD_TRUNCATED
    } else if msg.contains("DictionaryDecodeError") || msg.contains("DictionaryId") || msg.contains("WindowSizeTooBig") {
        ZSTD_UNSUPPORTED
    } else {
        ZSTD_CORRUPT
    }
}

// ---- brotli ----

/// `quality`, `lgwin`, `mode`, `size_hint`, `lgblock`, `disable_literal_context_modeling`, `large_window`: -1 leaves
/// the default. Returns 0, or 1 if the encoder failed.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn brotli_compress(
    src: *const u8,
    len: usize,
    quality: i32,
    lgwin: i32,
    mode: i32,
    size_hint: i32,
    lgblock: i32,
    disable_ctx: i32,
    large_window: i32,
) -> i32 {
    let mut input = unsafe { bytes(src, len) };
    let mut params = BrotliEncoderParams::default();
    if quality >= 0 {
        params.quality = quality;
    }
    if lgwin >= 0 {
        params.lgwin = lgwin;
    }
    params.mode = match mode {
        1 => brotli::enc::backward_references::BrotliEncoderMode::BROTLI_MODE_TEXT,
        2 => brotli::enc::backward_references::BrotliEncoderMode::BROTLI_MODE_FONT,
        _ => brotli::enc::backward_references::BrotliEncoderMode::BROTLI_MODE_GENERIC,
    };
    if size_hint >= 0 {
        params.size_hint = size_hint as usize;
    } else {
        params.size_hint = len;
    }
    if lgblock >= 0 {
        params.lgblock = lgblock;
    }
    if disable_ctx >= 0 {
        params.disable_literal_context_modeling = disable_ctx;
    }
    if large_window > 0 {
        params.large_window = true;
    }
    let mut out = Vec::with_capacity(len / 2 + 16);
    match brotli::BrotliCompress(&mut input, &mut out, &params) {
        Ok(_) => {
            set_out(out);
            0
        }
        Err(_) => 1,
    }
}

/// Returns 0 on success, 1000 if the input ends before the stream does, or the negative
/// `BrotliDecoderErrorCode` (-1 .. -31, -16 distance, ...) the decoder stopped with.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn brotli_decompress(src: *const u8, len: usize, large_window: i32) -> i32 {
    let input = unsafe { bytes(src, len) };
    let mut state = BrotliState::new(
        HeapAlloc::<u8>::new(0),
        HeapAlloc::<u32>::new(0),
        HeapAlloc::<HuffmanCode>::new(HuffmanCode::default()),
    );
    if large_window > 0 {
        state.large_window = true;
    }
    let mut out: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut avail_in, mut in_off, mut total_out) = (input.len(), 0usize, 0usize);
    loop {
        let (mut avail_out, mut out_off) = (buf.len(), 0usize);
        let r = BrotliDecompressStream(&mut avail_in, &mut in_off, input, &mut avail_out, &mut out_off, &mut buf, &mut total_out, &mut state);
        out.extend_from_slice(&buf[..out_off]);
        match r {
            BrotliResult::ResultSuccess => {
                set_out(out);
                return 0;
            }
            BrotliResult::NeedsMoreOutput => {}
            BrotliResult::NeedsMoreInput => return 1000,
            BrotliResult::ResultFailure => return state.error_code as i32,
        }
    }
}
