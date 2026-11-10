// Runs the probe under node's WASI with a temp dir preopened as /repo, then checks the repo with native git.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";

const dir = process.env.PROBE_OPEN ?? mkdtempSync(join(tmpdir(), "gix-probe-"));
const wasi = new WASI({ version: "preview1", env: Object.fromEntries(["PROBE_NO_UNTRACKED", "PROBE_OPEN"].filter((k) => process.env[k]).map((k) => [k, "1"])), preopens: { "/repo": dir }, returnOnExit: true });
const wasm = await WebAssembly.compile(readFileSync(new URL("target/wasm32-wasip1/release/gix-probe.wasm", import.meta.url)));
const instance = await WebAssembly.instantiate(wasm, wasi.getImportObject() as WebAssembly.Imports);
const t = performance.now();
const code = wasi.start(instance);
console.log(`exit ${code} in ${(performance.now() - t).toFixed(0)} ms; native git on ${dir}:`);
for (const args of [["log", "--oneline"], ["status", "--short"], ["fsck", "--full"]])
  console.log(`$ git ${args.join(" ")}\n${execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })}`);
