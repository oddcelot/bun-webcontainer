// Runs the wasm64 build of Bun's transpiler on corpus/* and diffs against `bun build --no-bundle`.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// tsconfig JSX options (`jsx_c`), vs `bun build --no-bundle` with that tsconfig.json and Bun.Transpiler's `tsconfig`.
function setJsx(o: Record<string, string>) {
  const b = enc.encode([o.jsx, o.jsxImportSource, o.jsxFactory, o.jsxFragmentFactory].map((s) => s ?? "").join("\0"));
  const n = BigInt(b.length), p = w.alloc(n);
  new Uint8Array(w.memory.buffer, Number(p), b.length).set(b);
  w.jsx_c(p, n); w.dealloc(p, n);
}
const jsxSrc = 'export const a = <div class="x"><>{1}</></div>';
const jsxCases: [Record<string, string>, string, string][] = [
  [{ jsx: "react-jsx", jsxImportSource: "preact" }, "a.tsx", jsxSrc],
  [{ jsx: "react-jsxdev", jsxImportSource: "preact" }, "a.tsx", jsxSrc],
  [{ jsx: "React-JSX" }, "a.jsx", jsxSrc],
  [{ jsxImportSource: "solid-js" }, "a.tsx", jsxSrc],
  [{ jsx: "react-jsx", jsxImportSource: "hono/jsx" }, "a.tsx", jsxSrc],
  [{ jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment" }, "a.tsx", jsxSrc],
  [{ jsx: "react" }, "a.jsx", jsxSrc],
  [{ jsxFactory: "Preact.h" }, "a.tsx", jsxSrc],
  [{ jsx: "preserve" }, "a.tsx", jsxSrc],
  // Per-file pragmas win over tsconfig.
  [{ jsx: "react-jsx", jsxImportSource: "preact" }, "p.tsx", `/** @jsxImportSource foo */\n${jsxSrc}`],
  [{ jsx: "react", jsxFactory: "h" }, "r.tsx", `/** @jsxRuntime automatic */\n${jsxSrc}`],
  [{ jsx: "react", jsxFactory: "h" }, "s.tsx", `/** @jsx React.createElement */\n${jsxSrc}`],
];
if (spawnSync("bun", ["--version"]).status === 0) {
  const tmp = mkdtempSync(join(tmpdir(), "transpile-wasm-jsx-"));
  try {
    for (const [opts, file, code] of jsxCases) {
      const label = `tsconfig ${JSON.stringify(opts)} ${file}`;
      writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: opts }));
      writeFileSync(join(tmp, file), code);
      const expected = spawnSync("bun", ["build", "--no-bundle", file], { cwd: tmp, encoding: "utf8" }).stdout;
      setJsx(opts);
      const r = transpile(file, code);
      const ext = file.split(".").pop()!;
      const rt = spawnSync("bun", ["-e", "console.log(JSON.stringify(new Bun.Transpiler({ loader: process.argv[1], tsconfig: JSON.parse(process.argv[2]) }).transformSync(process.argv[3])))", ext, JSON.stringify({ compilerOptions: opts }), code], { encoding: "utf8" });
      const gotRt = call("transpile_flags_c", `input.${ext}`, code, 8);
      setJsx({});
      if (!r.ok || r.text.trim() !== expected.trim()) { fail++; console.log(`${label}: MISMATCH\n--- wasm\n${r.text}\n--- bun\n${expected}`); }
      else if (gotRt !== JSON.parse(rt.stdout)) { fail++; console.log(`${label} Bun.Transpiler: MISMATCH\n--- wasm\n${gotRt}\n--- bun\n${JSON.parse(rt.stdout)}`); }
      else console.log(`${label}: identical to bun build --no-bundle and Bun.Transpiler`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
process.exit(fail ? 1 : 0);
