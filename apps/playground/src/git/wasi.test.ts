// node apps/playground/src/git/wasi.test.ts   (node >= 26 runs the TypeScript directly)
// Edge cases of the WASI host called directly, then crates/git-wasm's git.wasm run under it over a VFS, its .git dumped
// to disk and checked by native git.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VFS } from "@runbun/vfs";
import { createWasi, runWasi } from "./wasi.ts";

const E = { OK: 0, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, NOTCAPABLE: 76 };
const O = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const RW = 0xffffffffffffffffn;
const RO = 2n; // fd_read only

// --- a harness around the raw imports ---

const mem = new WebAssembly.Memory({ initial: 4 });
const enc = new TextEncoder();
const dec = new TextDecoder();
function setup(files: Record<string, string> = {}) {
  const vfs = new VFS();
  for (const [k, v] of Object.entries(files)) vfs.write(k, v);
  const out: Uint8Array[] = [];
  const w = createWasi(vfs, { args: ["t"], stdout: (b) => out.push(b), stderr: () => {} }, () => mem).wasi as Record<string, (...a: unknown[]) => number>;
  const dv = () => new DataView(mem.buffer);
  const PATH = 1024, RES = 2048, IO = 3072, BUF = 8192;
  const path = (p: string) => (new Uint8Array(mem.buffer, PATH, 512).set(enc.encode(p)), [PATH, enc.encode(p).length] as const);
  const open = (p: string, oflags = 0, rights = RW, fdflags = 0, dirfd = 3) => {
    const r = w.path_open(dirfd, 0, ...path(p), oflags, rights, rights, fdflags, RES);
    return r === 0 ? dv().getUint32(RES, true) : -r;
  };
  const write = (fd: number, data: string, at?: number) => {
    const b = enc.encode(data);
    new Uint8Array(mem.buffer, BUF, b.length).set(b);
    dv().setUint32(IO, BUF, true);
    dv().setUint32(IO + 4, b.length, true);
    return at === undefined ? w.fd_write(fd, IO, 1, RES) : w.fd_pwrite(fd, IO, 1, BigInt(at), RES);
  };
  const read = (fd: number, len = 4096) => {
    dv().setUint32(IO, BUF, true);
    dv().setUint32(IO + 4, len, true);
    assert.equal(w.fd_read(fd, IO, 1, RES), 0);
    return dec.decode(new Uint8Array(mem.buffer, BUF, dv().getUint32(RES, true)));
  };
  const call = (name: string, ...a: unknown[]) => w[name](...a);
  const p = (name: string, dirfd: number, s: string, ...rest: unknown[]) => w[name](dirfd, ...path(s), ...rest);
  return { vfs, w, dv, path, open, write, read, call, p, out, RES, BUF };
}

// --- tests ---

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("prestat: fd 3 is `/`, fd 4 is not a preopen", () => {
  const t = setup();
  assert.equal(t.w.fd_prestat_get(3, t.RES), 0);
  assert.equal(t.dv().getUint8(t.RES), 0);
  assert.equal(t.dv().getUint32(t.RES + 4, true), 1);
  t.w.fd_prestat_dir_name(3, t.BUF, 1);
  assert.equal(new Uint8Array(mem.buffer, t.BUF, 1)[0], 0x2f);
  assert.equal(t.w.fd_prestat_get(4, t.RES), E.BADF);
});

test("O_EXCL on an existing file is EEXIST; creating makes an empty file at once", () => {
  const t = setup({ "a.txt": "x" });
  assert.equal(t.open("a.txt", O.CREAT | O.EXCL), -E.EXIST);
  assert.equal(t.open("nope", 0), -E.NOENT);
  const fd = t.open("new.txt", O.CREAT | O.EXCL);
  assert.ok(fd >= 4);
  assert.equal(t.vfs.size("new.txt"), 0);
  assert.equal(t.vfs.read("new.txt") instanceof Uint8Array, true);
});

test("directory errors: ENOTDIR, EISDIR, escaping the root", () => {
  const t = setup({ "d/f": "1" });
  assert.equal(t.open("d/f", O.DIRECTORY), -E.NOTDIR);
  assert.equal(t.open("d/f/x", 0), -E.NOTDIR);
  assert.equal(t.open("d", 0, RW), -E.ISDIR);
  assert.ok(t.open("d", O.DIRECTORY, RO) >= 4);
  assert.equal(t.open("../x", O.CREAT), -E.NOTCAPABLE);
  assert.equal(t.open("d/../d/f/", 0, RO), -E.NOTDIR);
  assert.ok(t.open("d/../d/./f", 0, RO) >= 4);
});

test("writes are buffered: one vfs event per file, flushed on close; reads see unsaved bytes", () => {
  const t = setup();
  let events = 0;
  t.vfs.onChange(() => events++);
  const fd = t.open("f.bin", O.CREAT);
  events = 0;
  for (let i = 0; i < 50; i++) assert.equal(t.write(fd, "0123456789"), 0);
  assert.equal(events, 0);
  assert.equal(t.vfs.size("f.bin"), 0);
  t.w.fd_filestat_get(fd, t.RES);
  assert.equal(t.dv().getBigUint64(t.RES + 32, true), 500n);
  t.w.fd_seek(fd, 0n, 0, t.RES);
  assert.equal(t.read(fd, 12), "012345678901");
  assert.equal(t.w.fd_close(fd), 0);
  assert.equal(events, 1);
  assert.equal(t.vfs.size("f.bin"), 500);
});

test("write past EOF zero-fills; pwrite doesn't move the offset; append goes to the end", () => {
  const t = setup({ "f": "abc" });
  const fd = t.open("f");
  assert.equal(t.write(fd, "Z", 5), 0);
  t.w.fd_close(fd);
  assert.deepEqual([...t.vfs.readBytes("f")!], [97, 98, 99, 0, 0, 90]);
  const a = t.open("f", 0, RW, 1);
  t.write(a, "!");
  t.w.fd_seek(a, 0n, 1, t.RES);
  assert.equal(t.dv().getBigUint64(t.RES, true), 7n);
  t.w.fd_close(a);
  assert.equal(t.vfs.size("f"), 7);
});

test("truncate: O_TRUNC, fd_filestat_set_size shrink and grow", () => {
  const t = setup({ "f": "hello world" });
  const fd = t.open("f");
  assert.equal(t.w.fd_filestat_set_size(fd, 5n), 0);
  t.w.fd_close(fd);
  assert.equal(t.vfs.readText("f"), "hello");
  const g = t.open("f");
  t.w.fd_filestat_set_size(g, 8n);
  t.w.fd_close(g);
  assert.deepEqual([...t.vfs.readBytes("f")!], [104, 101, 108, 108, 111, 0, 0, 0]);
  const h = t.open("f", O.TRUNC);
  t.w.fd_close(h);
  assert.equal(t.vfs.size("f"), 0);
  // read-only open with O_TRUNC doesn't truncate
  t.vfs.write("r", "keep");
  t.w.fd_close(t.open("r", O.TRUNC, RO));
  assert.equal(t.vfs.readText("r"), "keep");
});

test("rename over an existing file (the lock-file pattern), with an unflushed fd", () => {
  const t = setup({ ".git/index": "old" });
  const fd = t.open(".git/index.lock", O.CREAT | O.EXCL);
  t.write(fd, "new index");
  const r = renameVia(t, ".git/index.lock", ".git/index");
  assert.equal(r, 0);
  assert.equal(t.vfs.readText(".git/index"), "new index");
  assert.equal(t.vfs.exists(".git/index.lock"), false);
  t.write(fd, "!"); // the fd follows the file
  t.w.fd_close(fd);
  assert.equal(t.vfs.readText(".git/index"), "new index!");
});

function renameVia(t: ReturnType<typeof setup>, a: string, b: string) {
  const fromBytes = enc.encode(a);
  const toBytes = enc.encode(b);
  new Uint8Array(mem.buffer, 5000, fromBytes.length).set(fromBytes);
  new Uint8Array(mem.buffer, 5200, toBytes.length).set(toBytes);
  return t.w.path_rename(3, 5000, fromBytes.length, 3, 5200, toBytes.length);
}

test("rename: dir onto non-empty dir is ENOTEMPTY, file onto dir EISDIR, dir moves with children", () => {
  const t = setup({ "a/x": "1", "b/y": "2", "f": "f" });
  assert.equal(renameVia(t, "a", "b"), E.NOTEMPTY);
  assert.equal(renameVia(t, "f", "a"), E.ISDIR);
  assert.equal(renameVia(t, "a", "c"), 0);
  assert.equal(t.vfs.readText("c/x"), "1");
  assert.equal(t.vfs.exists("a"), false);
  assert.equal(renameVia(t, "missing", "z"), E.NOENT);
});

test("unlink / rmdir errors", () => {
  const t = setup({ "d/f": "1", "e": "x" });
  assert.equal(t.p("path_unlink_file", 3, "d"), E.ISDIR);
  assert.equal(t.p("path_remove_directory", 3, "d"), E.NOTEMPTY);
  assert.equal(t.p("path_remove_directory", 3, "e"), E.NOTDIR);
  assert.equal(t.p("path_unlink_file", 3, "nope"), E.NOENT);
  assert.equal(t.p("path_unlink_file", 3, "d/f"), 0);
  assert.equal(t.p("path_remove_directory", 3, "d"), 0);
  assert.equal(t.vfs.exists("d"), false);
});

test("mkdir, symlinks, readlink", () => {
  const t = setup({ "f": "1" });
  assert.equal(t.p("path_create_directory", 3, "d"), 0);
  assert.equal(t.p("path_create_directory", 3, "d"), E.EXIST);
  assert.equal(t.p("path_create_directory", 3, "f"), E.EXIST);
  assert.equal(t.p("path_create_directory", 3, "nope/x"), E.NOENT);
  assert.equal(t.p("path_create_directory", 3, "f/x"), E.NOTDIR);
  assert.equal(t.vfs.isDir("d"), true);
  assert.equal(t.p("path_readlink", 3, "f", 4000, 10, t.RES), E.INVAL);
  assert.equal(t.p("path_readlink", 3, "nope", 4000, 10, t.RES), E.NOENT);
  assert.equal(t.call("path_symlink", 1024, 1, 3, 1024, 1), E.NOTSUP);
  assert.equal(t.call("path_link", 3, 0, 1024, 1, 3, 1024, 1), E.NOTSUP);
});

test("fd_readdir: pagination with a small buffer, cookies, truncation", () => {
  const files: Record<string, string> = {};
  const names = ["alpha", "beta", "gamma", "delta-long-name", "e"];
  for (const n of names) files[`d/${n}`] = "x";
  files["d/sub/z"] = "z";
  const t = setup(files);
  const fd = t.open("d", O.DIRECTORY, RO);
  const seen: string[] = [];
  let cookie = 0n;
  const BUFLEN = 40; // fits one short entry; long ones get cut and re-read
  for (let guard = 0; guard < 100; guard++) {
    assert.equal(t.w.fd_readdir(fd, t.BUF, BUFLEN, cookie, t.RES), 0);
    const used = t.dv().getUint32(t.RES, true);
    if (used === 0) break;
    const b = new Uint8Array(mem.buffer, t.BUF, used).slice();
    const v = new DataView(b.buffer);
    let off = 0;
    let advanced = false;
    while (off + 24 <= used) {
      const next = v.getBigUint64(off, true);
      const len = v.getUint32(off + 16, true);
      if (off + 24 + len > used) break; // truncated: refetched from the same cookie
      seen.push(`${dec.decode(b.subarray(off + 24, off + 24 + len))}:${v.getUint8(off + 20)}`);
      cookie = next;
      off += 24 + len;
      advanced = true;
    }
    if (!advanced) break; // an entry bigger than the buffer: a real caller grows the buffer
  }
  // "delta-long-name" (39 bytes with header) doesn't fit in 40 along with anything else but does alone
  assert.deepEqual(seen, [".:3", "..:3", "alpha:4", "beta:4", "delta-long-name:4", "e:4", "gamma:4", "sub:3"]);
  // big buffer: all at once, bufused < buf_len
  t.w.fd_readdir(fd, t.BUF, 4000, 0n, t.RES);
  assert.ok(t.dv().getUint32(t.RES, true) < 4000);
  // bufused == buf_len when it doesn't fit
  t.w.fd_readdir(fd, t.BUF, 30, 0n, t.RES);
  assert.equal(t.dv().getUint32(t.RES, true), 30);
});

test("path_filestat_get fields", () => {
  const t = setup({ "f": "abcd", "d/g": "1" });
  t.vfs.mtimes.set("f", 1_700_000_000_123);
  const st = (p: string) => {
    const r = t.w.path_filestat_get(3, 1, ...t.path(p), t.RES);
    return r === 0 ? t.dv() : r;
  };
  let v = st("f") as DataView;
  assert.equal(v.getUint8(t.RES + 16), 4);
  assert.equal(v.getBigUint64(t.RES + 32, true), 4n);
  assert.equal(v.getBigUint64(t.RES + 48, true), 1_700_000_000_123_000_000n);
  v = st("d") as DataView;
  assert.equal(v.getUint8(t.RES + 16), 3);
  assert.equal(st("zzz"), E.NOENT);
  assert.equal(t.w.path_filestat_set_times(3, 1, ...t.path("f"), 0n, 5000n * 1_000_000n, 4), 0);
  assert.equal(t.vfs.mtimes.get("f"), 5000);
});

test("std fds: stdout copies, stdin reads, fdstat", async () => {
  const vfs = new VFS();
  const out: Uint8Array[] = [];
  const w = createWasi(vfs, { args: ["t"], stdout: (b) => out.push(b), stderr: () => {}, stdin: enc.encode("in!") }, () => mem).wasi as Record<string, (...a: unknown[]) => number>;
  const dv = new DataView(mem.buffer);
  new Uint8Array(mem.buffer, 100, 2).set(enc.encode("hi"));
  dv.setUint32(0, 100, true);
  dv.setUint32(4, 2, true);
  assert.equal(w.fd_write(1, 0, 1, 16), 0);
  new Uint8Array(mem.buffer, 100, 2).fill(0);
  assert.equal(dec.decode(out[0]), "hi"); // a copy, not a view
  dv.setUint32(4, 8, true);
  assert.equal(w.fd_read(0, 0, 1, 16), 0);
  assert.equal(dv.getUint32(16, true), 3);
  assert.equal(dec.decode(new Uint8Array(mem.buffer, 100, 3)), "in!");
  assert.equal(w.fd_fdstat_get(1, 32), 0);
  assert.equal(dv.getUint8(32), 2);
  assert.equal(w.fd_seek(1, 0n, 0, 16), 70);
});

// --- the real git (crates/git-wasm; `moon run git-wasm:build`) ---

const GIT = new URL("../../../../crates/git-wasm/target/wasm32-wasip1/release/git.wasm", import.meta.url).pathname;
test("git.wasm: init, add, commit, status, diff, log over the VFS; native git agrees", async () => {
  if (!existsSync(GIT)) return console.log(`  (skipped: ${GIT} missing)`);
  const module = await WebAssembly.compile(readFileSync(GIT));
  const vfs = new VFS();
  const git = async (...args: string[]) => {
    let out = "";
    let err = "";
    const { exitCode } = await runWasi(module, vfs, {
      args: ["git", ...args],
      env: { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com" },
      stdout: (b) => (out += dec.decode(b)),
      stderr: (b) => (err += dec.decode(b)),
    });
    assert.equal(exitCode, 0, `git ${args.join(" ")}: ${err}${out}`);
    return out;
  };
  vfs.write("index.ts", "console.log(1)\n");
  vfs.write("README.md", "# t\n");
  vfs.write("node_modules/x/index.js", "x\n"); // excluded by the .git/info/exclude init writes
  await git("init");
  await git("add", ".");
  await git("commit", "-m", "first");
  vfs.write("index.ts", "console.log(2)\n");
  vfs.write("new.ts", "export {}\n");
  vfs.remove("README.md");
  assert.equal(await git("status", "-s"), " D README.md\n M index.ts\n?? new.ts\n");
  assert.match(await git("diff"), /-console\.log\(1\)\n\+console\.log\(2\)/);
  await git("add", "-A");
  await git("commit", "-m", "second");
  assert.equal(await git("status", "-s"), "");
  assert.equal(await git("log", "--oneline").then((l) => l.split("\n").filter(Boolean).length), 2);

  // dump the whole tree and let native git judge it
  const dir = mkdtempSync(join(tmpdir(), "wasi-git-"));
  try {
    for (const [k, v] of vfs.files) {
      const to = join(dir, k);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, typeof v === "string" ? v : (v as Uint8Array));
    }
    const native = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    native("fsck", "--full", "--strict");
    assert.deepEqual(native("log", "--format=%s").trim().split("\n"), ["second", "first"]);
    assert.equal(native("status", "--porcelain"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git.wasm: merge (a conflict), stash and tag over the VFS; native git reads the result", async () => {
  if (!existsSync(GIT)) return console.log(`  (skipped: ${GIT} missing)`);
  const module = await WebAssembly.compile(readFileSync(GIT));
  const vfs = new VFS();
  const git = async (...args: string[]) => {
    let out = "";
    let err = "";
    const { exitCode } = await runWasi(module, vfs, {
      args: ["git", ...args],
      env: { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com" },
      stdout: (b) => (out += dec.decode(b)),
      stderr: (b) => (err += dec.decode(b)),
    });
    return { exitCode, out, err };
  };
  const ok = async (...args: string[]) => {
    const r = await git(...args);
    assert.equal(r.exitCode, 0, `git ${args.join(" ")}: ${r.err}${r.out}`);
    return r.out;
  };
  vfs.write("a.txt", "a\nb\nc\n");
  vfs.write("k.txt", "keep\n");
  await ok("init");
  await ok("add", ".");
  await ok("commit", "-m", "base");
  await ok("tag", "-a", "v1", "-m", "first release");
  await ok("switch", "-c", "feat");
  vfs.write("a.txt", "a\nfeat\nc\n");
  await ok("commit", "-am", "on feat");
  await ok("switch", "main");
  vfs.write("a.txt", "a\nmain\nc\n");
  await ok("commit", "-am", "on main");
  const m = await git("merge", "feat");
  assert.equal(m.exitCode, 1);
  assert.equal(m.out, "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n");
  assert.equal(await ok("status", "-s"), "UU a.txt\n");
  assert.equal(dec.decode(vfs.read("a.txt") as Uint8Array), "a\n<<<<<<< HEAD\nmain\n=======\nfeat\n>>>>>>> feat\nc\n");
  vfs.write("a.txt", "a\nboth\nc\n");
  await ok("add", "a.txt");
  await ok("commit");
  vfs.write("k.txt", "keep\nlocal\n");
  vfs.write("u.txt", "untracked\n");
  assert.match(await ok("stash", "-u"), /^Saved working directory and index state WIP on main: [0-9a-f]{7} Merge branch 'feat'\n$/);
  assert.equal(await ok("status", "-s"), "");
  await ok("tag", "light");

  const dir = mkdtempSync(join(tmpdir(), "wasi-git-"));
  try {
    for (const [k, v] of vfs.files) {
      const to = join(dir, k);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, typeof v === "string" ? v : (v as Uint8Array));
    }
    const native = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    native("fsck", "--full", "--strict");
    assert.deepEqual(native("log", "--format=%P").split("\n").slice(0, 4).map((l) => (l ? l.split(" ").length : 0)), [2, 1, 1, 0]); // the merge has two parents
    assert.equal(native("tag", "-n"), "light           Merge branch 'feat'\nv1              first release\n");
    assert.match(native("stash", "list"), /^stash@\{0\}: WIP on main: [0-9a-f]{7} Merge branch 'feat'\n$/);
    native("stash", "pop");
    assert.equal(native("status", "--porcelain"), " M k.txt\n?? u.txt\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${(e as Error).stack}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
