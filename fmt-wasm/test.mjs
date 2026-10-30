// Runs the wasm64 build of `bun fmt` on this repository's files and diffs against the native `bun fmt` (node >= 24).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const wasm = readFileSync(new URL("./target/wasm64-unknown-unknown/release/bun_fmt_wasm.wasm", import.meta.url));
const t0 = performance.now();
const { instance } = await WebAssembly.instantiate(wasm, {});
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
process.exit(fail ? 1 : 0);
