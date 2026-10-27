import { readFileSync } from "node:fs";
const mod = new WebAssembly.Module(readFileSync(new URL("./target/wasm64-unknown-unknown/release/bun_semver_wasm.wasm", import.meta.url)));
const { exports: w } = new WebAssembly.Instance(mod, {});
const enc = new TextEncoder();
const withStr = (s, f) => { const b = enc.encode(s), n = BigInt(b.length), p = w.alloc(n);
  new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); try { return f(p, n); } finally { w.dealloc(p, n); } };
const { order, sat } = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url)));
let bad = 0;
for (const [a, b, want] of order) { const got = withStr(a, (pa, la) => withStr(b, (pb, lb) => w.semver_order(pa, la, pb, lb))); if (got !== want) { bad++; console.log("order", a, b, { got, want }); } }
for (const [v, r, want] of sat) { const got = withStr(v, (pv, lv) => withStr(r, (pr, lr) => w.semver_satisfies(pv, lv, pr, lr))) === 1; if (got !== want) { bad++; console.log("satisfies", v, r, { got, want }); } }
console.log(`${order.length + sat.length} comparisons, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
