// Loads the wasm64 build of bun_semver and compares against Bun.semver's documented behaviour.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const path = new URL("../target/wasm64-unknown-unknown/release/bun_semver_wasm.wasm", import.meta.url);
const mod = new WebAssembly.Module(readFileSync(path));
console.log("imports:", WebAssembly.Module.imports(mod));
const { exports: w } = new WebAssembly.Instance(mod, {});

const enc = new TextEncoder();
function withStr(s, f) {
  const b = enc.encode(s);
  const len = BigInt(b.length);
  const p = w.alloc(len); // wasm64: pointers and usize are i64 -> BigInt
  new Uint8Array(w.memory.buffer, Number(p), b.length).set(b);
  try { return f(p, len); } finally { w.dealloc(p, len); }
}
const order = (a, b) => withStr(a, (pa, la) => withStr(b, (pb, lb) => w.semver_order(pa, la, pb, lb)));
const satisfies = (v, r) => withStr(v, (pv, lv) => withStr(r, (pr, lr) => w.semver_satisfies(pv, lv, pr, lr))) === 1;

const cases = [
  [order("1.0.0", "1.0.0"), 0], [order("1.0.0", "1.0.1"), -1], [order("2.0.0", "1.9.9"), 1],
  [order("1.0.0-alpha", "1.0.0"), -1], [order("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1],
  [order("1.0.0+build.1", "1.0.0+build.2"), 0], [order("v1.2.3", "1.2.3"), 0],
  [satisfies("1.2.3", "^1.0.0"), true], [satisfies("2.0.0", "^1.0.0"), false],
  [satisfies("1.2.3", "~1.2.0"), true], [satisfies("1.3.0", "~1.2.0"), false],
  [satisfies("1.2.3", ">=1.0.0 <2.0.0"), true], [satisfies("1.2.3", "1.x || >=2.5.0"), true],
  [satisfies("2.4.0", "1.x || >=2.5.0"), false], [satisfies("1.2.3", "1.2.3"), true],
  [satisfies("1.0.0-beta", "^1.0.0"), false], [satisfies("1.2.3", "*"), true],
  [satisfies("1.2.3", "1.2.3 - 2.0.0"), true], [satisfies("not-a-version", "*"), false],
];
cases.forEach(([got, want], i) => assert.equal(got, want, `case ${i}`));

// Many calls: the mimalloc shim must not leak (heaps destroyed, blocks freed).
const before = w.memory.buffer.byteLength;
for (let i = 0; i < 20000; i++) satisfies(`1.${i % 50}.${i % 7}`, ">=1.10.0 <1.40.0 || ^1.45.0-rc.1");
console.log(`${cases.length} cases ok; memory ${before} -> ${w.memory.buffer.byteLength} bytes after 20k calls`);
