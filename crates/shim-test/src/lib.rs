//! Runs bun's wasm `mi_*` shim (src/mimalloc_sys/wasm.rs) natively so its heap semantics can be tested.
#![allow(dead_code, unused_imports)]
#[path = "../../../bun/src/mimalloc_sys/mimalloc.rs"]
pub mod mimalloc;
#[path = "../../../bun/src/mimalloc_sys/wasm.rs"]
mod wasm;

#[cfg(test)]
mod tests {
    use super::mimalloc::*;
    use core::ffi::c_void;

    extern "C" fn count(_: *const Heap, _: *const mi_heap_area_t, b: *mut c_void, _: usize, arg: *mut c_void) -> bool {
        if b.is_null() { unsafe { *arg.cast::<usize>() += 1 } }
        true
    }
    fn blocks(h: *mut Heap) -> usize {
        let mut n = 0usize;
        unsafe { mi_heap_visit_blocks(h, false, Some(count), (&raw mut n).cast()) };
        n
    }

    #[test]
    fn heap_tracks_and_destroys() {
        unsafe {
            let h = mi_heap_new();
            let a = mi_heap_malloc(h, 10);
            let b = mi_heap_malloc_aligned(h, 100, 256);
            let _c = mi_heap_zalloc_auto_align(h, 33, 64);
            assert_eq!(b as usize % 256, 0);
            assert_eq!(blocks(h), 3);
            mi_free(a);
            assert_eq!(blocks(h), 2);
            core::ptr::write_bytes(b.cast::<u8>(), 7, 100);
            let b2 = mi_heap_realloc_aligned(h, b, 5000, 256);
            assert_eq!(b2 as usize % 256, 0);
            assert_eq!(*b2.cast::<u8>().add(99), 7);
            assert_eq!(mi_usable_size(b2), 5000);
            assert_eq!(blocks(h), 2);
            let d = mi_realloc(_c, 1); // stays in its heap
            assert!(!d.is_null());
            assert_eq!(blocks(h), 2);
            mi_heap_destroy(h); // frees the 2 remaining blocks (run under miri/asan to prove)
        }
    }

    #[test]
    fn plain_and_main_heap() {
        unsafe {
            let p = mi_zalloc_aligned(64, 32);
            assert_eq!(p as usize % 32, 0);
            assert!((0..64).all(|i| *p.cast::<u8>().add(i) == 0));
            assert!(mi_expand(p, 65).is_null());
            assert_eq!(mi_expand(p, 10), p);
            mi_free(p);
            let m = mi_heap_malloc(mi_heap_main(), 8);
            assert_eq!(blocks(mi_heap_main()), 0);
            mi_free(m);
            mi_free(core::ptr::null_mut());
            mi_heap_destroy(mi_heap_main()); // no-op
        }
    }
}
