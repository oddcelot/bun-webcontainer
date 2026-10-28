//! Defines the `bun_sys_host_*` symbols that bun's wasm `sys` backend declares (ABI documented in
//! bun/src/sys/wasm_impl.rs). Depend on this crate and write `use bun_sys_host as _;`.
//!
//! * default: every call returns `-ENOSYS`, so the wasm has no imports;
//! * feature `imports`: every call is a wasm import `bun_sys.<name>`, provided by
//!   `playground/src/worker/sysHost.ts`.
#![no_std]

#[cfg(not(feature = "imports"))]
const ENOSYS: i64 = 38;

macro_rules! host_fns {
    ($( $sym:ident => $name:ident ($($arg:ident : $ty:ty),*); )*) => {
        #[cfg(feature = "imports")]
        mod imp {
            #[link(wasm_import_module = "bun_sys")]
            unsafe extern "C" {
                $( pub fn $name($($arg: $ty),*) -> i64; )*
            }
        }
        $(
            /// # Safety
            /// Pointer arguments must be valid for their lengths.
            #[unsafe(no_mangle)]
            pub unsafe extern "C" fn $sym($($arg: $ty),*) -> i64 {
                #[cfg(feature = "imports")]
                { unsafe { imp::$name($($arg),*) } }
                #[cfg(not(feature = "imports"))]
                { $(let _ = $arg;)* -ENOSYS }
            }
        )*
    };
}

host_fns! {
    bun_sys_host_open => open(dirfd: i32, path: *const u8, len: usize, flags: i32, mode: u32);
    bun_sys_host_close => close(fd: i32);
    bun_sys_host_read => read(fd: i32, buf: *mut u8, len: usize);
    bun_sys_host_write => write(fd: i32, buf: *const u8, len: usize);
    bun_sys_host_pread => pread(fd: i32, buf: *mut u8, len: usize, off: i64);
    bun_sys_host_pwrite => pwrite(fd: i32, buf: *const u8, len: usize, off: i64);
    bun_sys_host_lseek => lseek(fd: i32, off: i64, whence: i32);
    bun_sys_host_stat => stat(dirfd: i32, path: *const u8, len: usize, flags: i32, out: *mut u8);
    bun_sys_host_fstat => fstat(fd: i32, out: *mut u8);
    bun_sys_host_mkdir => mkdir(dirfd: i32, path: *const u8, len: usize, mode: u32, recursive: i32);
    bun_sys_host_unlink => unlink(dirfd: i32, path: *const u8, len: usize, flags: i32);
    bun_sys_host_rename => rename(from_dir: i32, from: *const u8, flen: usize, to_dir: i32, to: *const u8, tlen: usize);
    bun_sys_host_getdents => getdents(fd: i32, buf: *mut u8, len: usize);
    bun_sys_host_getcwd => getcwd(buf: *mut u8, len: usize);
}
