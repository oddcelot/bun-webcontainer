//! Bun's JS/TS/JSX transpiler (`bun_js_parser` + `bun_js_printer`) behind a pointer+length C ABI.
//!
//! Mirrors the no-bundle path of `bun_bundler::Transpiler` (`bundler/cache.rs` parse,
//! `print_ast_esm_ascii` print) without the resolver, macros or defines.

#![feature(linkage)]

mod native;

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

/// Transpiled JS on success; formatted diagnostics on failure.
pub fn transpile(path: &[u8], source: &[u8], loader: Loader, flags: u32) -> Result<Vec<u8>, Vec<u8>> {
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
        Ok(_) | Err(_) => return Err(format_log(&log)),
    };
    let mut ast = *ast;

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

/// `transpile_c` with tsconfig flags (`EXPERIMENTAL_DECORATORS`, `EMIT_DECORATOR_METADATA`).
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
    let slice = |p: *const u8, n: usize| if n == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, n) } };
    let loader = match loader {
        0 => Loader::Js,
        1 => Loader::Jsx,
        2 => Loader::Ts,
        3 => Loader::Tsx,
        _ => return Box::into_raw(Box::new(Output { status: 2, ptr: core::ptr::null_mut(), len: 0 })),
    };
    let (status, bytes) = match transpile(slice(path, path_len), slice(src, src_len), loader, flags) {
        Ok(b) => (0, b),
        Err(b) => (1, b),
    };
    let mut bytes = bytes.into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
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
