fn main() {
    println!("cargo::rustc-check-cfg=cfg(bun_sema_mimalloc)");
    // On wasm the allocator is bun_mimalloc_sys's Rust shim, so sema's fake mimalloc must step aside.
    if std::env::var("CARGO_CFG_TARGET_FAMILY").as_deref() == Ok("wasm") {
        println!("cargo::rustc-cfg=bun_sema_mimalloc");
    }
}
