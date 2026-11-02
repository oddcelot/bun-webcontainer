//! The C/C++ symbols the formatter links against. The parser's come from bun_wasm_stubs; `yarr` adds JavaScriptCore's
//! regular expressions, which the formatter only compiles for options it never gets here (`sortImports`,
//! `sortTailwindcss`).

use bun_wasm_stubs as _;
// The bun_sys_host_* symbols bun_sys declares, as `bun_sys.*` wasm imports served by the VFS.
use bun_sys_host as _;

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
