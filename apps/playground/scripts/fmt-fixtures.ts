#!/usr/bin/env bun
// The bundled examples (fixtures/*, the default demo in fixtures/demo) as `bun fmt` leaves them, so the Format button
// changes nothing in a freshly opened one. Each fixture is formatted as its own project (its own .gitignore and
// bunfig.toml, `bun fmt`'s defaults otherwise), as it is in the playground.
//   bun scripts/fmt-fixtures.ts          check; exits 1 if a file needs formatting
//   bun scripts/fmt-fixtures.ts --write  format them
import { readdirSync, statSync } from "node:fs";

const root = new URL("../fixtures/", import.meta.url).pathname;
const write = process.argv.includes("--write");
let failed = false;
for (const name of readdirSync(root).sort()) {
  const dir = root + name;
  if (!statSync(dir).isDirectory()) continue;
  const r = Bun.spawnSync(["bun", "fmt", ...(write ? [] : ["--check"]), "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const out = (r.stdout.toString() + r.stderr.toString()).trim();
  console.log(`${name}: ${out.split("\n").at(-1)}`);
  if (r.exitCode !== 0) {
    failed = true;
    if (!write) console.log(out.split("\n").slice(0, -1).map((l) => `  ${l}`).join("\n"));
  }
}
if (failed) {
  if (!write) console.log("\nRun `bun scripts/fmt-fixtures.ts --write` (or `moon run playground:fmt-fixtures -- --write`).");
  process.exit(1);
}
