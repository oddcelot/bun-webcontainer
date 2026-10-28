//! Link-time symbols `bun_bundler` declares for pieces that don't exist in the browser:
//! JSC bytecode (`--bytecode`/`--compile`), the bake dev server, and the highway/xxhash kernels.
//! None of the bytecode or dev-server entry points are reachable from `bundle()`.

#![allow(non_snake_case)]

use bun_bundler::bundle_v2::BundleV2;
use bun_bundler::bake_types::Graph;

// ── bake dev server (DevServerHandle::Bake): only reachable with `dev_server` set ──

#[unsafe(no_mangle)]
pub fn __bun_dispatch__DevServerHandle__Bake__current_bundle_start_data(_owner: *mut ()) -> *mut () {
    unreachable!("no dev server in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_dispatch__DevServerHandle__Bake__handle_parse_task_failure(
    _owner: *mut (),
    _err: bun_bundler::Error,
    _graph: Graph,
    _abs_path: &[u8],
    _log: *const bun_ast::Log,
    _bv2: *mut BundleV2<'_>,
) -> Result<(), bun_bundler::Error> {
    unreachable!("no dev server in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_dispatch__DevServerHandle__Bake__asset_hash(_owner: *mut (), _abs_path: &[u8]) -> Option<u64> {
    unreachable!("no dev server in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_dispatch__DevServerHandle__Bake__finalize_bundle(
    _owner: *mut (),
    _bv2: *mut BundleV2<'_>,
    _result: *mut bun_bundler::bundle_v2::DevServerOutput<'_>,
) -> Result<(), bun_bundler::Error> {
    unreachable!("no dev server in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_dispatch__DevServerHandle__Bake__is_file_cached(
    _owner: *mut (),
    _abs_path: &[u8],
    _side: Graph,
) -> Option<bun_bundler::bake_types::CacheEntry> {
    unreachable!("no dev server in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_dispatch__DevServerHandle__Bake__log_for_resolution_failures(
    _owner: *mut (),
    _abs_path: &[u8],
    _graph: Graph,
) -> *mut bun_ast::Log {
    unreachable!("no dev server in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_dispatch__DevServerHandle__Bake__track_resolution_failure(
    _owner: *mut (),
    _import_source: &[u8],
    _specifier: &[u8],
    _renderer: Graph,
    _loader: bun_ast::Loader,
) -> Result<(), bun_bundler::Error> {
    unreachable!("no dev server in the browser bundler")
}

// ── bundler plugins / hot reloading / macros (JSC) ──

#[unsafe(no_mangle)]
pub extern "C" fn JSBundlerPlugin__freezeFilters(_plugin: *const ()) {
    unreachable!("no plugins in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_enable_hot_module_reloading_for_bundler(_bv2: NonNull<BundleV2<'static>>) {
    unreachable!("no --watch in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_macro_context_deinit(_data: *mut core::ffi::c_void) {}

// ── JSC bytecode: `--bytecode` / `--compile` only ──

// Opaque in bun_bundler (pub(crate)); the symbols only pass pointers to them.
pub enum EncoderStringTable {}
pub enum BytecodeLinkEncoder {}
use core::ptr::NonNull;

#[unsafe(no_mangle)]
pub fn __bun_jsc_generate_cached_bytecode(
    _format: bun_bundler::options_impl::Format,
    _source: &[u8],
    _url: &bun_core::String,
    _depth: u32,
    _optimize: bool,
    _external_strings: Option<NonNull<EncoderStringTable>>,
) -> Option<Box<[u8]>> {
    None
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_host_builtins() -> &'static [u8] {
    &[]
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_generate_internal_module_bytecode(
    _id: u32,
    _depth: u32,
    _external_strings: Option<NonNull<EncoderStringTable>>,
) -> Option<Box<[u8]>> {
    None
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_generate_internal_module_bytecode_from_source(
    _source: &[u8],
    _name: &[u8],
    _url: &[u8],
    _source_stamp: u32,
    _depth: u32,
    _external_strings: Option<NonNull<EncoderStringTable>>,
) -> Option<Box<[u8]>> {
    None
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_encoder_string_table_new() -> NonNull<EncoderStringTable> {
    unreachable!("bytecode is not supported in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_encoder_string_table_take(_table: NonNull<EncoderStringTable>, _hot: &[u64]) -> Box<[u8]> {
    unreachable!("bytecode is not supported in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_bytecode_link_encoder_destroy(_encoder: NonNull<BytecodeLinkEncoder>) {
    unreachable!("bytecode is not supported in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_bytecode_link_encoder_finish(
    _encoder: NonNull<BytecodeLinkEncoder>,
    _module_count: usize,
) -> Option<bun_bundler::bytecode_order::LinkedPayload> {
    unreachable!("bytecode is not supported in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_wtf_string_hash(_wtf8: &[u8]) -> u32 {
    unreachable!("bytecode is not supported in the browser bundler")
}

// ── highway kernels ──

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_index_of_newline_or_non_ascii(p: *const u8, len: usize) -> usize {
    // SAFETY: the caller passes a slice, as a pointer and a length.
    let s = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, len) } };
    s.iter().position(|&c| c == b'\r' || c == b'\n' || c > 0x7F).unwrap_or(len)
}

const P1: u64 = 0x9E3779B185EBCA87;
const P2: u64 = 0xC2B2AE3D27D4EB4F;
const P3: u64 = 0x165667B19E3779F9;
const P4: u64 = 0x85EBCA77C2B2AE63;
const P5: u64 = 0x27D4EB2F165667C5;

/// `XXH64_state_t` layout (80 bytes): total_len, v[4], mem[4] (32 bytes), memsize.
#[repr(C)]
struct Xxh64State {
    total_len: u64,
    v: [u64; 4],
    mem: [u8; 32],
    memsize: u64,
}

fn round(acc: u64, input: u64) -> u64 {
    acc.wrapping_add(input.wrapping_mul(P2)).rotate_left(31).wrapping_mul(P1)
}

fn merge(acc: u64, v: u64) -> u64 {
    (acc ^ round(0, v)).wrapping_mul(P1).wrapping_add(P4)
}

fn rd64(b: &[u8]) -> u64 {
    u64::from_le_bytes(b[..8].try_into().unwrap())
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_xxhash64_reset(state: *mut u8, seed: u64) {
    let s = unsafe { &mut *state.cast::<Xxh64State>() };
    s.total_len = 0;
    s.v = [seed.wrapping_add(P1).wrapping_add(P2), seed.wrapping_add(P2), seed, seed.wrapping_sub(P1)];
    s.mem = [0; 32];
    s.memsize = 0;
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_xxhash64_update(state: *mut u8, input: *const u8, len: usize) {
    let s = unsafe { &mut *state.cast::<Xxh64State>() };
    let mut p = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(input, len) } };
    s.total_len += len as u64;
    if s.memsize as usize + p.len() < 32 {
        s.mem[s.memsize as usize..s.memsize as usize + p.len()].copy_from_slice(p);
        s.memsize += p.len() as u64;
        return;
    }
    if s.memsize != 0 {
        let fill = 32 - s.memsize as usize;
        s.mem[s.memsize as usize..].copy_from_slice(&p[..fill]);
        for i in 0..4 {
            s.v[i] = round(s.v[i], rd64(&s.mem[i * 8..]));
        }
        p = &p[fill..];
        s.memsize = 0;
    }
    while p.len() >= 32 {
        for i in 0..4 {
            s.v[i] = round(s.v[i], rd64(&p[i * 8..]));
        }
        p = &p[32..];
    }
    s.mem[..p.len()].copy_from_slice(p);
    s.memsize = p.len() as u64;
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_xxhash64_digest(state: *const u8) -> u64 {
    let s = unsafe { &*state.cast::<Xxh64State>() };
    let mut h = if s.total_len >= 32 {
        let mut h = s.v[0].rotate_left(1)
            .wrapping_add(s.v[1].rotate_left(7))
            .wrapping_add(s.v[2].rotate_left(12))
            .wrapping_add(s.v[3].rotate_left(18));
        for v in s.v {
            h = merge(h, v);
        }
        h
    } else {
        s.v[2].wrapping_add(P5)
    };
    h = h.wrapping_add(s.total_len);
    let mut p = &s.mem[..s.memsize as usize];
    while p.len() >= 8 {
        h = (h ^ round(0, rd64(p))).rotate_left(27).wrapping_mul(P1).wrapping_add(P4);
        p = &p[8..];
    }
    if p.len() >= 4 {
        h = (h ^ (u32::from_le_bytes(p[..4].try_into().unwrap()) as u64).wrapping_mul(P1))
            .rotate_left(23).wrapping_mul(P2).wrapping_add(P3);
        p = &p[4..];
    }
    for &b in p {
        h = (h ^ (b as u64).wrapping_mul(P5)).rotate_left(11).wrapping_mul(P1);
    }
    h ^= h >> 33;
    h = h.wrapping_mul(P2);
    h ^= h >> 29;
    h = h.wrapping_mul(P3);
    h ^ (h >> 32)
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_bytecode_link_encoder_new(
    _external_strings: NonNull<EncoderStringTable>,
    _hot: &[u64],
    _known: &[u64],
    _evaluated: &[u64],
    _not_evaluated: &[u64],
) -> NonNull<BytecodeLinkEncoder> {
    unreachable!("bytecode is not supported in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_bytecode_link_encoder_add_module(
    _encoder: NonNull<BytecodeLinkEncoder>,
    _format: bun_bundler::options_impl::Format,
    _source: &[u8],
    _url: &bun_core::String,
    _depth: u32,
    _optimize: bool,
    _names: &bun_bundler::bytecode_order::CodeNamesRef<'_>,
) -> bool {
    unreachable!("bytecode is not supported in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_bytecode_link_encoder_add_internal_module(
    _encoder: NonNull<BytecodeLinkEncoder>,
    _id: u32,
    _depth: u32,
    _names: &bun_bundler::bytecode_order::CodeNamesRef<'_>,
) -> bool {
    unreachable!("bytecode is not supported in the browser bundler")
}

#[unsafe(no_mangle)]
pub fn __bun_jsc_bytecode_link_encoder_add_internal_module_from_source(
    _encoder: NonNull<BytecodeLinkEncoder>,
    _source: &[u8],
    _name: &[u8],
    _url: &[u8],
    _source_stamp: u32,
    _depth: u32,
    _names: &bun_bundler::bytecode_order::CodeNamesRef<'_>,
) -> bool {
    unreachable!("bytecode is not supported in the browser bundler")
}

// ── BoringSSL (TLS), uws, JS event loop, macros: linked in, never called ──

macro_rules! unreachable_c {
    ($($name:ident),* $(,)?) => {$(
        // The real signatures differ; wasm-ld only warns about the mismatch and the call is never made.
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() {
            unreachable!(concat!(stringify!($name), " is not available in the browser bundler"))
        }
    )*};
}

unreachable_c!(
    ASN1_STRING_to_UTF8, GENERAL_NAME_free, OPENSSL_free, SSL_SESSION_free, SSL_SESSION_up_ref,
    X509V3_EXT_d2i, X509V3_EXT_get, X509V3_EXT_get_nid, X509_NAME_ENTRY_get_data, X509_NAME_get_entry,
    X509_NAME_get_index_by_NID, X509_get_ext, X509_get_ext_by_NID, X509_get_subject_name, i2d_SSL_SESSION,
    sk_num, sk_pop_free_ex, sk_value,
    JSBundlerPlugin__anyMatches, JSBundlerPlugin__callOnBeforeParsePlugins, JSBundlerPlugin__hasOnBeforeParsePlugins,
    __bun_dispatch__DevServerHandle__Bake__barrel_needed_exports,
    __bun_dispatch__DevServerHandle__Bake__put_or_overwrite_asset,
    __bun_dispatch__DevServerHandle__Bake__register_barrel_export,
    __bun_dispatch__DevServerHandle__Bake__register_barrel_with_deferrals,
    __bun_dispatch__JsEventLoop__Jsc__auto_tick, __bun_dispatch__JsEventLoop__Jsc__js_poster,
    __bun_dispatch__JsEventLoop__Jsc__tick,
    __bun_jsc_encoder_string_table_slot,
    BunString__fromBytes, BunString__fromLatin1, BunString__fromUTF16, BunString__fromUTF16ToLatin1,
);

/// `MiniEventLoop::init` asks uws for the loop; nothing dereferences it on wasm.
#[unsafe(no_mangle)]
pub extern "C" fn uws_get_loop() -> *mut u8 {
    static mut DUMMY: [u64; 64] = [0; 64];
    core::ptr::addr_of_mut!(DUMMY).cast()
}

#[unsafe(no_mangle)]
pub extern "C" fn us_wakeup_loop(_loop: *mut u8) {}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_index_of_not_char(p: *const u8, len: usize, value: u8) -> usize {
    let s = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, len) } };
    s.iter().position(|&c| c != value).unwrap_or(len)
}

// ── base64 (simdutf) ──

const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

#[unsafe(no_mangle)]
unsafe extern "C" fn simdutf__base64_length_from_binary(len: usize, url: core::ffi::c_int) -> usize {
    if url != 0 { (len * 4).div_ceil(3) } else { len.div_ceil(3) * 4 }
}

#[repr(C)]
pub struct SimdutfResult {
    status: i32,
    count: usize,
}

#[unsafe(no_mangle)]
unsafe extern "C" fn simdutf__base64_decode_from_binary(
    p: *const u8, len: usize, out: *mut u8, outlen: usize, url: core::ffi::c_int,
) -> SimdutfResult {
    let input = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, len) } };
    let table = if url != 0 { URL } else { STD };
    let mut o = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    let mut chars = input.iter().take_while(|&&c| c != b'=');
    for (i, &c) in chars.by_ref().enumerate() {
        let Some(v) = table.iter().position(|&t| t == c) else {
            return SimdutfResult { status: 7, count: i };
        };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            o.push((acc >> bits) as u8);
        }
    }
    if o.len() > outlen {
        return SimdutfResult { status: 10, count: 0 };
    }
    unsafe { core::ptr::copy_nonoverlapping(o.as_ptr(), out, o.len()) };
    SimdutfResult { status: 0, count: o.len() }
}

// ── macros: off (`no_macros`), so the context is the inert default and there's no VM to collect ──

#[unsafe(no_mangle)]
pub fn __bun_macro_context_init(_transpiler: *mut core::ffi::c_void) -> bun_js_parser::Macro::MacroContext {
    Default::default()
}

#[unsafe(no_mangle)]
pub fn __bun_macro_collect_vm_garbage() {}
