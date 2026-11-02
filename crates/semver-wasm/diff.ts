import { readFileSync } from "node:fs";
const mod = new WebAssembly.Module(readFileSync(new URL("../../target/wasm64-unknown-unknown/release/bun_semver_wasm.wasm", import.meta.url)));
type Wasm = { memory: WebAssembly.Memory; [fn: string]: any };
const w = new WebAssembly.Instance(mod, {}).exports as Wasm;
const enc = new TextEncoder();
const withStr = <T>(s: string, f: (p: bigint, n: bigint) => T): T => { const b = enc.encode(s), n = BigInt(b.length), p = w.alloc(n);
  new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); try { return f(p, n); } finally { w.dealloc(p, n); } };
const { order, sat }: { order: [string, string, number][]; sat: [string, string, boolean][] } = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
let bad = 0;
for (const [a, b, want] of order) { const got = withStr(a, (pa, la) => withStr(b, (pb, lb) => w.semver_order(pa, la, pb, lb))); if (got !== want) { bad++; console.log("order", a, b, { got, want }); } }
for (const [v, r, want] of sat) { const got = withStr(v, (pv, lv) => withStr(r, (pr, lr) => w.semver_satisfies(pv, lv, pr, lr))) === 1; if (got !== want) { bad++; console.log("satisfies", v, r, { got, want }); } }
console.log(`${order.length + sat.length} comparisons, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
