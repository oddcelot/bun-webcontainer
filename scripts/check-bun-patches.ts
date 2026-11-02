#!/usr/bin/env bun
// Fails when bun/ has changes that patches/bun/ doesn't record. No-op without a bun/ checkout.
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUN_BRANCH } from "./bun-pins.ts";

// A hook inherits the outer commit's git environment (`commit -a` sets GIT_INDEX_FILE to a temp index); bun/ is its own repo.
const env = { ...process.env };
for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX"]) delete env[k];
$.env(env);

const root = resolve(import.meta.dir, "..");
const bun = join(root, "bun");
if (!existsSync(join(bun, ".git"))) process.exit(0);

const status = (await $`git -C ${bun} status --porcelain --untracked-files=normal -- src`.text()).trim();
if (status) {
  console.error(`check-bun-patches: bun/src has uncommitted changes. Commit them on ${BUN_BRANCH}, then run scripts/export-bun-patches.ts`);
  console.error((await $`git -C ${bun} status --short -- src`.text()).split("\n").slice(0, 10).join("\n").trim());
  process.exit(1);
}

const tmp = await mkdtemp(join(tmpdir(), "check-bun-patches-"));
try {
  await $`${join(root, "scripts/export-bun-patches.ts")} ${tmp}`.quiet();
  const diff = await $`diff -rq ${tmp} ${join(root, "patches/bun")}`.quiet().nothrow();
  if (diff.exitCode !== 0) {
    console.error(`check-bun-patches: patches/bun/ is out of date with bun/'s ${BUN_BRANCH} branch. Run scripts/export-bun-patches.ts`);
    console.error(diff.stdout.toString().trimEnd());
    console.error(diff.stderr.toString().trimEnd());
    process.exit(1);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
