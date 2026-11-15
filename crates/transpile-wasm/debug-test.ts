// DEBUG (131072): the step debugger's probes. Transpiles a sample with them, runs it with a recording `__dbg`, and
// checks that every statement is probed once in order, that each probe's scoped eval reads the locals the table names,
// and that the plain output is unchanged by the flag's code path.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const wasm = readFileSync(new URL("../../target/wasm64-unknown-unknown/release/bun_transpile_wasm.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, { env: { resolve_specifier: () => 0n } });
const w = instance.exports as { memory: WebAssembly.Memory; [fn: string]: any };
const enc = new TextEncoder(), dec = new TextDecoder();
const DEBUG = 131072, SOURCE_MAP = 32768, TS = 2;

function transpile(path: string, source: string, flags: number) {
  const put = (s: string): [bigint, bigint] => { const b = enc.encode(s), n = BigInt(b.length), p = w.alloc(n); new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); return [p, n]; };
  const [pp, pl] = put(path), [sp, sl] = put(source);
  const out = w.transpile_flags_c(pp, pl, sp, sl, TS, flags);
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out); w.dealloc(pp, pl); w.dealloc(sp, sl);
  if (status !== 0n) throw new Error(text);
  return text;
}

type Table = { file: number; probes: ([number, number, number] | [number, number, number, 1])[]; scopes: [number, number, string[]][] };

const source = `const label: string = "sum";
function add(a: number, b: number) {
  const total = a + b;
  return total;
}
let acc = 0;
for (let i = 0; i < 2; i++) {
  acc = add(acc, i);
}
const double = (x: number) => x * 2;
try {
  throw new Error("boom");
} catch (err) {
  const message = (err as Error).message;
  debugger;
}
switch (acc) {
  case 1: {
    const one = "one";
    break;
  }
  default:
    let other = 2;
}
class Counter {
  n = 0;
  inc() { this.n++; return this.n; }
}
new Counter().inc();
if (acc > 0) console.log(label, double(acc));
`;

const [js, table] = transpile("/sample.ts", source, DEBUG).split("\0");
const t: Table = JSON.parse(table);

const lines = source.split("\n");
const hits: { line: number; text: string; locals: Record<string, unknown> }[] = [];
const names = (scope: number) => {
  const out: string[] = [];
  for (let s = scope; s >= 0; s = t.scopes[s][0]) out.push(...t.scopes[s][2]);
  return out;
};
let pending: { id: number; debuggerStmt?: 1 } | undefined;
const dbg = (file: number, id: number, debuggerStmt?: 1) => {
  assert.equal(file, t.file);
  pending = { id, debuggerStmt };
  return true;
};
dbg.p = (e: (n: string) => unknown) => {
  const { id, debuggerStmt } = pending!;
  const [line, column, scope] = t.probes[id];
  const locals: Record<string, unknown> = {};
  for (const n of names(scope)) {
    try { locals[n] = e(n); } catch { locals[n] = "<tdz>"; }
  }
  hits.push({ line, text: lines[line].slice(column).trim() + (debuggerStmt ? "  [debugger]" : ""), locals });
};
(globalThis as any).__dbg = dbg;
const logged: unknown[][] = [];
const log = console.log;
console.log = (...a) => logged.push(a);
try { await import("data:text/javascript," + encodeURIComponent(js)); } finally { console.log = log; }



assert.deepEqual(logged, [["sum", 2]]);
const at = (text: string) => hits.filter((h) => h.text.startsWith(text));
assert.equal(at("const total = a + b").length, 2);
const { add, ...second } = at("return total")[1].locals;
assert.equal(typeof add, "function");
assert.deepEqual(second, { a: 0, b: 1, total: 1, label: "sum", acc: 0, double: "<tdz>", Counter: "<tdz>" });
assert.equal(at("acc = add(acc, i)")[1].locals.i, 1);
assert.equal(at("x * 2")[0].locals.x, 1);
assert.equal(at("debugger")[0].locals.message, "boom");
assert.ok(at("debugger")[0].text.endsWith("[debugger]"));
assert.ok(at("this.n++").length === 1);
assert.equal(at("break")[0].locals.one, "one");
assert.equal(at("const one")[0].locals.other, "<tdz>");
// Without the flag nothing changes.
assert.ok(!transpile("/sample.ts", source, 0).includes("__dbg"));
const withMap = transpile("/sample.ts", source, DEBUG | SOURCE_MAP).split("\0");
assert.equal(withMap.length, 3);
console.log(`ok: ${t.probes.length} probes, ${t.scopes.length} scopes, ${hits.length} hits`);
