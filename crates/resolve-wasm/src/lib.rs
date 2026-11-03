//! Bun's module resolver (`bun_resolver`) behind a pointer+length C ABI, reading the file system
//! through `bun_sys` (host imports `bun_sys.*`, served by packages/vfs/sysHost.ts).
//!
//! Host flow: `alloc` input buffers, write UTF-8, call `resolve_c`, read the `Output`, then
//! `output_free` it and `dealloc` the inputs. Directory/package.json/tsconfig lookups are cached
//! process-wide (as in Bun); call `resolve_reset_c` after the VFS changed.
//!
//! It also carries `Bun.Glob` (`bun_glob`, which walks the same `bun_sys` host): `glob_match_c` and `glob_scan_c`;
//! Bun's YAML and TOML parsers (`data_parse_c`); and `Bun.password`'s argon2 and bcrypt (`password_hash_c`, `password_verify_c`).

// The C/C++ stand-ins the parser and printer link against.
use bun_wasm_stubs as _;
// The bun_sys_host_* symbols bun_sys declares, as `bun_sys.*` wasm imports served by the VFS.
use bun_sys_host as _;
mod stubs;

use bun_ast::ImportKind;
use bun_resolver::fs::FileSystem;
use bun_resolver::options::{self, BundleOptions, Conditions, ExtensionOrder, ExtensionOrderGroup, Packages};
use bun_resolver::{Resolver, package_json::ConditionsMap};
use core::ptr::NonNull;

fn list(s: &[&[u8]]) -> Box<[Box<[u8]>]> {
    options::owned_string_list(s)
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Target {
    Browser = 0,
    Bun = 1,
    Node = 2,
}

const MAIN_FIELDS_BROWSER: &[&[u8]] = &[b"browser", b"module", b"jsnext:main", b"main"];
const MAIN_FIELDS_BUN: &[&[u8]] = &[b"module", b"main", b"jsnext:main"];
const MAIN_FIELDS_NODE: &[&[u8]] = &[b"main", b"module"];

/// Mirrors `bundler::options::BundleOptions::from_api` defaults for the resolver-relevant fields.
fn make_options(target: Target, extra_conditions: &[&[u8]]) -> BundleOptions {
    let (bt, defaults, main_fields): (_, &[&[u8]], _) = match target {
        Target::Browser => (bun_ast::Target::Browser, &[b"browser", b"module"], MAIN_FIELDS_BROWSER),
        Target::Bun => (bun_ast::Target::Bun, &[b"bun", b"node"], MAIN_FIELDS_BUN),
        Target::Node => (bun_ast::Target::Node, &[b"node"], MAIN_FIELDS_NODE),
    };
    // 1. defaults, 2. node-addons, 3. user conditions (as `ESMConditions::init`)
    let mut import = ConditionsMap::default();
    let mut require = ConditionsMap::default();
    let mut style = ConditionsMap::default();
    import.insert(b"import".as_slice(), ());
    require.insert(b"require".as_slice(), ());
    style.insert(b"style".as_slice(), ());
    for c in extra_conditions {
        import.insert(*c, ());
        require.insert(*c, ());
    }
    for c in defaults.iter().copied().chain([b"node-addons".as_slice()]) {
        import.insert(c, ());
        require.insert(c, ());
        if c != b"node-addons" {
            style.insert(c, ());
        }
    }
    for m in [&mut import, &mut require, &mut style] {
        m.insert(b"default".as_slice(), ());
    }
    BundleOptions {
        target: bt,
        packages: Packages::Bundle,
        jsx: Default::default(),
        extension_order: ExtensionOrder {
            default: ExtensionOrderGroup {
                default: list(&[b".tsx", b".ts", b".jsx", b".cts", b".cjs", b".js", b".mjs", b".mts", b".json"]),
                esm: list(&[b".tsx", b".jsx", b".mts", b".ts", b".mjs", b".js", b".cts", b".cjs", b".json"]),
            },
            node_modules: ExtensionOrderGroup {
                default: list(&[b".jsx", b".cjs", b".js", b".mjs", b".mts", b".tsx", b".ts", b".cts", b".json"]),
                esm: list(&[b".mjs", b".jsx", b".mts", b".js", b".cjs", b".tsx", b".ts", b".cts", b".json"]),
            },
            required_by_package: Box::default(),
            css: list(&[b".css"]),
        },
        conditions: Conditions { import, require, style },
        external: Default::default(),
        extra_cjs_extensions: Box::default(),
        framework: None,
        global_cache: Default::default(),
        install: None,
        load_package_json: true,
        load_tsconfig_json: true,
        main_field_extension_order: list(&[b".js", b".cjs", b".cts", b".tsx", b".ts", b".jsx", b".json"]),
        main_fields: list(main_fields),
        main_fields_is_default: true,
        mark_builtins_as_external: false,
        polyfill_node_globals: false,
        install_preference: Default::default(),
        preserve_symlinks: false,
        rewrite_jest_for_tests: false,
        tsconfig_override: None,
        tsconfig_override_json: None,
        production: false,
        force_node_env: Default::default(),
        output_dir: Box::default(),
        root_dir: Box::default(),
        public_path: Box::default(),
        compile: false,
        supports_multiple_outputs: false,
        tree_shaking: false,
        allow_runtime: false,
    }
}

fn import_kind(kind: u32) -> ImportKind {
    match kind {
        0 => ImportKind::EntryPointRun,
        1 => ImportKind::EntryPointBuild,
        3 => ImportKind::Require,
        4 => ImportKind::Dynamic,
        5 => ImportKind::RequireResolve,
        6 => ImportKind::At,
        8 => ImportKind::Url,
        _ => ImportKind::Stmt,
    }
}

/// Resolves `specifier` as imported from a file in `source_dir` (absolute). Ok = absolute path
/// (or `namespace:path` for non-file results); Err = error text.
pub fn resolve(
    specifier: &[u8],
    source_dir: &[u8],
    kind: ImportKind,
    target: Target,
    conditions: &[&[u8]],
) -> Result<Vec<u8>, Vec<u8>> {
    install_panic_hook();
    let fs = FileSystem::init(Some(b"/")).map_err(|e| format!("fs init: {e:?}").into_bytes())?;
    let mut log = Box::new(bun_ast::Log::init());
    let log_ptr = NonNull::from(&mut *log);
    let mut resolver = Resolver::init1(log_ptr, fs, make_options(target, conditions));
    let out = match resolver.resolve(source_dir, specifier, kind) {
        Ok(r) => Ok(r.path_const().map_or_else(Vec::new, |p| p.text.to_vec())),
        Err(e) => {
            let mut msg = format!(
                "{}: {} from {}",
                e.name(),
                String::from_utf8_lossy(specifier),
                String::from_utf8_lossy(source_dir)
            );
            for m in &log.msgs {
                msg.push_str("\n");
                msg.push_str(&String::from_utf8_lossy(&m.data.text));
            }
            Err(msg.into_bytes())
        }
    };
    out
}

/// Forgets the cached listing and `package.json`/`tsconfig.json` of directory `path` (absolute), so
/// files added, removed or edited there are seen. Returns whether anything was cached. Call it for
/// each directory the VFS changed (a created file: its parent; a changed package.json: its dir).
pub fn invalidate(path: &[u8]) -> bool {
    install_panic_hook();
    let Ok(fs) = FileSystem::init(Some(b"/")) else { return false };
    let mut log = Box::new(bun_ast::Log::init());
    let mut resolver = Resolver::init1(NonNull::from(&mut *log), fs, make_options(Target::Browser, &[]));
    resolver.bust_dir_cache(path)
}

#[repr(C)]
pub struct Output {
    /// 0 = ok (`ptr` is the resolved path), 1 = error (`ptr` is the message).
    pub status: u64,
    pub ptr: *mut u8,
    pub len: usize,
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// `kind` is `bun_ast::ImportKind` (2 = import, 3 = require, 4 = dynamic import); `target` 0 =
/// browser, 1 = bun, 2 = node; `conds` is a comma-separated list of extra export conditions.
///
/// # Safety
/// All input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn resolve_c(
    spec: *const u8,
    spec_len: usize,
    dir: *const u8,
    dir_len: usize,
    kind: u32,
    target: u32,
    conds: *const u8,
    conds_len: usize,
) -> *mut Output {
    let slice = |p: *const u8, n: usize| if n == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, n) } };
    let target = match target {
        0 => Target::Browser,
        1 => Target::Bun,
        _ => Target::Node,
    };
    let conds: Vec<&[u8]> = slice(conds, conds_len).split(|b| *b == b',').filter(|c| !c.is_empty()).collect();
    let (status, bytes) = match resolve(slice(spec, spec_len), slice(dir, dir_len), import_kind(kind), target, &conds) {
        Ok(b) => (0, b),
        Err(b) => (1, b),
    };
    let mut bytes = bytes.into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
}

/// # Safety
/// `out` must come from `resolve_c`, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn output_free(out: *mut Output) {
    let out = unsafe { Box::from_raw(out) };
    if out.len != 0 {
        drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(out.ptr, out.len)) });
    }
}

// panic=abort with no stderr: keep the message so the host can read it after the trap.
static PANIC_MESSAGE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // package.json/tsconfig.json are parsed into the global AST stores (as `Transpiler::init` sets up).
        bun_ast::expr::data::Store::create();
        bun_ast::stmt::data::Store::create();
        std::panic::set_hook(Box::new(|info| {
            if let Ok(mut m) = PANIC_MESSAGE.lock() {
                *m = info.to_string();
            }
        }));
    });
}

/// The last panic's message (the module traps right after, so call this on a fresh instance's
/// exports or before the trap is observed by the host). Free with `output_free`.
#[unsafe(no_mangle)]
pub extern "C" fn panic_message_c() -> *mut Output {
    let mut bytes = PANIC_MESSAGE.lock().map(|m| m.clone().into_bytes()).unwrap_or_default().into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status: 1, ptr, len }))
}

/// # Safety
/// `path` must be readable for `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn invalidate_c(path: *const u8, len: usize) -> u32 {
    let path = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(path, len) } };
    invalidate(path) as u32
}

// ── Bun.Glob ──

/// `Glob#match`: as Bun's (`runtime/api/glob.rs`), dots are matched like any other character.
pub fn glob_match(pattern: &[u8], path: &[u8]) -> bool {
    bun_glob::matcher::match_on::<false>(pattern, path).matches()
}

/// `glob_scan` flags (`Glob#scan` options).
pub const GLOB_DOT: u32 = 1;
pub const GLOB_ABSOLUTE: u32 = 2;
pub const GLOB_ONLY_FILES: u32 = 4;
pub const GLOB_FOLLOW_SYMLINKS: u32 = 8;
pub const GLOB_ERROR_ON_BROKEN_SYMLINKS: u32 = 16;

/// `Glob#scanSync`: the paths `pattern` matches under `cwd` (absolute), relative to it unless `GLOB_ABSOLUTE`, in
/// walk order. Err = `code\0syscall\0path` of the failing syscall, or a message.
pub fn glob_scan(pattern: &[u8], cwd: &[u8], flags: u32) -> Result<Vec<Box<[u8]>>, Vec<u8>> {
    install_panic_hook();
    let mut walker = match bun_glob::BunGlobWalker::init_with_cwd(
        pattern,
        cwd,
        flags & GLOB_DOT != 0,
        flags & GLOB_ABSOLUTE != 0,
        flags & GLOB_FOLLOW_SYMLINKS != 0,
        flags & GLOB_ERROR_ON_BROKEN_SYMLINKS != 0,
        flags & GLOB_ONLY_FILES != 0,
        None,
    ) {
        Ok(Ok(w)) => w,
        Ok(Err(e)) => return Err(sys_error(&e)),
        Err(e) => return Err(format!("{e:?}").into_bytes()),
    };
    match walker.walk() {
        Ok(Ok(())) => Ok(walker.matched_paths.keys().to_vec()),
        Ok(Err(e)) => Err(sys_error(&e)),
        Err(e) => Err(format!("{e:?}").into_bytes()),
    }
}

fn sys_error(e: &bun_sys::Error) -> Vec<u8> {
    let mut out = e.name().to_vec();
    out.push(0);
    out.extend_from_slice(<&'static str>::from(e.syscall).as_bytes());
    out.push(0);
    out.extend_from_slice(e.path.as_ref());
    out
}

/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn glob_match_c(pattern: *const u8, pattern_len: usize, path: *const u8, path_len: usize) -> u32 {
    let slice = |p: *const u8, n: usize| if n == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, n) } };
    glob_match(slice(pattern, pattern_len), slice(path, path_len)) as u32
}

/// `glob_scan`: status 0 = the matched paths, each followed by a NUL; 1 = the error.
///
/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn glob_scan_c(pattern: *const u8, pattern_len: usize, cwd: *const u8, cwd_len: usize, flags: u32) -> *mut Output {
    let slice = |p: *const u8, n: usize| if n == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, n) } };
    let (status, bytes) = match glob_scan(slice(pattern, pattern_len), slice(cwd, cwd_len), flags) {
        Ok(paths) => (0, paths.iter().flat_map(|p| p.iter().copied().chain([0])).collect::<Vec<u8>>()),
        Err(b) => (1, b),
    };
    let mut bytes = bytes.into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
}

// ── Bun.YAML / Bun.TOML ──

pub mod data;

/// `data::parse`: status 0 = the JSON tree, 1 = the error message. `format` 0 = YAML, 1 = TOML.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn data_parse_c(text: *const u8, text_len: usize, format: u32) -> *mut Output {
    install_panic_hook();
    let text = if text_len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(text, text_len) } };
    let (status, bytes) = match data::parse(text, format) {
        Ok(b) => (0, b),
        Err(b) => (1, b),
    };
    let mut bytes = bytes.into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
}

// ── Bun.password ──

pub mod password;

/// `password::hash`: status 0 = the encoded hash, 1 = Bun's error name.
///
/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn password_hash_c(pw: *const u8, pw_len: usize, salt: *const u8, salt_len: usize, algorithm: u32, memory_cost: u32, time_cost: u32) -> *mut Output {
    install_panic_hook();
    let slice = |p: *const u8, n: usize| if n == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, n) } };
    output(password::hash(slice(pw, pw_len), slice(salt, salt_len), algorithm, memory_cost, time_cost).map_err(|e| e.as_bytes().to_vec()))
}

/// `password::verify`: status 0 = `1` or `0` (match or not), 1 = Bun's error name.
///
/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn password_verify_c(pw: *const u8, pw_len: usize, hash: *const u8, hash_len: usize, algorithm: u32) -> *mut Output {
    install_panic_hook();
    let slice = |p: *const u8, n: usize| if n == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, n) } };
    output(password::verify(slice(pw, pw_len), slice(hash, hash_len), algorithm).map(|ok| vec![if ok { b'1' } else { b'0' }]).map_err(|e| e.as_bytes().to_vec()))
}

fn output(r: Result<Vec<u8>, Vec<u8>>) -> *mut Output {
    let (status, bytes) = match r {
        Ok(b) => (0, b),
        Err(b) => (1, b),
    };
    let mut bytes = bytes.into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
}
