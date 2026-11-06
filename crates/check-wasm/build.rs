//! TypeScript's `lib.*.d.ts` files for `bun check`, from the pinned Bun's `typescript_libs.bin` (the format is in
//! bun/src/cli/typescript_libs.rs). Bun compresses each with zstd, two of them as the prefix of the others; zstd's C
//! library isn't linked on wasm, so they are decompressed here, on the host, and deflated one by one for src/libs.rs.
//!
//! `OUT_DIR/libs.bin`: the number of files as a `u32`, then per file the length of its name as a `u8`, the name, and
//! the length of its deflated text as a `u32`, then the deflated texts in that order. Numbers are little-endian.

use std::path::{Path, PathBuf};

const NAME_LEN: usize = 39;
const RECORD_LEN: usize = 1 + NAME_LEN + 4 + 4 + 4;
const DICTIONARIES: [&[u8]; 2] = [b"lib.es5.d.ts", b"lib.dom.d.ts"];

fn number(bytes: &[u8]) -> usize {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize
}

fn decompress(frame: &[u8], prefix: Option<&[u8]>) -> Vec<u8> {
    let mut dctx = zstd::zstd_safe::DCtx::create();
    if let Some(prefix) = prefix {
        dctx.ref_prefix(prefix).expect("zstd prefix");
    }
    let size = zstd::zstd_safe::get_frame_content_size(frame).ok().flatten().expect("zstd frame size") as usize;
    let mut out = Vec::with_capacity(size);
    dctx.decompress(&mut out, frame).expect("zstd frame");
    out
}

/// The module's shadow stack, first in linear memory: the stack bun_sema_driver gives `bun check`'s pool threads
/// (`WORKER_STACK_SIZE`, 32 MB). The checker refuses a task with less than 3 MB left, and wasm's default is 1 MB.
const STACK_SIZE: u64 = 32 << 20;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_FAMILY").unwrap_or_default().split(',').any(|f| f == "wasm") {
        println!("cargo::rustc-cdylib-link-arg=-zstack-size={STACK_SIZE}");
    }
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    // Moved to src/runtime/cli/ on Bun's main; src/cli/ in 1.4.
    let bun = manifest.join("../../bun/src");
    let bin: PathBuf = ["runtime/cli/typescript_libs.bin", "cli/typescript_libs.bin"]
        .iter()
        .map(|it| bun.join(it))
        .find(|it| it.exists())
        .expect("typescript_libs.bin in bun/src (run scripts/setup-bun.ts)");
    println!("cargo::rerun-if-changed={}", bin.display());
    let bundle = std::fs::read(&bin).unwrap();

    let records: Vec<&[u8]> = (0..number(&bundle)).map(|i| &bundle[4 + i * RECORD_LEN..][..RECORD_LEN]).collect();
    let name = |record: &[u8]| record[1..][..record[0] as usize].to_vec();
    let frame = |record: &[u8]| {
        let place = &record[1 + NAME_LEN..];
        (&bundle[number(place)..][..number(&place[4..])], number(&place[8..]))
    };
    let dictionaries: Vec<Vec<u8>> = DICTIONARIES
        .iter()
        .map(|it| decompress(frame(records.iter().find(|r| name(r) == *it).unwrap()).0, None))
        .collect();

    let mut index = (records.len() as u32).to_le_bytes().to_vec();
    let mut texts = Vec::new();
    for record in &records {
        let (frame, of) = frame(record);
        let text = match of {
            0 => decompress(frame, None),
            n => decompress(frame, Some(&dictionaries[n - 1])),
        };
        let deflated = miniz_oxide::deflate::compress_to_vec(&text, 9);
        let name = name(record);
        index.push(name.len() as u8);
        index.extend_from_slice(&name);
        index.extend_from_slice(&(deflated.len() as u32).to_le_bytes());
        texts.extend_from_slice(&deflated);
    }
    index.extend_from_slice(&texts);
    let out = Path::new(&std::env::var_os("OUT_DIR").unwrap()).join("libs.bin");
    std::fs::write(out, index).unwrap();
}
