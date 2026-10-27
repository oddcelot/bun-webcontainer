import { copyFileSync, mkdirSync } from "node:fs";

const files = [
  ["../../semver-wasm/target/wasm64-unknown-unknown/release/bun_semver_wasm.wasm", "bun_semver_wasm.wasm"],
  ["../../transpile-wasm/target/wasm64-unknown-unknown/release/bun_transpile_wasm.wasm", "bun_transpile_wasm.wasm"],
];
// Bun's runtime helpers, which transpiled code imports as "bun:wrap" (legacy decorators and the like). Tracked in
// src/ so the playground builds without bun/; refreshed from the pinned checkout when there is one.
try {
  copyFileSync(new URL("../../bun/src/runtime.js", import.meta.url), new URL("../src/bunWrap.js", import.meta.url));
} catch (e) {
  console.warn("copy-wasm: using existing src/bunWrap.js:", e.message);
}
mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
for (const [from, to] of files) {
  try {
    copyFileSync(new URL(from, import.meta.url), new URL(`../public/${to}`, import.meta.url));
  } catch (e) {
    console.warn(`copy-wasm: using existing public/${to}:`, e.message);
  }
}
