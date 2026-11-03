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
// IMPORT_META_REQUIRE (16): a free `require` gets Bun's `var {require}=import.meta;` (`--target=bun`); a bound one doesn't.
const requireCases: [string, string][] = [
  ["free.js", 'import a from "a";\nconst b = require("b");\nconst n = "c";\nrequire(n);\nexport { a, b };\n'],
  ["bound.js", 'import { createRequire } from "module";\nconst require = createRequire(import.meta.url);\nexport const b = require("b");\n'],
  ["param.ts", "export function f(require: (id: string) => unknown) {\n  return require(\"x\");\n}\n"],
];
if (spawnSync("bun", ["--version"]).status === 0) {
  const tmp = mkdtempSync(join(tmpdir(), "transpile-wasm-require-"));
  try {
    for (const [file, code] of requireCases) {
      writeFileSync(join(tmp, file), code);
      const expected = spawnSync("bun", ["build", "--no-bundle", "--target=bun", file], { cwd: tmp, encoding: "utf8" }).stdout;
      const got = call("transpile_flags_c", file, code, 16);
      if (got.trim() !== expected.trim()) { fail++; console.log(`require ${file}: MISMATCH\n--- wasm\n${got}\n--- bun\n${expected}`); }
      else console.log(`require ${file}: identical to bun build --no-bundle --target=bun`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Bun.Transpiler's options (`options_c` and the option flags, encoded by the playground's transpiler/options.ts) and
// per-call data loaders, vs native Bun's transformSync and scan.
import { runtimeOptions, FLAGS, LOADER_NUMBERS } from "../../apps/playground/src/transpiler/options.ts";
function setOptions(bytes: Uint8Array): string | null {
  const n = BigInt(bytes.length), p = w.alloc(n);
  new Uint8Array(w.memory.buffer, Number(p), bytes.length).set(bytes);
  const out = w.options_c(p, n);
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out); w.dealloc(p, n);
  return status === 0n ? null : text;
}
function runtimeCall(fn: string, loader: string, source: string, flags: number) {
  const put = (s: string): [bigint, bigint] => { const b = enc.encode(s), n = BigInt(b.length), p = w.alloc(n); new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); return [p, n]; };
  const [pp, pl] = put(`input.${loader}`), [sp, sl] = put(source);
  const out = w[fn](pp, pl, sp, sl, LOADER_NUMBERS[loader], flags | FLAGS.RUNTIME_TRANSPILER | 4);
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out); w.dealloc(pp, pl); w.dealloc(sp, sl);
  return status === 0n ? text : `ERR ${(JSON.parse(text).diagnostics as { text: string }[]).map((d) => d.text).join("\n")}`;
}
const optSrc = `import { a, b } from "a"; import d from "d"; import * as ns from "ns"; import type { T } from "t"; import "side";
export const x = 1, y = 2; export function f() { return a; } export default class C {}
const unused = 3; function g() {} if (false) { console.log("dead") }
const e = { k: 1 }; console.log(1 + 2, "a" + "b", !true, typeof x === "undefined", e.k, x);
enum E { A = 1, B = A * 2 } console.log(E.B);
const long_name = 5; console.log(long_name);`;
const defSrc = `console.log(process.env.NODE_ENV, process.env.BUN_ENV, process.browser, DEBUG, FOO.bar, a.b.c, X);
if (process.env.NODE_ENV === "production") console.log("prod"); else console.log("dev");
Math.PI; foo(); export const el = <div x={1}>{2}</div>;`;
// [label, Bun.Transpiler options, loader (per call), code, NODE_ENV]
const optionCases: [string, Record<string, unknown>, string, string, string?][] = [
  ["defaults", {}, "tsx", defSrc],
  ["NODE_ENV=production", {}, "tsx", defSrc, "production"],
  ["NODE_ENV=staging", {}, "tsx", defSrc, "staging"],
  ["define", { define: { DEBUG: "false", "FOO.bar": '{"x":[1,"y"]}', "a.b.c": "globalThis.zz", X: "hello world", "process.env.NODE_ENV": '"production"' } }, "tsx", defSrc],
  ["define development", { define: { "process.env.NODE_ENV": '"development"' } }, "tsx", defSrc, "production"],
  ["define values", { define: { DEBUG: "", X: "undefined", "FOO.bar": "null", "a.b.c": "-1.5" } }, "tsx", defSrc],
  ["target node", { target: "node" }, "tsx", defSrc],
  ["define + tsconfig jsx", { define: { "process.env.NODE_ENV": '"production"' }, tsconfig: { compilerOptions: { jsx: "react-jsxdev" } } }, "tsx", defSrc],
  ["define bad JSON", { define: { X: "{bad" } }, "tsx", defSrc],
  ["none", {}, "ts", optSrc],
  ["trimUnusedImports", { trimUnusedImports: true }, "ts", optSrc],
  ["minifyWhitespace", { minifyWhitespace: true }, "ts", optSrc],
  ["minify", { minify: true }, "ts", optSrc],
  ["minify.syntax", { minify: { syntax: true } }, "ts", optSrc],
  ["minify.identifiers", { minify: { identifiers: true } }, "ts", optSrc],
  ["inline", { inline: true }, "ts", optSrc],
  ["deadCodeElimination false", { deadCodeElimination: false }, "ts", optSrc],
  ["treeShaking", { treeShaking: true }, "ts", optSrc],
  ["exports.eliminate", { exports: { eliminate: ["f", "x"] } }, "ts", optSrc],
  ["exports.replace", { exports: { replace: { y: 42, f: "hello", C: true, x: null } } }, "ts", optSrc],
  ["exports.replace inject", { exports: { replace: { f: ["g2", 1.5] } } }, "ts", optSrc],
  ["exports + treeShaking false", { exports: { eliminate: ["f"] }, treeShaking: false }, "ts", optSrc],
  ["json", {}, "json", '{"a": 1, "b-c": [true, null, "x"], "default": 2, "a": 3}'],
  ["json array", {}, "json", "[1, 2]"],
  ["json empty", {}, "json", "  \n"],
  ["json error", {}, "json", "{bad"],
  ["jsonc", {}, "jsonc", '{"a": 1, // c\n "b": 2,}'],
  ["json5", {}, "json5", "{a: 1, 'b': 0x10, c: Infinity,}"],
  ["toml", {}, "toml", 'a = 1\n[s]\nx = "y"\nd = 1979-05-27T07:32:00Z'],
  ["yaml", {}, "yaml", "a: 1\nlist:\n  - x\n  - y\n"],
  ["xml", {}, "xml", "<a>1</a>"],
  ["text", {}, "text", 'hello "world"\n`x`'],
  ["text empty", {}, "text", ""],
];
if (spawnSync("bun", ["--version"]).status === 0) {
  const native = (c: (typeof optionCases)[number]) => {
    const env = { ...process.env };
    delete env.NODE_ENV;
    if (c[4]) env.NODE_ENV = c[4];
    const script = `const [o, l, c] = JSON.parse(process.argv[1]); const r = [];
      for (const f of [(t) => t.transformSync(c, l), (t) => t.scan(c, l)]) { try { r.push(f(new Bun.Transpiler({ ...o, loader: ["js","jsx","ts","tsx"].includes(l) ? l : "js" }))); } catch (e) { r.push("ERR " + (e.errors ? e.errors.map((x) => x.message).join("\\n") : e.message)); } }
      console.log(JSON.stringify(r));`;
    const r = spawnSync("bun", ["-e", script, JSON.stringify([c[1], c[2], c[3]])], { encoding: "utf8", env });
    return JSON.parse(r.stdout) as [string, unknown];
  };
  for (const c of optionCases) {
    const [label, opts, loader, code, nodeEnv] = c;
    const [js, scan] = native(c);
    const { flags, options } = runtimeOptions(opts, nodeEnv);
    const tsconfig = (opts.tsconfig as { compilerOptions?: Record<string, string> } | undefined)?.compilerOptions ?? {};
    setJsx(tsconfig);
    const err = setOptions(options);
    const got = err ? [`ERR ${(JSON.parse(err).diagnostics as { text: string }[]).map((d) => d.text).join("\n")}`, null] : [runtimeCall("transpile_flags_c", loader, code, flags), runtimeCall("scan_c", loader, code, flags)];
    setOptions(new Uint8Array()); setJsx({});
    const norm = (s: unknown) => (s && typeof s === "object" ? JSON.stringify({ imports: (s as any).imports, exports: (s as any).exports }) : JSON.stringify(s));
    const gotScan = typeof got[1] === "string" && !got[1].startsWith("ERR") ? JSON.parse(got[1]) : got[1];
    const ok = err ? js.startsWith("ERR") && got[0] === js : got[0] === js && norm(gotScan) === norm(scan);
    if (!ok) { fail++; console.log(`Bun.Transpiler ${label}: MISMATCH\n--- wasm\n${got[0]}\n${JSON.stringify(gotScan)}\n--- bun\n${js}\n${JSON.stringify(scan)}`); }
    else console.log(`Bun.Transpiler ${label}: identical to bun`);
  }
}
process.exit(fail ? 1 : 0);
