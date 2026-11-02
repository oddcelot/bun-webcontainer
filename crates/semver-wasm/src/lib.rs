//! `bun_semver` behind a pointer+length C ABI for wasm64.
//!
//! The host writes UTF-8 into buffers from `alloc`, calls an export, then `dealloc`s.
//! Mirrors `Bun.semver.order` / `Bun.semver.satisfies` (`src/semver_jsc/SemverObject.rs`).

mod native;

use core::cmp::Ordering;
use std::alloc::{Layout, alloc as std_alloc, dealloc as std_dealloc};

use bun_semver::{SlicedString, Version, query};

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::NonNull::dangling().as_ptr();
    }
    unsafe { std_alloc(Layout::from_size_align_unchecked(len, 1)) }
}

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len != 0 {
        unsafe { std_dealloc(ptr, Layout::from_size_align_unchecked(len, 1)) }
    }
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { core::slice::from_raw_parts(ptr, len) } }
}

/// -1 / 0 / 1 like `Bun.semver.order`; 2 if either side is not a valid version.
///
/// # Safety
/// Both ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn semver_order(a: *const u8, a_len: usize, b: *const u8, b_len: usize) -> i32 {
    let (left, right) = unsafe { (bytes(a, a_len), bytes(b, b_len)) };
    if !left.is_ascii() || !right.is_ascii() {
        return 0;
    }
    let l = Version::parse(SlicedString::init(left, left));
    let r = Version::parse(SlicedString::init(right, right));
    if !l.valid || !r.valid {
        return 2;
    }
    match l.version.max().order_without_build(r.version.max(), left, right) {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

/// 1 if `version` satisfies `range`, 0 if not, -1 on allocation failure.
///
/// # Safety
/// Both ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn semver_satisfies(v: *const u8, v_len: usize, r: *const u8, r_len: usize) -> i32 {
    let (version, range) = unsafe { (bytes(v, v_len), bytes(r, r_len)) };
    if !version.is_ascii() || !range.is_ascii() {
        return 0;
    }
    let Some(parsed) = Version::parse_exact(SlicedString::init(version, version)) else {
        return 0;
    };
    let Ok(group) = query::parse(range, SlicedString::init(range, range)) else {
        return -1;
    };
    let ok = match group.get_exact_version() {
        Some(exact) => parsed.eql(exact),
        None => group.satisfies(parsed, range, version),
    };
    ok as i32
}
