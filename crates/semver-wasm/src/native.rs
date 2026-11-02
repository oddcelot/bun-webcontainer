//! Scalar stand-ins for the C/C++ symbols the semver closure links against
//! (`src/jsc/bindings/highway_strings.cpp`, `bun_restore_stdio`). Same contracts;
//! see `src/sema/standalone/native.rs` in bun for the fuller set.

unsafe fn bytes<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { core::slice::from_raw_parts(p, len) } }
}

/// Index of the first `needle`, or `len` if absent.
#[unsafe(no_mangle)]
unsafe extern "C" fn highway_index_of_char(p: *const u8, len: usize, needle: u8) -> usize {
    unsafe { bytes(p, len) }.iter().position(|&c| c == needle).unwrap_or(len)
}

/// Pointer to the first match, null if absent; `h` for an empty needle.
#[unsafe(no_mangle)]
unsafe extern "C" fn highway_memmem(h: *const u8, h_len: usize, n: *const u8, n_len: usize) -> *const u8 {
    let (hay, needle) = unsafe { (bytes(h, h_len), bytes(n, n_len)) };
    if needle.is_empty() {
        return h;
    }
    hay.windows(needle.len())
        .position(|w| w == needle)
        .map_or(core::ptr::null(), |i| unsafe { h.add(i) })
}

#[unsafe(no_mangle)]
extern "C" fn bun_restore_stdio() {}
