// Runs the wasm64 build of `bun fmt` on this repository's files and diffs against the native `bun fmt` (node >= 24).
// Then `bun fmt --stdin-filepath` itself (run_c) over a VFS with config files, against native bun fmt in a directory
// with the same files.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VFS } from "../playground/src/vfs.ts";
import { createSysImports } from "../playground/src/worker/sysHost.ts";

const wasm = readFileSync(new URL("./target/wasm64-unknown-unknown/release/bun_fmt_wasm.wasm", import.meta.url));
const t0 = performance.now();
const vfs = new VFS();
let stdin = new Uint8Array(0);
const { instance } = await WebAssembly.instantiate(wasm, createSysImports(vfs, () => instance.exports.memory, () => stdin));
console.log(`instantiate ${(performance.now() - t0).toFixed(1)} ms, ${(wasm.length / 1e6).toFixed(1)} MB, bun ${execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()}`);
const w = instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder();
const FLAGS = { "--use-tabs": 1, "--no-semi": 2, "--single-quote": 4 };

function format(path, text, args) {
  const flags = args.reduce((f, a) => f | (FLAGS[a] ?? 0), 0);
  const width = Number(args.find((a) => a.startsWith("--print-width="))?.slice(14) ?? 0);
  const put = (s) => { const b = enc.encode(s), n = BigInt(b.length), p = w.alloc(n); new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); return [p, n]; };
  const [pp, pl] = put(path), [tp, tl] = put(text);
  const out = w.format_c(pp, pl, tp, tl, flags, width);
  const view = new DataView(w.memory.buffer);
  const status = view.getBigUint64(Number(out), true), ptr = view.getBigUint64(Number(out) + 8, true), len = view.getBigUint64(Number(out) + 16, true);
  const result = status === 0n ? dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len))) : null;
  w.output_free(out); w.dealloc(pp, pl); w.dealloc(tp, tl);
  return { status: Number(status), text: result };
}

function native(path, text, args) {
  try {
    return execFileSync("bun", ["fmt", ...args, "--stdin-filepath", path], { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

const root = new URL("../", import.meta.url);
// Every tracked text file: those bun fmt doesn't format must be refused (status 3) where the native one fails.
const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !/\.(png|ico|wasm)$/.test(f) && !/^(transpile-wasm\/corpus|patches|\.agents|\.beads|\.claude|\.codex)\//.test(f));
const RUNS = [[], ["--use-tabs", "--no-semi", "--single-quote", "--print-width=100"]];
let fail = 0, checked = 0, ms = 0;
for (const args of RUNS) {
  for (const f of files) {
    let src;
    try { src = readFileSync(new URL(f, root), "utf8"); } catch { continue; }
    const t = performance.now();
    const r = format(f, src, args);
    ms += performance.now() - t;
    const expected = native(f, src, args);
    checked++;
    if (r.text !== expected) {
      fail++;
      console.log(`${f} ${args.join(" ")}: MISMATCH (status ${r.status}, native ${expected === null ? "failed" : "formatted"})`);
    }
  }
}
console.log(`${checked - fail}/${checked} identical to bun fmt, ${ms.toFixed(0)} ms formatting`);
const before = w.memory.buffer.byteLength, big = readFileSync(new URL("playground/src/shell.ts", root), "utf8");
for (let i = 0; i < 300; i++) format("shell.ts", big, []);
console.log(`memory ${before} -> ${w.memory.buffer.byteLength} after 300 formats`);

// bun fmt --stdin-filepath over a VFS with config files.
function run(files, path, args = []) {
  vfs.clear();
  for (const [p, text] of Object.entries(files)) vfs.write(p, text);
  stdin = enc.encode(files[path] ?? "");
  const argv = enc.encode([...args, "--stdin-filepath", path].join("\0"));
  const n = BigInt(argv.length), p = w.alloc(n);
  new Uint8Array(w.memory.buffer, Number(p), argv.length).set(argv);
  const out = w.run_c(p, n, 0);
  const view = new DataView(w.memory.buffer), at = (i) => view.getBigUint64(Number(out) + 8 * i, true);
  const text = (ptr, len) => dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  const r = { exit: Number(at(0)), stdout: text(at(1), at(2)), stderr: text(at(3), at(4)) };
  w.run_output_free(out); w.dealloc(p, n);
  return r;
}
function nativeRun(files, path, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "fmt-wasm-"));
  try {
    for (const [p, text] of Object.entries(files)) mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), text);
    const r = spawnSync("bun", ["fmt", ...args, "--stdin-filepath", path], { cwd: dir, input: files[path] ?? "", encoding: "utf8" });
    // Absolute paths in messages: the directory here is the VFS root there.
    return { exit: r.status, stdout: r.stdout, stderr: r.stderr.replaceAll(realpathSync(dir), "") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const ugly = "const user = {name: 'Ada', roles: ['admin', 'editor'], active: true, created: Date.now()}\nfunction save(u) { return fetch('/api/users', {method: 'POST', body: JSON.stringify(u)}) }\n";
const SCENARIOS = {
  "bunfig.toml [fmt]": [{ "bunfig.toml": "[fmt]\nprintWidth = 40\nsemi = false\n", "a.ts": ugly }, "a.ts"],
  ".prettierrc": [{ ".prettierrc": '{ "singleQuote": true, "tabWidth": 4 }', "a.ts": ugly }, "a.ts"],
  ".prettierrc.yaml": [{ ".prettierrc.yaml": "semi: false\nbracketSpacing: false\n", "a.ts": ugly }, "a.ts"],
  ".prettierrc.toml": [{ ".prettierrc.toml": "useTabs = true\ntrailingComma = \"none\"\n", "a.ts": ugly }, "a.ts"],
  "package.json prettier, nearest wins": [{ ".prettierrc": '{ "semi": false }', "sub/package.json": '{ "prettier": { "useTabs": true } }', "sub/a.ts": ugly }, "sub/a.ts"],
  ".editorconfig": [{ ".editorconfig": "root = true\n[*.css]\nindent_style = tab\n", "s.css": "a{color:red;b{c:d}}\n" }, "s.css"],
  ".prettierignore": [{ ".prettierignore": "skip.ts\n", "skip.ts": ugly }, "skip.ts"],
  "syntax error": [{ "bad.ts": "const user = {\n  name: 'Ada'\nconst =\n" }, "bad.ts"],
  "no parser": [{ "notes.txt": "hello\n" }, "notes.txt"],
  "flags over bunfig": [{ "bunfig.toml": "[fmt]\nsemi = false\n", "a.ts": ugly }, "a.ts", ["--single-quote"]],
};
let configFail = 0;
for (const [name, [files, path, args]] of Object.entries(SCENARIOS)) {
  const got = run(files, path, args), want = nativeRun(files, path, args);
  const same = got.exit === want.exit && got.stdout === want.stdout && got.stderr === want.stderr;
  if (!same) configFail++;
  console.log(`${same ? "same" : "DIFF"}  ${name} (exit ${got.exit})`);
  if (!same) console.log({ wasm: got, native: want });
}
console.log(configFail ? `${configFail} config scenarios differ` : `all ${Object.keys(SCENARIOS).length} config scenarios match bun fmt`);
process.exit(fail || configFail ? 1 : 0);
