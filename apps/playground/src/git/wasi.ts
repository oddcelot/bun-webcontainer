// A WASI preview1 host (`wasi_snapshot_preview1`) over the project's VFS, so a wasm32-wasip1 command module (the
// gitoxide-based `git`) runs against the project's files. Synchronous like the module: the VFS lives in this thread.
// fd 0-2 are stdin/stdout/stderr, fd 3 is the preopen `/` (the VFS root). There are no symlinks.
//
// The VFS rewrites a whole file per `write` (and fires one change event each), but git writes packs and indexes in
// many small calls. So an open file's bytes are buffered in a per-path node shared by its fds and flushed with a single
// `vfs.write` on close/sync, rename or exit.
import { type VFS, dirname } from "@runbun/vfs";

export type WasiRun = { exitCode: number };

// WASI errno numbers.
const E = {
  OK: 0, ACCES: 2, BADF: 8, BUSY: 10, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54,
  NOTEMPTY: 55, NOTSUP: 58, PERM: 63, SPIPE: 70, NOTCAPABLE: 76,
} as const;
// filetype
const T_CHAR = 2, T_DIR = 3, T_REG = 4;
// path_open oflags / fdflags
const O_CREAT = 1, O_DIRECTORY = 2, O_EXCL = 4, O_TRUNC = 8, F_APPEND = 1;
// rights (the bits path_open's `rights_base` is checked for)
const R_WRITE = 1n << 6n;
const ALL_RIGHTS = 0xffffffffffffffffn;

// (no parameter properties: node strips types, and they aren't erasable)
class Errno extends Error {
  code: number;
  constructor(code: number) {
    super(`wasi errno ${code}`);
    this.code = code;
  }
}
/** `proc_exit`: unwinds out of `_start`. */
class Exit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const START_MS = Date.now();
const enc = new TextEncoder();
const dec = new TextDecoder();

const inoOf = (key: string) => {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return BigInt(h + 1);
};

/** The bytes of a file in one path, shared by every fd open on it. */
type Node = {
  key: string;
  buf: Uint8Array; // capacity; the file is buf[0, len)
  len: number;
  owned: boolean; // false: buf is the VFS's own array, copied before the first write
  dirty: boolean;
  mtime: number;
  refs: number;
  gone: boolean; // unlinked or replaced: never flushed
};

type Fd =
  | { kind: "std"; n: 0 | 1 | 2 }
  | { kind: "dir"; key: string; preopen: boolean }
  | { kind: "file"; node: Node; pos: number; write: boolean; append: boolean };

type Opts = {
  args: string[];
  env?: Record<string, string>;
  stdout: (bytes: Uint8Array) => void;
  stderr: (bytes: Uint8Array) => void;
  stdin?: Uint8Array;
};

/**
 * Runs `module` (a wasm32-wasip1 command) to completion. `args` includes argv[0]. Writes reach `stdout`/`stderr` as
 * copies. A trap rethrows; `proc_exit` becomes `exitCode`. Files still dirty at the end are flushed to the VFS.
 */
export async function runWasi(module: WebAssembly.Module, vfs: VFS, opts: Opts): Promise<WasiRun> {
  let memory!: WebAssembly.Memory;
  const host = createWasi(vfs, opts, () => memory);
  const instance = await WebAssembly.instantiate(module, host.imports as WebAssembly.Imports);
  memory = instance.exports.memory as WebAssembly.Memory;
  const start = instance.exports._start as (() => void) | undefined;
  if (!start) throw new Error("wasi: the module has no _start export");
  try {
    start();
    return { exitCode: 0 };
  } catch (e) {
    if (e instanceof Exit) return { exitCode: e.code };
    throw e;
  } finally {
    host.flushAll();
  }
}

/** The import object over `vfs`; `getMemory` is the instance's memory (read on every call: growth replaces its buffer). Exported for tests. */
export function createWasi(vfs: VFS, opts: Opts, getMemory: () => WebAssembly.Memory) {
  const dv = () => new DataView(getMemory().buffer);
  // The buffer is replaced by memory.grow, so views are never kept across calls.
  const u8 = (ptr: number, len: number) => new Uint8Array(getMemory().buffer, ptr, len);
  const str = (ptr: number, len: number) => dec.decode(u8(ptr, len));

  const fds = new Map<number, Fd>([
    [0, { kind: "std", n: 0 }],
    [1, { kind: "std", n: 1 }],
    [2, { kind: "std", n: 2 }],
    [3, { kind: "dir", key: "", preopen: true }],
  ]);
  let nextFd = 4;
  const allocFd = (f: Fd) => {
    while (fds.has(nextFd)) nextFd++;
    fds.set(nextFd, f);
    return nextFd++;
  };
  const nodes = new Map<string, Node>();
  const loaded = new WeakSet<Node>();
  const stdin = opts.stdin ?? new Uint8Array(0);
  let stdinPos = 0;

  const getFd = (fd: number) => {
    const f = fds.get(fd);
    if (!f) throw new Errno(E.BADF);
    return f;
  };
  const getDir = (fd: number) => {
    const f = getFd(fd);
    if (f.kind !== "dir") throw new Errno(f.kind === "file" ? E.NOTDIR : E.BADF);
    return f;
  };
  const getFile = (fd: number) => {
    const f = getFd(fd);
    if (f.kind === "dir") throw new Errno(E.ISDIR);
    if (f.kind === "std") throw new Errno(E.SPIPE);
    return f;
  };

  // --- paths ---

  /** A path under a directory fd as a VFS key; `..` above the root escapes the sandbox. */
  function resolve(dirfd: number, path: string): string {
    const base = path.startsWith("/") ? "" : getDir(dirfd).key;
    const out = base ? base.split("/") : [];
    for (const s of path.split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") {
        if (!out.length) throw new Errno(E.NOTCAPABLE);
        out.pop();
      } else out.push(s);
    }
    return out.join("/");
  }

  /** What `k` is, or undefined; ENOTDIR when a parent is a file. */
  function kind(k: string): "file" | "dir" | undefined {
    for (let p = dirname(k); p !== ""; p = dirname(p)) if (vfs.files.has(p)) throw new Errno(E.NOTDIR);
    if (k === "") return "dir";
    if (vfs.files.has(k)) return "file";
    return vfs.isDir(k) || vfs.exists(k) ? "dir" : undefined;
  }
  const need = (k: string) => {
    const t = kind(k);
    if (!t) throw new Errno(E.NOENT);
    return t;
  };
  /** The parent of a new entry has to be a directory. */
  function checkParent(k: string) {
    const t = kind(dirname(k));
    if (t === "file") throw new Errno(E.NOTDIR);
    if (!t) throw new Errno(E.NOENT);
  }

  // --- file nodes ---

  function nodeFor(key: string): Node {
    let n = nodes.get(key);
    if (!n) {
      n = { key, buf: new Uint8Array(0), len: 0, owned: false, dirty: false, mtime: vfs.mtimes.get(key) ?? START_MS, refs: 0, gone: false };
      nodes.set(key, n);
    }
    return n;
  }
  /** Loads the VFS's bytes for a node on first use (a LazyMiss surfaces as EIO). */
  function load(n: Node) {
    if (loaded.has(n)) return n;
    const d = vfs.data(n.key);
    const b = d === undefined ? new Uint8Array(0) : typeof d === "string" ? enc.encode(d) : d;
    loaded.add(n);
    n.buf = b;
    n.len = b.length;
    n.owned = false;
    return n;
  }
  /** Capacity for `size` bytes, owned (copied out of the VFS's array if need be). */
  function reserve(n: Node, size: number) {
    if (n.owned && n.buf.length >= size) return;
    const next = new Uint8Array(n.owned ? Math.max(size, n.buf.length * 2) : Math.max(size, 64));
    next.set(n.buf.subarray(0, n.len));
    n.buf = next;
    n.owned = true;
  }
  function setLen(n: Node, size: number) {
    reserve(n, size);
    if (size > n.len) n.buf.fill(0, n.len, size);
    n.len = size;
    n.dirty = true;
    n.mtime = Date.now();
  }
  function flush(n: Node) {
    if (!n.dirty || n.gone) return;
    n.dirty = false;
    vfs.write(n.key, n.buf.slice(0, n.len));
    vfs.mtimes.set(n.key, n.mtime);
  }
  const flushUnder = (k: string) => {
    for (const n of nodes.values()) if (n.key === k || n.key.startsWith(k + "/")) flush(n);
  };
  /** Marks nodes at or under `k` as gone (the path was removed or replaced): their fds stay valid but never flush. */
  const dropUnder = (k: string) => {
    for (const n of [...nodes.values()]) {
      if (n.key !== k && !n.key.startsWith(k + "/")) continue;
      n.gone = true;
      nodes.delete(n.key);
    }
  };
  const sizeOf = (key: string) => {
    const n = nodes.get(key);
    return n && loaded.has(n) ? n.len : (vfs.size(key) ?? 0);
  };
  const mtimeOf = (key: string) => nodes.get(key)?.mtime ?? vfs.mtimes.get(key) ?? START_MS;

  // --- stat ---

  function writeStat(out: number, key: string, type: number, size: number, mtimeMs: number) {
    const v = dv();
    const ns = BigInt(Math.round(mtimeMs)) * 1_000_000n;
    v.setBigUint64(out, 1n, true);
    v.setBigUint64(out + 8, inoOf(key), true);
    v.setUint8(out + 16, type);
    v.setBigUint64(out + 24, 1n, true);
    v.setBigUint64(out + 32, BigInt(size), true);
    v.setBigUint64(out + 40, ns, true);
    v.setBigUint64(out + 48, ns, true);
    v.setBigUint64(out + 56, ns, true);
  }
  const statKey = (out: number, key: string) => {
    if (need(key) === "dir") writeStat(out, key, T_DIR, 4096, START_MS);
    else writeStat(out, key, T_REG, sizeOf(key), mtimeOf(key));
  };

  // --- io ---

  function iovs(ptr: number, count: number): [number, number][] {
    const v = dv();
    const out: [number, number][] = [];
    for (let i = 0; i < count; i++) out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]);
    return out;
  }

  function readInto(f: Fd, list: [number, number][], at: number | null): number {
    if (f.kind === "dir") throw new Errno(E.ISDIR);
    let total = 0;
    if (f.kind === "std") {
      if (f.n !== 0) throw new Errno(E.BADF);
      for (const [p, l] of list) {
        const n = Math.min(l, stdin.length - stdinPos);
        u8(p, n).set(stdin.subarray(stdinPos, stdinPos + n));
        stdinPos += n;
        total += n;
        if (n < l) break;
      }
      return total;
    }
    const n = load(f.node);
    let pos = at ?? f.pos;
    for (const [p, l] of list) {
      const c = Math.max(0, Math.min(l, n.len - pos));
      u8(p, c).set(n.buf.subarray(pos, pos + c));
      pos += c;
      total += c;
      if (c < l) break;
    }
    if (at === null) f.pos = pos;
    return total;
  }

  function writeFrom(f: Fd, list: [number, number][], at: number | null): number {
    if (f.kind === "dir") throw new Errno(E.ISDIR);
    if (f.kind === "std") {
      if (f.n === 0) throw new Errno(E.BADF);
      let total = 0;
      for (const [p, l] of list) {
        (f.n === 1 ? opts.stdout : opts.stderr)(u8(p, l).slice());
        total += l;
      }
      return total;
    }
    if (!f.write) throw new Errno(E.BADF);
    const n = load(f.node);
    let total = 0;
    for (const [, l] of list) total += l;
    let pos = f.append ? n.len : (at ?? f.pos);
    const end = pos + total;
    if (end > n.len || !n.owned) {
      const oldLen = n.len;
      reserve(n, Math.max(end, n.len));
      if (pos > oldLen) n.buf.fill(0, oldLen, pos); // a hole reads as zeros
      if (end > oldLen) n.len = end;
    }
    for (const [p, l] of list) {
      n.buf.set(u8(p, l), pos);
      pos += l;
    }
    n.dirty = true;
    n.mtime = Date.now();
    if (at === null || f.append) f.pos = pos;
    return total;
  }

  function closeFd(fd: number) {
    const f = getFd(fd);
    fds.delete(fd);
    if (f.kind === "file") {
      flush(f.node);
      if (--f.node.refs <= 0 && nodes.get(f.node.key) === f.node) nodes.delete(f.node.key);
    }
  }

  function setTimes(key: string, mtime: bigint, flags: number) {
    // flags: 1 atim, 2 atim_now, 4 mtim, 8 mtim_now. Only the mtime is kept.
    let ms: number | undefined;
    if (flags & 8) ms = Date.now();
    else if (flags & 4) ms = Number(mtime / 1_000_000n);
    if (ms === undefined) return;
    const n = nodes.get(key);
    if (n) n.mtime = ms;
    if (vfs.files.has(key)) vfs.mtimes.set(key, ms);
  }

  const envList = () => Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const sizeOfStrings = (list: string[]) => list.reduce((s, a) => s + enc.encode(a).length + 1, 0);
  /** Writes NUL-terminated strings into `buf` and their pointers into `ptrs` (args_get / environ_get). */
  function strings(list: string[], ptrs: number, buf: number) {
    const v = dv();
    for (const s of list) {
      const b = enc.encode(s);
      v.setUint32(ptrs, buf, true);
      ptrs += 4;
      u8(buf, b.length + 1).set(b);
      u8(buf + b.length, 1)[0] = 0;
      buf += b.length + 1;
    }
    return 0;
  }

  // --- the imports ---

  const wasi = {
    args_sizes_get(argc: number, size: number) {
      const v = dv();
      v.setUint32(argc, opts.args.length, true);
      v.setUint32(size, sizeOfStrings(opts.args), true);
      return 0;
    },
    args_get: (argv: number, buf: number) => strings(opts.args, argv, buf),
    environ_sizes_get(count: number, size: number) {
      const list = envList();
      const v = dv();
      v.setUint32(count, list.length, true);
      v.setUint32(size, sizeOfStrings(list), true);
      return 0;
    },
    environ_get: (environ: number, buf: number) => strings(envList(), environ, buf),
    clock_time_get(id: number, _precision: bigint, out: number) {
      if (id > 3) throw new Errno(E.INVAL);
      // realtime from Date (the epoch), the rest from the page's monotonic clock
      dv().setBigUint64(out, id === 0 ? BigInt(Date.now()) * 1_000_000n : BigInt(Math.round(performance.now() * 1e6)), true);
      return 0;
    },
    clock_res_get(id: number, out: number) {
      if (id > 3) throw new Errno(E.INVAL);
      dv().setBigUint64(out, id === 0 ? 1_000_000n : 1_000n, true);
      return 0;
    },
    random_get(ptr: number, len: number) {
      // getRandomValues takes at most 64 KiB per call
      for (let i = 0; i < len; i += 65536) crypto.getRandomValues(u8(ptr + i, Math.min(65536, len - i)));
      return 0;
    },
    proc_exit(code: number): never {
      throw new Exit(code);
    },
    proc_raise(sig: number): never {
      throw new Exit(128 + sig);
    },
    sched_yield: () => 0,
    poll_oneoff(inp: number, out: number, count: number, nevents: number) {
      // Nothing blocks here: every subscription (clock, fd readiness) is ready at once.
      const v = dv();
      for (let i = 0; i < count; i++) {
        const s = inp + i * 48;
        const o = out + i * 32;
        v.setBigUint64(o, v.getBigUint64(s, true), true); // userdata
        v.setUint16(o + 8, 0, true); // error
        v.setUint8(o + 10, v.getUint8(s + 8)); // type = the subscription's tag
        v.setBigUint64(o + 16, 0n, true); // nbytes
        v.setUint16(o + 24, 0, true); // flags
      }
      v.setUint32(nevents, count, true);
      return 0;
    },

    fd_close(fd: number) {
      closeFd(fd);
      return 0;
    },
    fd_prestat_get(fd: number, out: number) {
      const f = getFd(fd);
      if (f.kind !== "dir" || !f.preopen) throw new Errno(E.BADF);
      const v = dv();
      v.setUint8(out, 0);
      v.setUint32(out + 4, 1, true);
      return 0;
    },
    fd_prestat_dir_name(fd: number, path: number, len: number) {
      const f = getFd(fd);
      if (f.kind !== "dir" || !f.preopen) throw new Errno(E.BADF);
      if (len >= 1) u8(path, 1)[0] = 0x2f;
      return 0;
    },
    fd_fdstat_get(fd: number, out: number) {
      const f = getFd(fd);
      const v = dv();
      v.setUint8(out, f.kind === "std" ? T_CHAR : f.kind === "dir" ? T_DIR : T_REG);
      v.setUint8(out + 1, 0);
      v.setUint16(out + 2, f.kind === "file" && f.append ? F_APPEND : 0, true);
      v.setBigUint64(out + 8, ALL_RIGHTS, true);
      v.setBigUint64(out + 16, ALL_RIGHTS, true);
      return 0;
    },
    fd_fdstat_set_flags(fd: number, flags: number) {
      const f = getFd(fd);
      if (f.kind === "file") f.append = !!(flags & F_APPEND);
      return 0;
    },
    fd_filestat_get(fd: number, out: number) {
      const f = getFd(fd);
      if (f.kind === "std") writeStat(out, `std${f.n}`, T_CHAR, 0, START_MS);
      else if (f.kind === "dir") writeStat(out, f.key, T_DIR, 4096, START_MS);
      else writeStat(out, f.node.key, T_REG, loaded.has(f.node) ? f.node.len : sizeOf(f.node.key), f.node.mtime);
      return 0;
    },
    fd_filestat_set_size(fd: number, size: bigint) {
      const f = getFile(fd);
      if (!f.write) throw new Errno(E.BADF);
      setLen(load(f.node), Number(size));
      return 0;
    },
    fd_filestat_set_times(fd: number, _atim: bigint, mtim: bigint, flags: number) {
      setTimes(getFile(fd).node.key, mtim, flags);
      return 0;
    },
    fd_read(fd: number, iov: number, count: number, out: number) {
      dv().setUint32(out, readInto(getFd(fd), iovs(iov, count), null), true);
      return 0;
    },
    fd_pread(fd: number, iov: number, count: number, offset: bigint, out: number) {
      dv().setUint32(out, readInto(getFile(fd), iovs(iov, count), Number(offset)), true);
      return 0;
    },
    fd_write(fd: number, iov: number, count: number, out: number) {
      dv().setUint32(out, writeFrom(getFd(fd), iovs(iov, count), null), true);
      return 0;
    },
    fd_pwrite(fd: number, iov: number, count: number, offset: bigint, out: number) {
      dv().setUint32(out, writeFrom(getFile(fd), iovs(iov, count), Number(offset)), true);
      return 0;
    },
    fd_seek(fd: number, offset: bigint, whence: number, out: number) {
      const f = getFile(fd);
      const base = whence === 0 ? 0 : whence === 1 ? f.pos : whence === 2 ? load(f.node).len : -1;
      const to = base + Number(offset);
      if (base < 0 || to < 0) throw new Errno(E.INVAL);
      f.pos = to;
      dv().setBigUint64(out, BigInt(to), true);
      return 0;
    },
    fd_tell(fd: number, out: number) {
      dv().setBigUint64(out, BigInt(getFile(fd).pos), true);
      return 0;
    },
    fd_sync(fd: number) {
      const f = getFd(fd);
      if (f.kind === "file") flush(f.node);
      return 0;
    },
    fd_datasync(fd: number) {
      return wasi.fd_sync(fd);
    },
    fd_advise: () => 0,
    fd_allocate(fd: number, offset: bigint, len: bigint) {
      const f = getFile(fd);
      if (!f.write) throw new Errno(E.BADF);
      const n = load(f.node);
      const end = Number(offset + len);
      if (end > n.len) setLen(n, end);
      return 0;
    },
    fd_renumber(from: number, to: number) {
      const f = getFd(from);
      getFd(to);
      closeFd(to);
      fds.delete(from);
      fds.set(to, f);
      return 0;
    },
    fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint, used: number) {
      const f = getFd(fd);
      if (f.kind !== "dir") throw new Errno(E.NOTDIR);
      const entries: { name: string; type: number; key: string }[] = [
        { name: ".", type: T_DIR, key: f.key },
        { name: "..", type: T_DIR, key: dirname(f.key) },
        ...vfs.readdir(f.key).map((e) => ({ name: e.name, type: e.dir ? T_DIR : T_REG, key: f.key ? `${f.key}/${e.name}` : e.name })),
      ];
      const out = u8(buf, bufLen);
      let n = 0;
      for (let i = Number(cookie); i < entries.length && n < bufLen; i++) {
        const e = entries[i];
        const name = enc.encode(e.name);
        const rec = new Uint8Array(24 + name.length);
        const rv = new DataView(rec.buffer);
        rv.setBigUint64(0, BigInt(i + 1), true); // d_next
        rv.setBigUint64(8, inoOf(e.key), true);
        rv.setUint32(16, name.length, true);
        rv.setUint8(20, e.type);
        rec.set(name, 24);
        const c = Math.min(rec.length, bufLen - n); // the last entry may be cut: bufused == buf_len says "more"
        out.set(rec.subarray(0, c), n);
        n += c;
      }
      dv().setUint32(used, n, true);
      return 0;
    },

    path_create_directory(dirfd: number, p: number, len: number) {
      const k = resolve(dirfd, str(p, len));
      if (kind(k)) throw new Errno(E.EXIST);
      checkParent(k);
      vfs.mkdir(k);
      return 0;
    },
    path_filestat_get(dirfd: number, _flags: number, p: number, len: number, out: number) {
      statKey(out, resolve(dirfd, str(p, len)));
      return 0;
    },
    path_filestat_set_times(dirfd: number, _flags: number, p: number, len: number, _atim: bigint, mtim: bigint, fstFlags: number) {
      const k = resolve(dirfd, str(p, len));
      need(k);
      setTimes(k, mtim, fstFlags);
      return 0;
    },
    path_open(dirfd: number, _dirflags: number, p: number, len: number, oflags: number, rights: bigint, _inheriting: bigint, fdflags: number, out: number) {
      const path = str(p, len);
      const k = resolve(dirfd, path);
      const write = !!(rights & R_WRITE);
      const wantDir = !!(oflags & O_DIRECTORY) || path.endsWith("/");
      const t = kind(k);
      let fd: number;
      if (t === "dir") {
        if (oflags & O_CREAT && oflags & O_EXCL) throw new Errno(E.EXIST);
        if (write || oflags & O_TRUNC) throw new Errno(E.ISDIR);
        fd = allocFd({ kind: "dir", key: k, preopen: false });
      } else {
        if (t === "file") {
          if (oflags & O_CREAT && oflags & O_EXCL) throw new Errno(E.EXIST);
          if (wantDir) throw new Errno(E.NOTDIR);
        } else {
          if (!(oflags & O_CREAT)) throw new Errno(E.NOENT);
          if (wantDir) throw new Errno(E.NOTDIR);
          checkParent(k);
          vfs.write(k, new Uint8Array(0)); // exists at once, for stat and rename
        }
        const n = nodeFor(k);
        if (t !== "file" || (oflags & O_TRUNC && write)) {
          if (t === "file") vfs.write(k, new Uint8Array(0));
          n.buf = new Uint8Array(0);
          n.len = 0;
          n.owned = true;
          n.dirty = false;
          n.mtime = vfs.mtimes.get(k) ?? Date.now();
          loaded.add(n);
        }
        n.refs++;
        fd = allocFd({ kind: "file", node: n, pos: 0, write, append: !!(fdflags & F_APPEND) });
      }
      dv().setUint32(out, fd, true);
      return 0;
    },
    path_readlink(dirfd: number, p: number, len: number, _buf: number, _bufLen: number, _used: number) {
      need(resolve(dirfd, str(p, len)));
      throw new Errno(E.INVAL); // there are no links
    },
    path_remove_directory(dirfd: number, p: number, len: number) {
      const k = resolve(dirfd, str(p, len));
      if (need(k) === "file") throw new Errno(E.NOTDIR);
      if (k === "") throw new Errno(E.BUSY);
      if (vfs.readdir(k).length) throw new Errno(E.NOTEMPTY);
      vfs.remove(k);
      return 0;
    },
    path_unlink_file(dirfd: number, p: number, len: number) {
      const k = resolve(dirfd, str(p, len));
      if (need(k) === "dir") throw new Errno(E.ISDIR);
      dropUnder(k);
      vfs.remove(k);
      return 0;
    },
    path_rename(fromFd: number, from: number, flen: number, toFd: number, to: number, tlen: number) {
      const a = resolve(fromFd, str(from, flen));
      const b = resolve(toFd, str(to, tlen));
      const ta = need(a);
      if (a === "" || b === "") throw new Errno(E.BUSY);
      checkParent(b);
      if (a === b) return 0;
      if (b.startsWith(a + "/")) throw new Errno(E.INVAL);
      const tb = kind(b);
      if (ta === "file" && tb === "dir") throw new Errno(E.ISDIR);
      if (ta === "dir" && tb === "file") throw new Errno(E.NOTDIR);
      if (tb === "dir" && vfs.readdir(b).length) throw new Errno(E.NOTEMPTY);
      flushUnder(a);
      // A file's `write` replaces the target; only an (empty) directory has to go first.
      if (tb) {
        dropUnder(b);
        if (tb === "dir") vfs.remove(b);
      }
      vfs.rename(a, b);
      // open fds follow the file: their node is re-keyed
      for (const n of [...nodes.values()]) {
        if (n.key !== a && !n.key.startsWith(a + "/")) continue;
        nodes.delete(n.key);
        n.key = b + n.key.slice(a.length);
        nodes.set(n.key, n);
      }
      return 0;
    },
    path_symlink(_old: number, _oldLen: number, _fd: number, _p: number, _len: number) {
      throw new Errno(E.NOTSUP);
    },
    path_link() {
      throw new Errno(E.NOTSUP);
    },
    sock_accept: () => E.NOSYS,
    sock_recv: () => E.NOSYS,
    sock_send: () => E.NOSYS,
    sock_shutdown: () => E.NOSYS,
  };

  let warned = false;
  const guarded: Record<string, (...a: never[]) => unknown> = {};
  for (const [name, fn] of Object.entries(wasi) as [string, (...a: unknown[]) => number][]) {
    guarded[name] = (...a: unknown[]) => {
      try {
        return fn(...a);
      } catch (e) {
        if (e instanceof Exit) throw e;
        if (e instanceof Errno) return e.code;
        if (!warned) (warned = true), console.warn(`[wasi] ${name} failed:`, e);
        return E.IO; // incl. LazyMiss: a lazy file the page hasn't loaded
      }
    };
  }
  // An import the table lacks (a newer WASI call) is ENOSYS rather than a failed instantiation.
  const ns = new Proxy(guarded, { get: (t, k) => (typeof k === "string" ? (t[k] ?? (() => E.NOSYS)) : undefined), has: () => true });
  const imports = new Proxy({}, { get: (_t, k) => (k === "wasi_snapshot_preview1" ? ns : new Proxy({}, { get: () => () => E.NOSYS })), has: () => true });
  return { imports, wasi: guarded, flushAll: () => nodes.forEach((n) => flush(n)) };
}
