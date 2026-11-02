// Runs the wasm64 build of Bun's transpiler on corpus/* and diffs against `bun build --no-bundle`.
import { readFileSync, readdirSync } from "node:fs";

const wasm = readFileSync(new URL("../../target/wasm64-unknown-unknown/release/bun_transpile_wasm.wasm", import.meta.url));
const t0 = performance.now();
const { instance } = await WebAssembly.instantiate(wasm, { env: { resolve_specifier: () => 0n } });
console.log(`instantiate ${(performance.now() - t0).toFixed(1)} ms, imports: ${WebAssembly.Module.imports(new WebAssembly.Module(wasm)).length}`);
const w = instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder();
const LOADERS = { js: 0, mjs: 0, jsx: 1, ts: 2, tsx: 3 };

export function transpile(path, source) {
  const put = (s) => { const b = enc.encode(s), n = BigInt(b.length), p = w.alloc(n); new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); return [p, n]; };
  const [pp, pl] = put(path), [sp, sl] = put(source);
  const out = w.transpile_c(pp, pl, sp, sl, LOADERS[path.split(".").pop()] ?? 0);
  const view = new DataView(w.memory.buffer);
  const status = view.getBigUint64(Number(out), true), ptr = view.getBigUint64(Number(out) + 8, true), len = view.getBigUint64(Number(out) + 16, true);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out); w.dealloc(pp, pl); w.dealloc(sp, sl);
  return { ok: status === 0n, text };
}

const dir = new URL("./corpus/", import.meta.url);
let fail = 0;
for (const f of readdirSync(dir).filter((f) => !f.endsWith(".expected"))) {
  const src = readFileSync(new URL(f, dir), "utf8");
  const t = performance.now();
  const r = transpile(f, src);
  const ms = (performance.now() - t).toFixed(2);
  let expected;
  try { expected = readFileSync(new URL(f + ".expected", dir), "utf8"); } catch {}
  if (expected === undefined) { console.log(`${f}: ${r.ok ? "ok" : "error"} (${ms} ms)\n${r.text}`); continue; }
  const same = r.ok && r.text.trim() === expected.trim();
  if (!same) { fail++; console.log(`${f}: MISMATCH\n--- wasm\n${r.text}\n--- bun\n${expected}`); }
  else console.log(`${f}: identical to bun build --no-bundle (${ms} ms)`);
}
const before = w.memory.buffer.byteLength, big = readFileSync(new URL("app.tsx", dir), "utf8");
for (let i = 0; i < 2000; i++) transpile("app.tsx", big);
console.log(`memory ${before} -> ${w.memory.buffer.byteLength} after 2000 transpiles`);
process.exit(fail ? 1 : 0);
