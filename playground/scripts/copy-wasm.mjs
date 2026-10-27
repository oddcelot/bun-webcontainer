import { copyFileSync, mkdirSync } from "node:fs";

const files = [
  ["../../semver-wasm/target/wasm64-unknown-unknown/release/bun_semver_wasm.wasm", "bun_semver_wasm.wasm"],
  ["../../transpile-wasm/target/wasm64-unknown-unknown/release/bun_transpile_wasm.wasm", "bun_transpile_wasm.wasm"],
];
mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
for (const [from, to] of files) {
  try {
    copyFileSync(new URL(from, import.meta.url), new URL(`../public/${to}`, import.meta.url));
  } catch (e) {
    console.warn(`copy-wasm: using existing public/${to}:`, e.message);
  }
}
