// Asserts the structured diagnostics (flag bit 4 of transpile_flags_c) for syntax errors.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const wasm = readFileSync(new URL("../../target/wasm64-unknown-unknown/release/bun_transpile_wasm.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, { env: { resolve_specifier: () => 0n } });
type Wasm = { memory: WebAssembly.Memory; [fn: string]: any };
const w = instance.exports as Wasm;
const enc = new TextEncoder(), dec = new TextDecoder();
const LOADERS: Record<string, number> = { js: 0, jsx: 1, ts: 2, tsx: 3 };

function run(path: string, source: string, flags: number) {
  const put = (s: string): [bigint, bigint] => { const b = enc.encode(s), n = BigInt(b.length), p = w.alloc(n); new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); return [p, n]; };
  const [pp, pl] = put(path), [sp, sl] = put(source);
  const out = w.transpile_flags_c(pp, pl, sp, sl, LOADERS[path.split(".").pop()!], flags);
  const v = new DataView(w.memory.buffer);
  const status = v.getBigUint64(Number(out), true), ptr = Number(v.getBigUint64(Number(out) + 8, true)), len = Number(v.getBigUint64(Number(out) + 16, true));
  const text = dec.decode(new Uint8Array(w.memory.buffer, ptr, len));
  w.output_free(out); w.dealloc(pp, pl); w.dealloc(sp, sl);
  return { status, text };
}
const diag = (path: string, src: string) => {
  const r = run(path, src, 4);
  assert.equal(r.status, 1n);
  return JSON.parse(r.text).diagnostics;
};

// corpus/broken.ts: `const x: = 5;`
const broken = readFileSync(new URL("./corpus/broken.ts", import.meta.url), "utf8");
const d = diag("broken.ts", broken);
console.log(JSON.stringify(d));
assert.equal(d.length, 1);
assert.equal(d[0].severity, "error");
assert.equal(d[0].line, 1);
assert.equal(d[0].column, 10); // 1-based byte column of `=`
assert.equal(d[0].length, 1);
assert.ok(d[0].text.length > 0);
assert.deepEqual(d[0].notes, []);

// TSX, second line, multibyte text before the error (column/length count bytes, 1-based column), quotes/newlines escaped.
const tsx = 'const s = "é\\"x";\nconst a = <div>{</div>;\n';
const t = diag("a.tsx", tsx);
console.log(JSON.stringify(t));
assert.ok(t.length >= 1 && t.every((m: { severity: string; line: number; column: number }) => m.severity === "error" && m.line === 2 && m.column >= 1));

// Without the flag, text output is unchanged; success is unaffected by the flag.
assert.equal(run("broken.ts", broken, 0).text.trim(), d[0].text);
const first = diag("f.ts", "= 1;");
assert.equal(first[0].column, 1);
assert.equal(run("ok.ts", "const x: number = 5;", 4).status, 0n);
console.log("diag-test ok");
