// Loads the wasm64 build of the zstd and brotli codecs and checks they round-trip with native Bun in both directions:
// what native Bun compresses decompresses here, and what is compressed here decompresses in native Bun.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const path = new URL("../../target/wasm64-unknown-unknown/release/bun_compress_wasm.wasm", import.meta.url);
const mod = new WebAssembly.Module(readFileSync(path));
console.log("imports:", WebAssembly.Module.imports(mod));
type Wasm = { memory: WebAssembly.Memory; [fn: string]: any };
const w = new WebAssembly.Instance(mod, {}).exports as Wasm;

/** Runs `call(ptr, len)` over `data` in wasm memory; the result bytes if it returned 0, else the status. */
function run(data: Uint8Array, call: (p: bigint, len: bigint) => number): Uint8Array | number {
  const len = BigInt(data.length);
  const p = w.alloc(len);
  new Uint8Array(w.memory.buffer, Number(p), data.length).set(data);
  try {
    const status = call(p, len);
    if (status !== 0) return status;
    const out = new Uint8Array(w.memory.buffer, Number(w.out_ptr()), Number(w.out_len())).slice();
    w.out_free();
    return out;
  } finally {
    w.dealloc(p, len);
  }
}
const ok = (r: Uint8Array | number): Uint8Array => {
  assert.ok(typeof r !== "number", `status ${r}`);
  return r;
};
const zc = (d: Uint8Array, level: number) => ok(run(d, (p, l) => w.zstd_compress(p, l, level)));
const zd = (d: Uint8Array) => run(d, (p, l) => w.zstd_decompress(p, l));
const bc = (d: Uint8Array, q: number) => ok(run(d, (p, l) => w.brotli_compress(p, l, q, -1, -1, -1, -1, -1, -1)));
const bd = (d: Uint8Array) => run(d, (p, l) => w.brotli_decompress(p, l, 0));

function native(op: string, arg: string, input: Uint8Array): Buffer {
  const r = spawnSync("bun", [new URL("native.ts", import.meta.url).pathname, op, arg], { input, maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, `native ${op} ${arg}: ${r.stderr}`);
  return r.stdout;
}

const text = Buffer.from(readFileSync(new URL("../../README.md", import.meta.url)));
const random = Buffer.alloc(100_000);
let seed = 1;
for (let i = 0; i < random.length; i++) random[i] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
const mixed = Buffer.concat([text, random.subarray(0, 5000), Buffer.alloc(70_000, 7), text, text]);
const corpus: [string, Uint8Array][] = [
  ["empty", new Uint8Array(0)],
  ["one byte", Buffer.from("a")],
  ["hello", Buffer.from("hello hello hello hello world")],
  ["text", text],
  ["random", random],
  ["mixed", mixed],
  ["zeros 3MB", Buffer.alloc(3 << 20)],
];

let checks = 0;
const same = (a: Uint8Array, b: Uint8Array, what: string) => {
  assert.ok(Buffer.compare(a, b) === 0, what);
  checks++;
};
for (const [name, data] of corpus) {
  for (const level of [1, 3, 9, 19, 22]) {
    if (level > 9 && data.length > 1 << 20) continue; // slow, and no new coverage
    const mine = zc(data, level);
    same(ok(zd(mine)), data, `zstd ${name} level ${level}: wasm round trip`);
    same(native("zd", "", mine), data, `zstd ${name} level ${level}: wasm -> native`);
    const theirs = native("zc", String(level), data);
    same(ok(zd(theirs)), data, `zstd ${name} level ${level}: native -> wasm`);
  }
  for (const q of [0, 1, 5, 9, 11]) {
    if (q > 9 && data.length > 1 << 20) continue;
    const mine = bc(data, q);
    same(ok(bd(mine)), data, `brotli ${name} q${q}: wasm round trip`);
    same(native("bd", "", mine), data, `brotli ${name} q${q}: wasm -> native`);
    const theirs = native("bc", String(q), data);
    same(ok(bd(theirs)), data, `brotli ${name} q${q}: native -> wasm`);
  }
}

// Concatenated frames and a skippable frame in between decode as one, as libzstd does.
{
  const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
  const joined = Buffer.concat([zc(Buffer.from("abc"), 3), skip, zc(Buffer.from("def"), 3)]);
  same(ok(zd(joined)), Buffer.from("abcdef"), "zstd: concatenated frames");
  same(native("zd", "", joined), Buffer.from("abcdef"), "native agrees on concatenated frames");
}
// Trailing bytes after a brotli stream are ignored, as native does.
same(ok(bd(Buffer.concat([bc(Buffer.from("hi"), 5), Buffer.from("xx")]))), Buffer.from("hi"), "brotli: trailing bytes");

// Corrupt input: statuses the host maps to native Bun's errors.
const zgood = zc(text, 3);
const bgood = bc(text, 5);
const flip = (b: Uint8Array, at: number) => Buffer.from(b).fill(Buffer.from(b)[at] ^ 0xff, at, at + 1);
assert.equal(zd(Buffer.from("this is not zstd data at all!!!!")), 1, "zstd garbage");
assert.equal(zd(zgood.subarray(0, zgood.length - 3)), 3, "zstd truncated");
assert.equal(zd(flip(zgood, zgood.length - 1)), 2, "zstd corrupt tail (the frames carry no checksum)");
assert.equal(bd(bgood.subarray(0, bgood.length - 3)), 1000, "brotli truncated");
assert.equal(bd(new Uint8Array(0)), 1000, "brotli empty");
assert.equal(bd(Buffer.from("this is not brotli data at all!!!!")), -14, "brotli garbage = PADDING_1 like native");
assert.equal(bd(Buffer.from("zzzzzz")), -2, "brotli RESERVED like native");

// Many calls: nothing may accumulate in the instance's memory.
const before = w.memory.buffer.byteLength;
for (let i = 0; i < 300; i++) {
  ok(zd(zc(text, 3)));
  ok(bd(bc(text, 5)));
}
console.log(`${checks} comparisons ok; memory ${before} -> ${w.memory.buffer.byteLength} bytes after 600 round trips`);
const [zsize, bsize] = [zc(text, 19).length, bc(text, 11).length];
console.log(`README.md ${text.length} bytes: zstd 19 -> ${zsize}, native ${native("zc", "19", text).length}; brotli 11 -> ${bsize}, native ${native("bc", "11", text).length}`);
