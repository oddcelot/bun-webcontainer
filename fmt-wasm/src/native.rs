//! The C/C++ symbols the formatter links against. The parser's are transpile-wasm's; `yarr` adds JavaScriptCore's
//! regular expressions, which the formatter only compiles for options it never gets here (`sortImports`,
//! `sortTailwindcss`).

#[path = "../../transpile-wasm/src/native.rs"]
mod transpile;

mod yarr {
    use core::ffi::c_void;

    /// Refuses every pattern as too large, so `bun_yarr::Compiled::new` fails instead of matching.
    #[unsafe(no_mangle)]
    extern "C" fn Yarr__RegularExpression__compile(
        _characters: *const c_void,
        _length: u32,
        _is_8_bit: bool,
        _flags: u16,
        _offsets_size: &mut u32,
        refusal: &mut u8,
    ) -> *mut c_void {
        *refusal = 1;
        core::ptr::null_mut()
    }

    #[unsafe(no_mangle)]
    extern "C" fn Yarr__RegularExpression__exec(
        _this: *mut c_void,
        _characters: *const c_void,
        _length: u32,
        _is_8_bit: bool,
        _start: u32,
        _offsets: *mut u32,
    ) -> bool {
        unreachable!("no pattern compiles")
    }

    #[unsafe(no_mangle)]
    extern "C" fn Yarr__RegularExpression__deinit(_this: *mut c_void) {}

    /// Starts JavaScriptCore before a match in `bun_jsc`; there is none, and nothing matches.
    #[unsafe(no_mangle)]
    fn __bun_yarr_initialize() {}
}
