import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const files = [
  ["../../../target/wasm64-unknown-unknown/release/bun_semver_wasm.wasm", "bun_semver_wasm.wasm"],
  ["../../../target/wasm64-unknown-unknown/release/bun_compress_wasm.wasm", "bun_compress_wasm.wasm"],
  ["../../../target/wasm64-unknown-unknown/release/bun_transpile_wasm.wasm", "bun_transpile_wasm.wasm"],
  ["../../../target/wasm64-unknown-unknown/release/bun_bundle_wasm.wasm", "bun_bundle_wasm.wasm"],
  ["../../../target/wasm64-unknown-unknown/release/bun_resolve_wasm.wasm", "bun_resolve_wasm.wasm"],
  ["../../../target/wasm64-unknown-unknown/release/bun_fmt_wasm.wasm", "bun_fmt_wasm.wasm"],
  ["../../../target/wasm64-unknown-unknown/release/bun_check_wasm.wasm", "bun_check_wasm.wasm"],
  ["../../../crates/tsrs-ls-wasm/target/wasm32-wasip1/release/tsrs_ls_wasm.wasm", "tsrs_ls_wasm.wasm"],
  ["../../../crates/git-wasm/target/wasm32-wasip1/release/git.wasm", "git.wasm"],
  ["../../../target/wasm64-unknown-unknown/release/bun_shell_wasm.wasm", "bun_shell_wasm.wasm"],
  ["../../../target/wasm64-unknown-unknown/release/bun_htmlrewriter_wasm.wasm", "bun_htmlrewriter_wasm.wasm"],
  ["../../../target/wasm64-unknown-unknown/release/bun_crypto_wasm.wasm", "bun_crypto_wasm.wasm"],
];

// `--strip` (prebuild) drops the custom sections: mostly "name", the Rust function names that only make stack traces
// readable, about a fifth of each file. Dev keeps them, so panics there still show where they came from.
const strip = process.argv.includes("--strip");

/** The module without its custom sections (id 0); every other section is copied byte for byte. */
function stripCustomSections(bytes: Uint8Array): Buffer {
  const keep = [bytes.subarray(0, 8)]; // magic + version
  let at = 8;
  while (at < bytes.length) {
    const start = at;
    const id = bytes[at++];
    let size = 0;
    for (let shift = 0; ; shift += 7) {
      const b = bytes[at++];
      size += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) break;
    }
    at += size;
    if (at > bytes.length) throw new Error("truncated section");
    if (id !== 0) keep.push(bytes.subarray(start, at));
  }
  return Buffer.concat(keep);
}

// Bun's runtime helpers, which transpiled code imports as "bun:wrap" (legacy decorators and the like). Tracked in
// src/ so the playground builds without bun/; refreshed from the pinned checkout when there is one. Bun adds the
// `using` helpers (__using, __callDispose) per target from src/bundler/ParseTask.rs; the browser gets the non-Bun
// variant, which falls back to Symbol.for() and its own SuppressedError where the engine has none.
try {
  const runtime = readFileSync(new URL("../../../bun/src/runtime.js", import.meta.url), "utf8");
  const parseTask = readFileSync(new URL("../../../bun/src/bundler/ParseTask.rs", import.meta.url), "utf8");
  const tail = /const RUNTIME_USING_OTHER: &str = "\\\n([\s\S]*?)\n";\n/.exec(parseTask)?.[1];
  if (!tail) throw new Error("RUNTIME_USING_OTHER not found in bun/src/bundler/ParseTask.rs");
  writeFileSync(new URL("../src/bunWrap.js", import.meta.url), `${runtime.trimEnd()}\n\n${tail.replaceAll('\\"', '"')}\n`);
} catch (e) {
  console.warn("copy-wasm: using existing src/bunWrap.js:", (e as Error).message);
}
mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
for (const [from, to] of files) {
  const dest = new URL(`../public/${to}`, import.meta.url);
  try {
    if (strip) writeFileSync(dest, stripCustomSections(readFileSync(new URL(from, import.meta.url))));
    else copyFileSync(new URL(from, import.meta.url), dest);
  } catch (e) {
    console.warn(`copy-wasm: using existing public/${to}:`, (e as Error).message);
  }
}
