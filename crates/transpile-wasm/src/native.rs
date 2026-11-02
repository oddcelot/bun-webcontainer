//! The C/C++ symbols the parser/printer closure links against, for when this crate is the final
//! artifact. Most come from upstream's `src/sema/standalone/native.rs` (written for parser-only
//! binaries); `extra` adds the ones it doesn't cover.

// bun_sys declares bun_sys_host_* (syscalls); this crate never calls them, the stubs fail with ENOSYS.
use bun_sys_host as _;

#[allow(dead_code, unused_imports, unsafe_op_in_unsafe_fn)]
#[path = "../../../bun/src/sema/standalone/native.rs"]
mod sema_native;

#[allow(non_snake_case)]
mod extra {
    use core::ptr::NonNull;

    use bun_ast::{Expr, Log, Range, Source};
    use bun_js_parser::Macro::MacroContext;

    /// ECMAScript `Number::exponentiate`: unlike `powf`, NaN for `(±1, ±∞)` and any NaN exponent.
    #[unsafe(no_mangle)]
    extern "C" fn Bun__JSC__operationMathPow(x: f64, y: f64) -> f64 {
        if y.is_nan() || (x.abs() == 1.0 && y.is_infinite()) { f64::NAN } else { x.powf(y) }
    }

    /// ECMAScript `StringToNumber` for ASCII input.
    #[unsafe(no_mangle)]
    unsafe extern "C" fn JSC__jsToNumber(ptr: *const u8, len: usize) -> f64 {
        let bytes = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(ptr, len) } };
        let Ok(s) = core::str::from_utf8(bytes) else { return f64::NAN };
        let s = s.trim_matches(|c: char| c.is_ascii_whitespace() || c == '\u{0B}');
        if s.is_empty() {
            return 0.0;
        }
        let radix = |p: &str, r| if p.is_empty() { None } else { u128::from_str_radix(p, r).ok().map(|v| v as f64) };
        let lower = s.get(..2).map(str::to_ascii_lowercase);
        let prefixed = match lower.as_deref() {
            Some("0x") => Some(radix(&s[2..], 16)),
            Some("0o") => Some(radix(&s[2..], 8)),
            Some("0b") => Some(radix(&s[2..], 2)),
            _ => None,
        };
        if let Some(v) = prefixed {
            return v.unwrap_or(f64::NAN);
        }
        let (sign, body) = match s.as_bytes()[0] {
            b'-' => (-1.0, &s[1..]),
            b'+' => (1.0, &s[1..]),
            _ => (1.0, s),
        };
        if body == "Infinity" {
            return sign * f64::INFINITY;
        }
        // Rust accepts "inf"/"nan"/"infinity" spellings that JS doesn't.
        if !body.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-')) {
            return f64::NAN;
        }
        body.parse::<f64>().map_or(f64::NAN, |v| sign * v)
    }

    #[unsafe(no_mangle)]
    unsafe extern "C" fn Bun__WTFStringImpl__destroy(_this: *const core::ffi::c_void) {
        unreachable!("no WTF strings without JSC")
    }

    /// Code-unit order; ICU collation is not available.
    #[unsafe(no_mangle)]
    unsafe extern "C" fn Bun__collateUTF8(_numeric: bool, a: *const u8, al: usize, b: *const u8, bl: usize) -> i32 {
        let (a, b) = unsafe { (core::slice::from_raw_parts(a, al), core::slice::from_raw_parts(b, bl)) };
        a.cmp(b) as i32
    }

    #[unsafe(no_mangle)]
    unsafe extern "C" fn Bun__collateUTF16(_numeric: bool, a: *const u16, al: usize, b: *const u16, bl: usize) -> i32 {
        let (a, b) = unsafe { (core::slice::from_raw_parts(a, al), core::slice::from_raw_parts(b, bl)) };
        a.cmp(b) as i32
    }

    #[unsafe(no_mangle)]
    extern "C" fn URL__getFileURLString(_input: &bun_core::String) -> bun_core::String {
        unreachable!("WebKit's URL parser is not linked")
    }

    // `bun_dispatch` slots `bun_jsc` fills; the transpiler cache is never enabled here.
    #[unsafe(no_mangle)]
    fn __bun_dispatch__TranspilerCacheImpl__Jsc__get(
        _owner: *mut (),
        _source: &Source<'_>,
        _parser_options: NonNull<()>,
        _used_jsx: bool,
    ) -> bool {
        unreachable!("no transpiler cache")
    }

    #[unsafe(no_mangle)]
    fn __bun_dispatch__TranspilerCacheImpl__Jsc__put(_owner: *mut (), _code: &[u8], _map: &[u8], _esm: &[u8]) {
        unreachable!("no transpiler cache")
    }

    #[unsafe(no_mangle)]
    #[allow(clippy::too_many_arguments)]
    fn __bun_macro_context_call(
        _ctx: &mut MacroContext,
        _import_record_path: &[u8],
        _source_dir: &[u8],
        _log: &mut Log,
        _source: &Source,
        _import_range: Range,
        _caller: Expr,
        _function_name: &[u8],
    ) -> Result<Expr, bun_js_parser::Error> {
        unreachable!("macros need JSC")
    }

    /// Bun's event-loop dispatch (`bun_runtime::dispatch`); there is no event loop here.
    #[unsafe(no_mangle)]
    unsafe fn __bun_run_file_poll(_poll: *mut core::ffi::c_void, _size_or_offset: i64) {
        unreachable!("no event loop")
    }

    /// Lives in sema's fake mimalloc, which is compiled out when `bun_mimalloc_sys`'s wasm shim is the allocator.
    #[cfg(bun_sema_mimalloc)]
    #[unsafe(no_mangle)]
    #[allow(clippy::too_many_arguments)]
    unsafe extern "C" fn mi_process_info(
        a: *mut usize,
        b: *mut usize,
        c: *mut usize,
        d: *mut usize,
        e: *mut usize,
        f: *mut usize,
        g: *mut usize,
        h: *mut usize,
    ) {
        for p in [a, b, c, d, e, f, g, h] {
            if !p.is_null() {
                unsafe { *p = 0 };
            }
        }
    }
}
