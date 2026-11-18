//! `Bun.build` plugins: the `JSBundlerPlugin__wasm*` hooks bun's bundler calls on wasm (bun patch
//! `bundler: plugin hooks over byte slices, inline on wasm`), answered by the host through `bun_plugin.*`
//! imports (apps/playground/src/worker/buildPlugins.ts). See NOTES.md for the design.
//!
//! The host matches the filters (`any_matches`, synchronous) and runs the `onResolve` / `onLoad`
//! chains (`resolve` / `load`). Those two may suspend the module (JSPI: the host wraps them in
//! `WebAssembly.Suspending` and `bundle_c` in `WebAssembly.promising`) while an async hook runs.
//! They return the answer's length; `take` then copies it into memory allocated here.
//!
//! Answer layout: byte 0 is 0 (no match), 1 (an answer) or 2 (the hook threw; the rest is the message).
//! `resolve`'s answer: byte 1 `external`, a u32 (LE) path length, the path, then the namespace.
//! `load`'s answer: byte 1 the loader (`bun_ast::Loader`'s discriminant), then the contents.

use bun_bundler::bundle_v2::api::JSBundler::{Load, LoadSuccess, LoadValue, Plugin, Resolve, ResolveSuccess, ResolveValue};

#[link(wasm_import_module = "bun_plugin")]
unsafe extern "C" {
    #[link_name = "any_matches"]
    fn host_any_matches(on_load: u32, namespace: *const u8, namespace_len: usize, path: *const u8, path_len: usize) -> u32;
    #[link_name = "resolve"]
    fn host_resolve(
        namespace: *const u8,
        namespace_len: usize,
        path: *const u8,
        path_len: usize,
        importer: *const u8,
        importer_len: usize,
        kind: *const u8,
        kind_len: usize,
    ) -> usize;
    #[link_name = "load"]
    fn host_load(namespace: *const u8, namespace_len: usize, path: *const u8, path_len: usize, default_loader: u32, server_side: u32) -> usize;
    #[link_name = "take"]
    fn host_take(dst: *mut u8);
}

/// The plugin handle the bundler carries: the hooks ignore it (the host holds the plugins).
static HANDLE: u8 = 0;

/// Turns the bundler's plugin calls on for the next bundle (or off).
pub fn enable(on: bool) {
    let p = if on { (&raw const HANDLE).cast::<Plugin>().cast_mut() } else { core::ptr::null_mut() };
    bun_bundler::bundle_v2::WASM_PLUGINS.store(p, core::sync::atomic::Ordering::Relaxed);
}

fn take(len: usize) -> Vec<u8> {
    let mut v = vec![0u8; len];
    if len != 0 {
        // SAFETY: `v` has room for the `len` bytes the host announced.
        unsafe { host_take(v.as_mut_ptr()) };
    }
    v
}

/// A hook threw: the message, at the file (importer or path), as Bun's `msg_from_js` builds it.
fn error(file: &[u8], text: &[u8]) -> bun_ast::Msg {
    bun_ast::Msg {
        data: bun_ast::Data {
            text: std::borrow::Cow::Owned(text.to_vec()),
            location: Some(bun_ast::Location { file: Box::from(file), line: 0, column: 0, ..Default::default() }),
        },
        ..Default::default()
    }
}

/// # Safety
/// The slices are valid for the call (bun's bundler passes live slices).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn JSBundlerPlugin__wasmAnyMatches(
    _this: &Plugin,
    namespace: *const u8,
    namespace_len: usize,
    path: *const u8,
    path_len: usize,
    is_on_load: bool,
) -> bool {
    unsafe { host_any_matches(is_on_load as u32, namespace, namespace_len, path, path_len) != 0 }
}

/// # Safety
/// As `JSBundlerPlugin__wasmAnyMatches`; `context` is the live `*mut Resolve` the request belongs to.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn JSBundlerPlugin__wasmMatchOnResolve(
    _this: &mut Plugin,
    namespace: *const u8,
    namespace_len: usize,
    path: *const u8,
    path_len: usize,
    importer: *const u8,
    importer_len: usize,
    context: *mut core::ffi::c_void,
    kind: *const u8,
    kind_len: usize,
) {
    let len = unsafe { host_resolve(namespace, namespace_len, path, path_len, importer, importer_len, kind, kind_len) };
    let answer = take(len);
    // SAFETY: the bundler hands over its request; this is its one answer.
    let resolve = unsafe { &mut *context.cast::<Resolve>() };
    resolve.value = match answer.first() {
        Some(1) if answer.len() >= 6 => {
            let n = u32::from_le_bytes(answer[2..6].try_into().unwrap()) as usize;
            ResolveValue::Success(ResolveSuccess {
                external: answer[1] != 0,
                path: Box::from(&answer[6..6 + n]),
                namespace: Box::from(&answer[6 + n..]),
            })
        }
        Some(2) => ResolveValue::Err(error(&resolve.import_record.source_file, &answer[1..])),
        _ => ResolveValue::NoMatch,
    };
    // SAFETY: `bv2` outlives every request of its pass.
    unsafe { &mut *resolve.bv2 }.on_resolve_async(resolve);
}

/// # Safety
/// As `JSBundlerPlugin__wasmAnyMatches`; `context` is the live `*mut Load` the request belongs to.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn JSBundlerPlugin__wasmMatchOnLoad(
    _this: &mut Plugin,
    namespace: *const u8,
    namespace_len: usize,
    path: *const u8,
    path_len: usize,
    context: *mut core::ffi::c_void,
    default_loader: u8,
    is_server_side: bool,
) {
    let len = unsafe { host_load(namespace, namespace_len, path, path_len, default_loader as u32, is_server_side as u32) };
    let answer = take(len);
    // SAFETY: as `JSBundlerPlugin__wasmMatchOnResolve`.
    let load = unsafe { &mut *context.cast::<Load>() };
    load.value = match answer.first() {
        Some(1) if answer.len() >= 2 => match loader(answer[1]) {
            Some(loader) => LoadValue::Success(LoadSuccess { loader, source_code: Box::from(&answer[2..]) }),
            None => LoadValue::Err(error(&load.path, format!("Loader {} is not supported.", answer[1]).as_bytes())),
        },
        Some(2) => LoadValue::Err(error(&load.path, &answer[1..])),
        _ => LoadValue::NoMatch,
    };
    // SAFETY: as `JSBundlerPlugin__wasmMatchOnResolve`.
    unsafe { &mut *load.bv2 }.on_load_async(load);
}

fn loader(id: u8) -> Option<bun_ast::Loader> {
    use bun_ast::Loader::*;
    Some(match id {
        0 => Jsx,
        1 => Js,
        2 => Ts,
        3 => Tsx,
        4 => Css,
        5 => File,
        6 => Json,
        7 => Jsonc,
        8 => Toml,
        9 => Wasm,
        10 => Napi,
        11 => Base64,
        12 => Dataurl,
        13 => Text,
        14 => Bunsh,
        15 => Sqlite,
        16 => SqliteEmbedded,
        17 => Html,
        18 => Yaml,
        19 => Json5,
        20 => Md,
        21 => Xml,
        _ => return None,
    })
}

// `.defer()` is refused by the host (one request runs at a time), so there is never a batch to drain.
#[unsafe(no_mangle)]
pub extern "C" fn JSBundlerPlugin__drainDeferred(_this: &mut Plugin, _rejected: bool) {}

// No native (`onBeforeParse`) plugins in the browser.
#[unsafe(no_mangle)]
pub extern "C" fn JSBundlerPlugin__hasOnBeforeParsePlugins(_this: &Plugin) -> i32 {
    0
}

// Only bake freezes filters; the host's are fixed once `setup` has run.
#[unsafe(no_mangle)]
pub extern "C" fn JSBundlerPlugin__freezeFilters(_this: &Plugin) {}
