//! Acceptance probe: `bun_sys` file operations on wasm64, served by the host's `bun_sys` imports
//! (packages/vfs/sysHost.ts). Paths are UTF-8 `(ptr, len)`; results are `>= 0` or `-errno`.

use bun_sys_host as _; // defines the symbols bun_sys declares (as wasm imports)
use bun_sys::{Fd, File, O, dir_iterator};
use std::alloc::{Layout, alloc as std_alloc, dealloc as std_dealloc};

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

fn neg(e: &bun_sys::Error) -> i64 {
    -(e.errno as i64)
}

/// Reads a whole file into `out` (capacity `cap`). Returns the file size, which may exceed `cap`
/// (then only `cap` bytes were copied), or `-errno`.
///
/// # Safety
/// `path` and `out` must be valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sys_read_file(path: *const u8, len: usize, out: *mut u8, cap: usize) -> i64 {
    match File::read_from(Fd::cwd(), unsafe { bytes(path, len) }) {
        Ok(data) => {
            let n = data.len().min(cap);
            unsafe { core::ptr::copy_nonoverlapping(data.as_ptr(), out, n) };
            data.len() as i64
        }
        Err(e) => neg(&e),
    }
}

/// Creates or truncates `path` and writes `data`. Returns bytes written or `-errno`.
///
/// # Safety
/// Both ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sys_write_file(path: *const u8, len: usize, data: *const u8, dlen: usize) -> i64 {
    let data = unsafe { bytes(data, dlen) };
    let file = match File::create(Fd::cwd(), unsafe { bytes(path, len) }, true) {
        Ok(f) => f,
        Err(e) => return neg(&e),
    };
    let r = file.write_all(data);
    let _ = file.close();
    match r {
        Ok(()) => data.len() as i64,
        Err(e) => neg(&e),
    }
}

/// `stat`: returns 1 for a directory, 0 for a regular file, or `-errno`; stores st_size in `*size`.
///
/// # Safety
/// `path` must be readable and `size` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sys_stat(path: *const u8, len: usize, size: *mut i64) -> i64 {
    let mut z = unsafe { bytes(path, len) }.to_vec();
    z.push(0);
    let zstr = unsafe { bun_core::ZStr::from_raw(z.as_ptr(), len) };
    match bun_sys::stat(zstr) {
        Ok(st) => {
            unsafe { *size = st.st_size };
            ((st.st_mode & 0o170000) == 0o040000) as i64
        }
        Err(e) => neg(&e),
    }
}

/// Lists a directory as newline-separated names, each prefixed with `d/` or `f/`. Returns the
/// total length (may exceed `cap`; then the output is truncated) or `-errno`.
///
/// # Safety
/// `path` and `out` must be valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sys_list_dir(path: *const u8, len: usize, out: *mut u8, cap: usize) -> i64 {
    let fd = match bun_sys::open_a(unsafe { bytes(path, len) }, O::DIRECTORY | O::RDONLY, 0) {
        Ok(fd) => fd,
        Err(e) => return neg(&e),
    };
    let mut text = Vec::new();
    let mut it = dir_iterator::iterate(fd);
    let err = loop {
        match it.next() {
            Ok(Some(entry)) => {
                text.extend_from_slice(if matches!(entry.kind, bun_sys::EntryKind::Directory) { b"d/" } else { b"f/" });
                text.extend_from_slice(entry.name.slice_u8());
                text.push(b'\n');
            }
            Ok(None) => break None,
            Err(e) => break Some(e),
        }
    };
    let _ = bun_sys::close(fd);
    if let Some(e) = err {
        return neg(&e);
    }
    let n = text.len().min(cap);
    unsafe { core::ptr::copy_nonoverlapping(text.as_ptr(), out, n) };
    text.len() as i64
}

/// Number of fds the host still has open for us is not observable here; this just exercises
/// `mkdir -p` + `rename` + `unlink`: returns 0 or `-errno` of the first failing step.
///
/// # Safety
/// All ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sys_mkdir_rename_unlink(dir: *const u8, dlen: usize, from: *const u8, flen: usize, to: *const u8, tlen: usize) -> i64 {
    if let Err(e) = bun_sys::mkdir_recursive_at_mode(Fd::cwd(), unsafe { bytes(dir, dlen) }, 0o777) {
        return neg(&e);
    }
    let (mut f, mut t) = (unsafe { bytes(from, flen) }.to_vec(), unsafe { bytes(to, tlen) }.to_vec());
    f.push(0);
    t.push(0);
    let (fz, tz) = unsafe { (bun_core::ZStr::from_raw(f.as_ptr(), flen), bun_core::ZStr::from_raw(t.as_ptr(), tlen)) };
    if let Err(e) = bun_sys::rename(fz, tz) {
        return neg(&e);
    }
    match bun_sys::unlink(tz) {
        Ok(()) => 0,
        Err(e) => neg(&e),
    }
}

/// C stand-in that bun_core references (see semver-wasm/src/native.rs).
#[unsafe(no_mangle)]
extern "C" fn bun_restore_stdio() {}

/// `bun.fastRandom()`: its PRNG is seeded from the host's `bun_sys.random` (crypto.getRandomValues).
#[unsafe(no_mangle)]
pub extern "C" fn sys_fast_random() -> u64 {
    bun_core::fast_random()
}

/// Wall-clock nanoseconds since the Unix epoch, from the host's `bun_sys.clock` (0 without it).
#[unsafe(no_mangle)]
pub extern "C" fn sys_nano_timestamp() -> i64 {
    bun_core::time::nano_timestamp() as i64
}

/// Monotonic nanoseconds (`Timespec::now`, what Bun's timers measure with).
#[unsafe(no_mangle)]
pub extern "C" fn sys_monotonic_ns() -> u64 {
    bun_core::Timespec::now(bun_core::TimespecMockMode::ForceRealTime).ns()
}
