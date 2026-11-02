#!/usr/bin/env bun
// Writes the commits on bun/'s wasm-experiment branch to patches/bun/ as a patch series.
// Usage: scripts/export-bun-patches.ts [out-dir]   (default: patches/bun)
import { $ } from "bun";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BUN_BRANCH, BUN_COMMIT } from "./bun-pins.ts";

const root = resolve(import.meta.dir, "..");
const out = process.argv[2] ?? join(root, "patches/bun");
const bun = join(root, "bun");

const dirty = (await $`git -C ${bun} status --porcelain --untracked-files=no`.text()).trim();
if (dirty) {
  console.error(`export-bun-patches: bun/ has uncommitted changes; commit them on ${BUN_BRANCH} first`);
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// --no-numbered, --zero-commit and --no-signature keep each file byte-identical unless its own commit changed.
await $`git -C ${bun} format-patch -q --no-numbered --zero-commit --no-signature -o ${out} ${`${BUN_COMMIT}..${BUN_BRANCH}`}`;
for (const f of (await readdir(out)).sort()) console.log(f);
