// Runs the sys-wasm probe against the playground VFS through the `bun_sys` host imports.
// Run with node >= 24 (Memory64 + native .ts type stripping; bun lacks Memory64):  node test.ts
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { VFS } from "../../packages/vfs/vfs.ts";
import { createSysImports } from "../../packages/vfs/sysHost.ts";

const mod = new WebAssembly.Module(readFileSync(new URL("../../target/wasm64-unknown-unknown/release/bun_sys_wasm.wasm", import.meta.url)));
const vfs = new VFS();
vfs.write("src/index.ts", "console.log('hi')\n");
vfs.write("src/lib/util.ts", "export {}");
vfs.write("data.bin", new Uint8Array([0, 1, 2, 255]));
vfs.mkdir("empty");

let memory: WebAssembly.Memory;
type Wasm = { memory: WebAssembly.Memory; [fn: string]: any };
const w = new WebAssembly.Instance(mod, createSysImports(vfs, () => memory)).exports as Wasm;
memory = w.memory;

const enc = new TextEncoder();
const dec = new TextDecoder();
function withBytes<T>(b: Uint8Array, f: (p: bigint, len: bigint) => T): T {
  const len = BigInt(b.length);
  const p = w.alloc(len);
  new Uint8Array(w.memory.buffer, Number(p), b.length).set(b);
  try { return f(p, len); } finally { w.dealloc(p, len); }
}
const withStr = <T>(s: string, f: (p: bigint, len: bigint) => T): T => withBytes(enc.encode(s), f);
function withOut(cap: number, f: (p: bigint, cap: bigint) => bigint): [bigint, Uint8Array] {
  const p = w.alloc(BigInt(cap));
  try {
    const n = f(p, BigInt(cap));
    return [n, n > 0n ? new Uint8Array(w.memory.buffer, Number(p), Math.min(Number(n), cap)).slice() : new Uint8Array()];
  } finally { w.dealloc(p, BigInt(cap)); }
}
const ENOENT = -2n, ENOTDIR = -20n, EISDIR = -21n, EEXIST = -18n;

const readFile = (path: string) => withStr(path, (pp, pl) => withOut(64, (o, c) => w.sys_read_file(pp, pl, o, c)));
const stat = (path: string) => withStr(path, (pp, pl) => {
  const sp = w.alloc(8n);
  try {
    const r = w.sys_stat(pp, pl, sp);
    return [r, new BigInt64Array(w.memory.buffer, Number(sp), 1)[0]];
  } finally { w.dealloc(sp, 8n); }
});
const list = (path: string) => withStr(path, (pp, pl) => withOut(256, (o, c) => w.sys_list_dir(pp, pl, o, c)));

// read: relative, absolute, binary
let [n, b] = readFile("src/index.ts");
assert.equal(n, 18n); assert.equal(dec.decode(b), "console.log('hi')\n");
[n, b] = readFile("/src/lib/util.ts");
assert.equal(dec.decode(b), "export {}");
[n, b] = readFile("data.bin");
assert.deepEqual([...b], [0, 1, 2, 255]);
// read: errors
assert.equal(readFile("nope.ts")[0], ENOENT);
assert.equal(readFile("src")[0], EISDIR);
assert.ok(readFile("src/index.ts/x")[0] < 0n);

// stat
assert.deepEqual(stat("src/index.ts"), [0n, 18n]);
assert.equal(stat("src")[0], 1n);
assert.equal(stat("/")[0], 1n);
assert.equal(stat("empty")[0], 1n);
assert.equal(stat("data.bin")[1], 4n);
assert.equal(stat("missing")[0], ENOENT);

// write (create + truncate), visible in the VFS
assert.equal(withStr("out/new.txt", (pp, pl) => withStr("x", (dp, dl) => w.sys_write_file(pp, pl, dp, dl))), ENOENT); // parent missing
assert.equal(withStr("new.txt", (pp, pl) => withStr("héllo", (dp, dl) => w.sys_write_file(pp, pl, dp, dl))), 6n);
assert.equal(vfs.readText("new.txt"), "héllo");
assert.equal(withStr("new.txt", (pp, pl) => withStr("bye", (dp, dl) => w.sys_write_file(pp, pl, dp, dl))), 3n);
assert.equal(vfs.readText("new.txt"), "bye");
assert.equal(withStr("src", (pp, pl) => withStr("x", (dp, dl) => w.sys_write_file(pp, pl, dp, dl))), EISDIR);

// readdir
[n, b] = list("src");
assert.deepEqual(dec.decode(b).trim().split("\n").sort(), ["d/lib", "f/index.ts"]);
assert.deepEqual(dec.decode(list("/")[1]).trim().split("\n").sort(), ["d/empty", "d/src", "f/data.bin", "f/new.txt"]);
assert.equal(list("empty")[0], 0n);
assert.equal(list("nope")[0], ENOENT);
assert.equal(list("data.bin")[0], ENOTDIR);

// mkdir -p + rename + unlink
assert.equal(withStr("a/b/c", (d, dl) => withStr("new.txt", (f, fl) => withStr("a/b/c/moved.txt", (t, tl) => w.sys_mkdir_rename_unlink(d, dl, f, fl, t, tl)))), 0n);
assert.ok(vfs.isDir("a/b/c"));
assert.equal(vfs.exists("new.txt"), false);
assert.equal(vfs.exists("a/b/c/moved.txt"), false); // unlinked at the end
assert.equal(withStr("a/b/c", (d, dl) => withStr("gone.txt", (f, fl) => withStr("a/x.txt", (t, tl) => w.sys_mkdir_rename_unlink(d, dl, f, fl, t, tl)))), ENOENT);

// bun_core's entropy and clocks come from the host (bun_sys.random, bun_sys.clock)
const r1 = w.sys_fast_random(), r2 = w.sys_fast_random();
assert.notEqual(r1, r2);
const second = new WebAssembly.Instance(mod, createSysImports(new VFS(), () => (second as unknown as Wasm).memory)).exports as Wasm;
assert.notEqual(second.sys_fast_random(), r1, "a second instance (a second run) is seeded differently");
const wall = Number(w.sys_nano_timestamp()) / 1e6;
assert.ok(Math.abs(wall - Date.now()) < 1000, `wall clock ${wall} vs Date.now() ${Date.now()}`);
const m1 = w.sys_monotonic_ns();
const until = performance.now() + 5;
while (performance.now() < until);
const m2 = w.sys_monotonic_ns();
assert.ok(m1 > 0n && m2 - m1 >= 4_000_000n, `monotonic ${m1} -> ${m2}`);

console.log("sys-wasm: all assertions passed");
