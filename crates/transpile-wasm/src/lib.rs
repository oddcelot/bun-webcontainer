//! Bun's JS/TS/JSX transpiler (`bun_js_parser` + `bun_js_printer`) behind a pointer+length C ABI.
//!
//! Mirrors the no-bundle path of `bun_bundler::Transpiler` (`bundler/cache.rs` parse,
//! `print_ast_esm_ascii` print) without the resolver, macros or defines.

// The C/C++ stand-ins the parser and printer link against.
use bun_wasm_stubs as _;
// bun_sys declares bun_sys_host_* (syscalls); this crate never calls them, the stubs fail with ENOSYS.
use bun_sys_host as _;

use bun_alloc::Arena;
use bun_js_parser::{Define, Parser, ParserOptions, options};
use bun_js_printer as printer;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Loader {
    Js = 0,
    Jsx = 1,
    Ts = 2,
    Tsx = 3,
}

/// tsconfig `compilerOptions` that change the output, as bits of `transpile_flags_c`'s `flags`.
pub const EXPERIMENTAL_DECORATORS: u32 = 1;
pub const EMIT_DECORATOR_METADATA: u32 = 2;
/// Not a tsconfig option: on failure, `Output.ptr` holds the diagnostics as JSON (see `format_json`) instead of text.
pub const DIAGNOSTICS_JSON: u32 = 4;

/// Transpiled JS on success; formatted diagnostics on failure.
pub fn transpile(path: &[u8], source: &[u8], loader: Loader, flags: u32) -> Result<Vec<u8>, Vec<u8>> {
    transpile_with(path, source, loader, flags, None)
}

/// Replaces an import record's specifier: `(specifier, kind)` -> `Some(new)` or `None` to keep it.
pub type Resolver<'r> = &'r mut dyn FnMut(&[u8], u32) -> Option<Vec<u8>>;

/// Record kinds passed to the resolver (`bun_ast::ImportKind`).
pub const KIND_STMT: u32 = 2;
pub const KIND_DYNAMIC: u32 = 4;

/// `transpile`, with each `import`/`export ... from`/`import("x")` specifier (from Bun's import records, so
/// never text inside strings, templates or comments) passed through `resolve` before printing.
/// `require()` and `require.resolve()` records are left alone.
pub fn transpile_with(path: &[u8], source: &[u8], loader: Loader, flags: u32, resolve: Option<Resolver>) -> Result<Vec<u8>, Vec<u8>> {
    let arena = Arena::new();
    let mut ast_alloc = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _ast_scope = ast_alloc.enter();

    let loader = match loader {
        Loader::Js => bun_ast::Loader::Js,
        Loader::Jsx => bun_ast::Loader::Jsx,
        Loader::Ts => bun_ast::Loader::Ts,
        Loader::Tsx => bun_ast::Loader::Tsx,
    };
    let src = bun_ast::Source::init_path_string(path, source);
    let mut opts = ParserOptions::init(options::JSX::Pragma::default(), loader);
    // As `bun build --no-bundle --target=browser` sets them (`bundler/transpiler.rs`).
    opts.features.auto_import_jsx = true;
    opts.features.no_macros = true;
    opts.features.top_level_await = true;
    opts.features.lower_using = true;
    // As `bundler/transpiler.rs`: either tsconfig option means TypeScript's legacy decorators.
    let legacy = flags & (EXPERIMENTAL_DECORATORS | EMIT_DECORATOR_METADATA) != 0;
    opts.features.emit_decorator_metadata = flags & EMIT_DECORATOR_METADATA != 0;
    opts.features.standard_decorators = !loader.is_typescript() || !legacy;
    let define = Define::default();
    let mut log = bun_ast::Log::init();

    let parsed = Parser::init(opts, &mut log, &src, &define, &arena).and_then(|p| p.parse());
    let ast = match parsed {
        Ok(bun_js_parser::Result::Ast(ast)) if log.errors == 0 => ast,
        Ok(_) | Err(_) => {
            return Err(if flags & DIAGNOSTICS_JSON != 0 { format_json(&log) } else { format_log(&log) });
        }
    };
    let mut ast = *ast;

    if let Some(resolve) = resolve {
        for record in ast.import_records.iter_mut() {
            let kind = record.kind as u32;
            if (kind != KIND_STMT && kind != KIND_DYNAMIC) || record.flags.contains(bun_ast::ImportRecordFlags::IS_UNUSED) {
                continue;
            }
            if let Some(new) = resolve(record.path.text, kind) {
                record.path.text = arena.alloc_slice_copy(&new);
            }
        }
    }

    let symbols = bun_ast::symbol::Map::init_with_one_list(
        core::mem::replace(&mut ast.symbols, bun_alloc::ArenaVec::new_in(&arena))
            .into_iter()
            .collect(),
    );
    let opts = printer::Options {
        bundling: false,
        require_ref: Some(ast.require_ref),
        import_meta_ref: ast.import_meta_ref,
        hmr_ref: ast.wrapper_ref,
        ..Default::default()
    };
    let mut writer = printer::BufferPrinter::init(printer::BufferWriter::init());
    match printer::print_ast::<_, false, false>(&mut writer, &arena, &ast, symbols, &src, opts) {
        Ok(_) => Ok(writer.ctx.written().to_vec()),
        Err(e) => Err(format!("print failed: {e:?}").into_bytes()),
    }
}

fn format_log(log: &bun_ast::Log) -> Vec<u8> {
    let mut out = Vec::new();
    for msg in log.msgs.iter() {
        out.extend_from_slice(&msg.data.text);
        out.push(b'\n');
    }
    out
}

fn json_str(out: &mut Vec<u8>, s: &[u8]) {
    out.push(b'"');
    for ch in String::from_utf8_lossy(s).chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => out.extend_from_slice(format!("\\u{:04x}", c as u32).as_bytes()),
            c => out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes()),
        }
    }
    out.push(b'"');
}

fn json_data(out: &mut Vec<u8>, d: &bun_ast::Data) {
    out.extend_from_slice(b"\"text\":");
    json_str(out, &d.text);
    match &d.location {
        // `line` and `column` are 1-based (Bun's `Location.column` doc says 0-based but the parser emits 1-based), `length` is 0 for "one character"; `column` and `length` count UTF-8 bytes.
        Some(l) if l.line > 0 => {
            out.extend_from_slice(format!(",\"line\":{},\"column\":{},\"length\":{}", l.line, l.column, l.length).as_bytes())
        }
        _ => {}
    }
}

/// `{"diagnostics":[{"severity":"error"|"warning","text":..,"line"?:..,"column"?:..,"length"?:..,"notes":[{"text":..,"line"?..}]}]}`
/// for the messages of `Kind::Err`/`Kind::Warn` (notes and debug/verbose messages are skipped as top-level entries).
fn format_json(log: &bun_ast::Log) -> Vec<u8> {
    let mut out = b"{\"diagnostics\":[".to_vec();
    let mut first = true;
    for msg in log.msgs.iter() {
        let severity: &[u8] = match msg.kind {
            bun_ast::Kind::Err => b"error",
            bun_ast::Kind::Warn => b"warning",
            _ => continue,
        };
        if !first {
            out.push(b',');
        }
        first = false;
        out.extend_from_slice(b"{\"severity\":\"");
        out.extend_from_slice(severity);
        out.extend_from_slice(b"\",");
        json_data(&mut out, &msg.data);
        out.extend_from_slice(b",\"notes\":[");
        for (i, note) in msg.notes.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.push(b'{');
            json_data(&mut out, note);
            out.push(b'}');
        }
        out.extend_from_slice(b"]}");
    }
    out.extend_from_slice(b"]}");
    out
}

// ── C ABI ──
//
// Host flow: `alloc` input buffers, write UTF-8, call `transpile`, read the `Output` it returns,
// then `output_free` it and `dealloc` the inputs.

#[repr(C)]
pub struct Output {
    /// 0 = ok (`ptr` is JS), 1 = error (`ptr` is diagnostics), 2 = bad loader.
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

/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn transpile_c(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
) -> *mut Output {
    unsafe { transpile_flags_c(path, path_len, src, src_len, loader, 0) }
}

/// `transpile_c` with tsconfig flags (`EXPERIMENTAL_DECORATORS`, `EMIT_DECORATOR_METADATA`) and `DIAGNOSTICS_JSON`.
///
/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn transpile_flags_c(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    flags: u32,
) -> *mut Output {
    unsafe { run(path, path_len, src, src_len, loader, flags, None) }
}

unsafe fn run(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    flags: u32,
    resolve: Option<Resolver>,
) -> *mut Output {
    let slice = |p: *const u8, n: usize| if n == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, n) } };
    let loader = match loader {
        0 => Loader::Js,
        1 => Loader::Jsx,
        2 => Loader::Ts,
        3 => Loader::Tsx,
        _ => return Box::into_raw(Box::new(Output { status: 2, ptr: core::ptr::null_mut(), len: 0 })),
    };
    let (status, bytes) = match transpile_with(slice(path, path_len), slice(src, src_len), loader, flags, resolve) {
        Ok(b) => (0, b),
        Err(b) => (1, b),
    };
    let mut bytes = bytes.into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
}

// ── Host resolver ABI (`transpile_resolve_c`) ──
//
// The module imports `env.resolve_specifier(ptr: usize, len: usize, kind: u32) -> usize` (usize = i64 on wasm64).
// `ptr`/`len` is the UTF-8 specifier as written, valid only during the call; `kind` is 2 (static import or
// `export ... from`) or 4 (`import("literal")`). The host returns 0 to keep it, or a pointer from this module's
// `alloc(8 + n)` holding `n` as a little-endian u64 followed by `n` bytes of UTF-8 replacement. The transpiler
// copies the bytes and frees the buffer. Memory may grow during `alloc`, so the host must re-view `memory.buffer`.
#[cfg(target_family = "wasm")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    #[link_name = "resolve_specifier"]
    fn host_resolve_specifier(ptr: *const u8, len: usize, kind: u32) -> usize;
}
#[cfg(not(target_family = "wasm"))]
unsafe fn host_resolve_specifier(_: *const u8, _: usize, _: u32) -> usize {
    0
}

/// `transpile_flags_c` that rewrites import specifiers through the host's `env.resolve_specifier`.
///
/// # Safety
/// Both input ranges must be readable; the host import must follow the ABI above.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn transpile_resolve_c(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    flags: u32,
) -> *mut Output {
    let mut host = |spec: &[u8], kind: u32| -> Option<Vec<u8>> {
        let p = unsafe { host_resolve_specifier(spec.as_ptr(), spec.len(), kind) };
        if p == 0 {
            return None;
        }
        let n = unsafe { core::ptr::read_unaligned(p as *const u64) } as usize;
        let out = unsafe { core::slice::from_raw_parts((p + 8) as *const u8, n) }.to_vec();
        unsafe { dealloc(p as *mut u8, 8 + n) };
        Some(out)
    };
    unsafe { run(path, path_len, src, src_len, loader, flags, Some(&mut host)) }
}

/// # Safety
/// `out` must come from `transpile_c`, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn output_free(out: *mut Output) {
    let out = unsafe { Box::from_raw(out) };
    if !out.ptr.is_null() {
        drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(out.ptr, out.len)) });
    }
}
