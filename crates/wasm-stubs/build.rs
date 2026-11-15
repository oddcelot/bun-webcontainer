fn main() {
    println!("cargo::rustc-check-cfg=cfg(bun_sema_mimalloc)");
    // On wasm the allocator is bun_mimalloc_sys's Rust shim, so sema's fake mimalloc must step aside.
    if std::env::var("CARGO_CFG_TARGET_FAMILY").as_deref() == Ok("wasm") {
        println!("cargo::rustc-cfg=bun_sema_mimalloc");
        string_width_tables();
    }
}

/// `src/string_width.rs`'s codepoint tables: the three arrays of Bun's `stringWidthTables.h` (generated upstream from
/// the Unicode database), parsed into Rust statics in OUT_DIR so a Unicode bump in `bun/` needs no hand copy.
fn string_width_tables() {
    use std::fmt::Write as _;

    let header = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../bun/src/jsc/bindings/stringWidthTables.h");
    println!("cargo::rerun-if-changed={}", header.display());
    let text = std::fs::read_to_string(&header).unwrap_or_else(|e| panic!("{}: {e}", header.display()));

    let mut out = String::new();
    for (name, ty) in [("Stage1", "u16"), ("Stage2", "u8"), ("Stage3", "u8")] {
        // `static constexpr uint16_t kGraphemeBreakStage1[8192] = { 0, 256, ... };`
        let decl = format!("kGraphemeBreak{name}[");
        let at = text.find(&decl).unwrap_or_else(|| panic!("stringWidthTables.h: no {decl}"));
        let rest = &text[at + decl.len()..];
        let (len, rest) = rest.split_once(']').expect("array length");
        let len: usize = len.trim().parse().unwrap_or_else(|_| panic!("stringWidthTables.h: bad length of {name}"));
        let (_, rest) = rest.split_once('{').expect("array body");
        let (body, _) = rest.split_once('}').expect("array end");
        let values: Vec<u32> = body
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.parse().unwrap_or_else(|_| panic!("stringWidthTables.h: bad number {s:?} in {name}")))
            .collect();
        assert_eq!(values.len(), len, "stringWidthTables.h: {name} declares {len} entries, has {}", values.len());
        let max = if ty == "u16" { u16::MAX as u32 } else { u8::MAX as u32 };
        assert!(values.iter().all(|&v| v <= max), "stringWidthTables.h: {name} value over {ty}");
        let upper = name.to_uppercase();
        write!(out, "pub static {upper}: [{ty}; {len}] = [").unwrap();
        for v in &values {
            write!(out, "{v},").unwrap();
        }
        out.push_str("];\n");
    }
    let dest = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("string_width_tables.rs");
    std::fs::write(dest, out).unwrap();
}
