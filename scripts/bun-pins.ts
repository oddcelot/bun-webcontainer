#!/usr/bin/env bun
// Imported by the bun scripts. Upstream Bun commit the patch series in patches/bun/ applies to.
// scripts/bun-upgrade.ts rewrites this file (a regex replace on each `export const NAME = "…"` line); follow releases (BUN_TAG), not main.
// Run directly for a shell: `bun scripts/bun-pins.ts TOOLCHAIN` prints one value (`cargo +$(bun scripts/bun-pins.ts TOOLCHAIN)`),
// no argument prints every `NAME=value`.
export const BUN_COMMIT = "7942008688acad538e64933b82465dc614fe7536";
export const BUN_TAG = ""; // release tag BUN_COMMIT is (empty: a main commit after BUN_VERSION)
export const BUN_VERSION = "1.4.4"; // apps/playground/src/worker/bunVersion.ts
export const BUN_BRANCH = "wasm-experiment";
export const LOLHTML_COMMIT = "725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e"; // bun/scripts/build/deps/lolhtml.ts
export const ARGON2_COMMIT = "ed81866f163f0c7026aa6fd8388adf37242eb32a"; // bun/scripts/build/deps/rust-argon2.ts
export const TOOLCHAIN = "nightly-2026-09-15"; // bun/rust-toolchain.toml

if (import.meta.main) {
  const pins: Record<string, string> = { BUN_COMMIT, BUN_TAG, BUN_VERSION, BUN_BRANCH, LOLHTML_COMMIT, ARGON2_COMMIT, TOOLCHAIN };
  const [name] = process.argv.slice(2);
  if (name === undefined) {
    for (const [k, v] of Object.entries(pins)) console.log(`${k}=${v}`);
  } else if (Object.hasOwn(pins, name)) {
    console.log(pins[name]);
  } else {
    console.error(`bun-pins: unknown pin ${name} (have: ${Object.keys(pins).join(", ")})`);
    process.exit(1);
  }
}
