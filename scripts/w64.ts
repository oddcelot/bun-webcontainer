#!/usr/bin/env bun
// Build crates for wasm64 and summarize errors. Usage: scripts/w64.ts [crate...]   (N=<lines> caps the error lines, default 60)
import { $ } from "bun";
import { join, resolve } from "node:path";
import { TOOLCHAIN } from "./bun-pins.ts";

const crates = process.argv.length > 2 ? process.argv.slice(2) : ["bun_semver"];
const pkgs = crates.flatMap((c) => ["-p", c]);
const build = await $`cargo +${TOOLCHAIN} build ${pkgs} -Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --message-format=short`
  .cwd(join(resolve(import.meta.dir, ".."), "bun"))
  .quiet()
  .nothrow();
const log = build.stdout.toString() + build.stderr.toString();
await Bun.write("/tmp/w64.log", log);
const lines = log.split("\n");
const errors = lines.filter((l) => /(error|warning)(\[|:)/.test(l) && !l.startsWith("warning: build failed"));
const n = Number(process.env.N ?? 60);
for (const l of errors.slice(0, n)) console.log(l);
for (const l of lines) if (/could not compile|Finished/.test(l)) console.log(l);
process.exit(build.exitCode);
