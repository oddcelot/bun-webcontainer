#!/usr/bin/env bun
// The gallery's projects (the examples submodule, examples/; the default demo in examples/demo) as `bun fmt` leaves
// them, so the Format button changes nothing in a freshly opened one. Each is formatted as its own project (its own
// .gitignore and bunfig.toml, `bun fmt`'s defaults otherwise), as it is in the playground. The examples repo's own CI
// checks the same; this catches a `bun fmt` that changed with a Bun upgrade here.
//   bun scripts/fmt-examples.ts          check; exits 1 if a file needs formatting
//   bun scripts/fmt-examples.ts --write  format them (then commit in the submodule)
import { existsSync, readdirSync, statSync } from "node:fs";
import { nativeEnv } from "./native-env";

const root = new URL("../examples/", import.meta.url).pathname;
const write = process.argv.includes("--write");
let failed = false;
for (const name of readdirSync(root).sort()) {
  const dir = root + name;
  // Projects only: not the repo's scripts/, nor an entry that opens a GitHub repo (no package.json).
  if (!statSync(dir).isDirectory() || !existsSync(`${dir}/package.json`)) continue;
  const r = Bun.spawnSync(["bun", "fmt", ...(write ? [] : ["--check"]), "."], { cwd: dir, env: nativeEnv(), stdout: "pipe", stderr: "pipe" });
  const out = (r.stdout.toString() + r.stderr.toString()).trim();
  console.log(`${name}: ${out.split("\n").at(-1)}`);
  if (r.exitCode !== 0) {
    failed = true;
    if (!write) console.log(out.split("\n").slice(0, -1).map((l) => `  ${l}`).join("\n"));
  }
}
if (failed) {
  if (!write) console.log("\nRun `bun scripts/fmt-examples.ts --write` (or `moon run playground:fmt-examples -- --write`).");
  process.exit(1);
}
