// Runs the wasm64 build of Bun's transpiler on corpus/* and diffs against `bun build --no-bundle`.
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const wasm = readFileSync(new URL("../../target/wasm64-unknown-unknown/release/bun_transpile_wasm.wasm", import.meta.url));
const t0 = performance.now();
const { instance } = await WebAssembly.instantiate(wasm, { env: { resolve_specifier: () => 0n } });
console.log(`instantiate ${(performance.now() - t0).toFixed(1)} ms, imports: ${WebAssembly.Module.imports(new WebAssembly.Module(wasm)).length}`);
type Wasm = { memory: WebAssembly.Memory; [fn: string]: any };
const w = instance.exports as Wasm;
const enc = new TextEncoder(), dec = new TextDecoder();
const LOADERS: Record<string, number> = { js: 0, mjs: 0, jsx: 1, ts: 2, tsx: 3 };

export function transpile(path: string, source: string) {
  const put = (s: string): [bigint, bigint] => { const b = enc.encode(s), n = BigInt(b.length), p = w.alloc(n); new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); return [p, n]; };
  const [pp, pl] = put(path), [sp, sl] = put(source);
  const out = w.transpile_c(pp, pl, sp, sl, LOADERS[path.split(".").pop()!] ?? 0);
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

// Bun.Transpiler (the playground's): `transpile_flags_c` with RUNTIME_TRANSPILER (8), `scan_c` and `scan_imports_c`,
// vs native Bun's transformSync/scan/scanImports.
function call(fn: string, path: string, source: string, flags: number) {
  const put = (s: string): [bigint, bigint] => { const b = enc.encode(s), n = BigInt(b.length), p = w.alloc(n); new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); return [p, n]; };
  const [pp, pl] = put(path), [sp, sl] = put(source);
  const out = w[fn](pp, pl, sp, sl, LOADERS[path.split(".").pop()!], flags);
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out); w.dealloc(pp, pl); w.dealloc(sp, sl);
  return status === 0n ? text : `ERR ${text}`;
}
const runtime: [string, string][] = [
  ["tsx", "import a from 'a'; import type T from 't'; const c = require('c'); import('d'); export * from 'e'; export const y = <div/>; console.log(a)"],
  ["ts", "import a from 'a'; export const q: number = 1; export default 2; export * as ns from 's'; require.resolve('r')"],
  ["jsx", "let y = 1; const z = <a b={y}>{y}</a>"],
];
if (spawnSync("bun", ["--version"]).status === 0) {
  for (const [loader, code] of runtime) {
    const r = spawnSync("bun", ["-e", "const t = new Bun.Transpiler({ loader: process.argv[1] }); const c = process.argv[2]; console.log(JSON.stringify([t.transformSync(c), t.scan(c), t.scanImports(c)]))", loader, code], { encoding: "utf8" });
    const [js, scan, imports] = JSON.parse(r.stdout);
    const path = `input.${loader}`;
    const got = [call("transpile_flags_c", path, code, 8), JSON.parse(call("scan_c", path, code, 8)), JSON.parse(call("scan_imports_c", path, code, 8))];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const ok = same(got[0], js) && same(got[1].imports, scan.imports) && same(got[1].exports, scan.exports) && same(got[2], imports);
    if (!ok) { fail++; console.log(`Bun.Transpiler ${loader}: MISMATCH\n--- wasm\n${JSON.stringify(got)}\n--- bun\n${JSON.stringify([js, scan, imports])}`); }
    else console.log(`Bun.Transpiler ${loader}: transformSync, scan and scanImports identical to bun`);
  }
}
process.exit(fail ? 1 : 0);
