#!/usr/bin/env bun
// Recreates bun/: the pinned upstream commit with patches/bun/ applied as commits on the
// wasm-experiment branch, plus the vendored crates and generated files the wasm builds need.
// Usage: scripts/setup-bun.ts [dir]   (default: ./bun)
import { $ } from "bun";
import { existsSync, globSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUN_BRANCH, BUN_COMMIT } from "./bun-pins.ts";

const root = resolve(import.meta.dir, "..");
const dir = process.argv[2] ?? join(root, "bun");

if (existsSync(dir)) {
  console.error(`setup-bun: ${dir} already exists; remove it first`);
  process.exit(1);
}

await $`git init -q ${dir}`;
await $`git -C ${dir} remote add origin https://github.com/oven-sh/bun.git`;
await $`git -C ${dir} fetch -q --depth 1 origin ${BUN_COMMIT}`;
await $`git -C ${dir} checkout -q -b ${BUN_BRANCH} FETCH_HEAD`;
// Keep the series' authors and dates; fall back to a placeholder committer if git has no identity.
const name = (await $`git config user.name`.quiet().nothrow().text()).trim() || "setup-bun";
const email = (await $`git config user.email`.quiet().nothrow().text()).trim() || "setup-bun@localhost";
const patches = globSync("patches/bun/*.patch", { cwd: root }).sort().map((p) => join(root, p));
await $`git -C ${dir} -c user.name=${name} -c user.email=${email} am -q --committer-date-is-author-date ${patches}`;

await $`${join(root, "scripts/bun-prepare.ts")} ${dir}`;

console.log(`setup-bun: ready at ${dir} (${BUN_BRANCH} = upstream ${BUN_COMMIT} + ${patches.length} patches)`);
