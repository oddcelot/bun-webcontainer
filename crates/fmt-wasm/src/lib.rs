//! `bun fmt` (`bun_format` through `bun_lint_driver`'s per-file entry) behind a pointer+length C ABI.
//!
//! Formats one file the way `bun fmt --stdin-filepath <path>` does with no config file: the language comes from the
//! path, and `flags` / `print_width` are the command line's `--use-tabs`, `--no-semi`, `--single-quote` and
//! `--print-width`.

mod cli;
mod native;

use bun_format::FormatOptions;
use bun_format::options::{IndentStyle, LineWidth, QuoteStyle, Semicolons};
use bun_lint_driver::fmt::{FormatFailure, format_for_tests};

pub const USE_TABS: u32 = 1;
pub const NO_SEMI: u32 = 2;
pub const SINGLE_QUOTE: u32 = 4;

/// True if `bun fmt` formats a file with this name (`bun_lint_driver`'s `language_of`, plus TOML and Svelte, which
/// `bun fmt` turns on). `format_for_tests` itself formats any other name as JavaScript.
pub fn supports(path: &[u8]) -> bool {
    let name = path.rsplit(|&b| b == b'/').next().unwrap_or(path).to_ascii_lowercase();
    let extension = name.rsplit(|&b| b == b'.').next().filter(|it| it.len() < name.len()).unwrap_or(b"");
    matches!(extension, b"js" | b"mjs" | b"cjs" | b"jsx" | b"ts" | b"mts" | b"cts" | b"tsx")
        || name.ends_with(b".js.flow")
        || bun_format::json::parser_for_path(&name).is_some()
        || bun_format::css::parser_for_path(&name).is_some()
        || bun_format::yaml::is_yaml_path(&name)
        || bun_format::markdown::is_markdown_path(&name)
        || bun_format::markdown::is_mdx_path(&name)
        || bun_format::graphql::is_graphql_path(&name)
        || bun_format::handlebars::is_handlebars_path(&name)
        || bun_format::html::parser_for_path(&name).is_some()
        || (name.len() > 5 && name.ends_with(b".toml"))
        || (name.len() > 7 && name.ends_with(b".svelte"))
}

/// Lock files and minified code, which `bun fmt` skips when it walks a directory (`files::is_generated`).
pub fn is_generated(path: &[u8]) -> bool {
    let name = path.rsplit(|&b| b == b'/').next().unwrap_or(path);
    matches!(
        name,
        b"package-lock.json" | b"npm-shrinkwrap.json" | b"pnpm-lock.yaml" | b"yarn.lock" | b"bun.lock" | b"deno.lock"
            | b"composer.lock" | b"Cargo.lock" | b"MODULE.bazel.lock" | b"Package.resolved" | b"Pipfile.lock"
            | b"flake.lock" | b"mcmod.info" | b"Gopkg.lock" | b"pdm.lock" | b"poetry.lock" | b"uv.lock"
            | b"glide.lock" | b"pixi.lock"
    ) || [&b".min.js"[..], b".min.mjs", b".min.cjs", b".min.css"].iter().any(|it| name.ends_with(it))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// `bun fmt` doesn't format files with this name.
    Unsupported,
    /// The file has a syntax error (or is nested too deeply) and is left as is.
    Syntax,
    /// The formatter caught a bug in itself.
    Bug,
}

/// `print_width` 0 keeps the default (80).
pub fn options(flags: u32, print_width: u32) -> FormatOptions {
    let mut options = FormatOptions::default();
    // On in `bun fmt` unless a Prettier config turns them off.
    options.toml = true;
    options.svelte.is_on = true;
    // As in `bun fmt` (lint/driver/fmt/config.rs): HTML in Markdown code blocks and JS templates gets formatted too.
    options.embedded_html = true;
    if flags & USE_TABS != 0 {
        options.indent_style = IndentStyle::Tab;
    }
    if flags & NO_SEMI != 0 {
        options.semicolons = Semicolons::AsNeeded;
    }
    if flags & SINGLE_QUOTE != 0 {
        options.quote_style = QuoteStyle::Single;
    }
    if print_width != 0 {
        options.line_width = LineWidth(print_width);
    }
    options
}

pub fn format(path: &[u8], text: &[u8], flags: u32, print_width: u32) -> Result<Vec<u8>, Error> {
    if !supports(path) {
        return Err(Error::Unsupported);
    }
    match format_for_tests(path, text, &options(flags, print_width)) {
        Ok((out, _cursor)) => Ok(out),
        Err(FormatFailure::Syntax) => Err(Error::Syntax),
        Err(FormatFailure::Bug) => Err(Error::Bug),
    }
}

#[repr(C)]
pub struct Output {
    /// 0 = ok (`ptr` is the formatted text), 1 = syntax error, 2 = formatter bug, 3 = not a language `bun fmt`
    /// formats (`ptr` is null for 1-3).
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
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn format_c(
    path: *const u8,
    path_len: usize,
    text: *const u8,
    text_len: usize,
    flags: u32,
    print_width: u32,
) -> *mut Output {
    let path = unsafe { core::slice::from_raw_parts(path, path_len) };
    let text = unsafe { core::slice::from_raw_parts(text, text_len) };
    let out = match format(path, text, flags, print_width) {
        Ok(out) => {
            let out = Box::into_raw(out.into_boxed_slice());
            Output { status: 0, ptr: out.cast(), len: out.len() }
        }
        Err(Error::Syntax) => Output { status: 1, ptr: core::ptr::null_mut(), len: 0 },
        Err(Error::Bug) => Output { status: 2, ptr: core::ptr::null_mut(), len: 0 },
        Err(Error::Unsupported) => Output { status: 3, ptr: core::ptr::null_mut(), len: 0 },
    };
    Box::into_raw(Box::new(out))
}

/// 1 if a directory walk formats the file at `path`: `supports` and not `is_generated`.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn walks_c(path: *const u8, path_len: usize) -> u32 {
    let path = unsafe { core::slice::from_raw_parts(path, path_len) };
    (supports(path) && !is_generated(path)) as u32
}

#[repr(C)]
pub struct RunOutput {
    pub exit_code: u64,
    pub stdout: *mut u8,
    pub stdout_len: usize,
    pub stderr: *mut u8,
    pub stderr_len: usize,
}

/// `bun fmt <args>`; `args` are NUL-separated. The host serves standard input (fd 0) for `--stdin-filepath`.
/// `colors`: 1 for ANSI colors in what it prints. Free the result with `run_output_free`.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn run_c(args: *const u8, args_len: usize, colors: u32) -> *mut RunOutput {
    let args = unsafe { core::slice::from_raw_parts(args, args_len) };
    let args: Vec<&[u8]> = if args.is_empty() { Vec::new() } else { args.split(|&b| b == 0).collect() };
    let outcome = cli::run(&args, colors != 0);
    let leak = |v: Vec<u8>| {
        let b = Box::into_raw(v.into_boxed_slice());
        (b.cast::<u8>(), b.len())
    };
    let (stdout, stdout_len) = leak(outcome.stdout);
    let (stderr, stderr_len) = leak(outcome.stderr);
    Box::into_raw(Box::new(RunOutput { exit_code: u64::from(outcome.exit_code), stdout, stdout_len, stderr, stderr_len }))
}

/// # Safety
/// `out` must come from `run_c`, once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn run_output_free(out: *mut RunOutput) {
    let out = unsafe { Box::from_raw(out) };
    drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(out.stdout, out.stdout_len)) });
    drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(out.stderr, out.stderr_len)) });
}

/// # Safety
/// `out` must come from `format_c`, once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn output_free(out: *mut Output) {
    let out = unsafe { Box::from_raw(out) };
    if !out.ptr.is_null() {
        drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(out.ptr, out.len)) });
    }
}
