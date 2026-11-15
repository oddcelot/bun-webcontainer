import { Buffer } from "buffer";
import EventEmitter from "events";
import { dirname, isLazy, norm, VFS, type FileContents, type FileData } from "@runbun/vfs";
import { asyncError, codeError, fsError } from "./errors";
import path from "./path";
import { Readable, Writable } from "./stream";
import { fileURLToPath } from "./url";
import { tracked } from "../promises";
import { hold, release } from "../loop";

type Mirror = (op: "write" | "mkdir" | "remove" | "rename", ...args: unknown[]) => void;
type Any = any;

let vfs = new VFS();
let mirror: Mirror = () => {};
/** The runtime hands over the worker's VFS copy and the callback that mirrors changes to the page. */
export function setFs(v: VFS, m: Mirror) {
  vfs = v;
  mirror = m;
}

const START = Date.now();
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { ignoreBOM: true });
const stdio = (fd: number) => (globalThis as Any).process[fd === 1 ? "stdout" : "stderr"];

function toPath(p: unknown, name = "path"): string {
  if (typeof p === "string") return p;
  if (p instanceof Uint8Array) return Buffer.from(p).toString();
  if (p instanceof URL || (typeof p === "object" && p !== null && (p as URL).protocol === "file:" && "href" in p)) return fileURLToPath(p as URL);
  throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${p === null ? "null" : typeof p === "object" ? "an instance of " + (p as object).constructor?.name : `type ${typeof p} (${String(p)})`}`);
}
const keyOf = (p: string) => norm(path.resolve(p));
const isFile = (k: string) => vfs.files.has(k);
const isDir = (k: string) => vfs.isDir(k);
const exists = (k: string) => isFile(k) || isDir(k);
const bytesOf = (k: string): Uint8Array => vfs.readBytes(k)!;

function copyBytes(v: ArrayBufferView): Uint8Array {
  const out = new Uint8Array(v.byteLength);
  out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return out;
}

function toData(data: unknown, encoding?: string): FileContents {
  if (typeof data === "string") return encoding && !/^utf-?8$/i.test(encoding) ? copyBytes(Buffer.from(data, encoding as BufferEncoding)) : data;
  if (ArrayBuffer.isView(data)) return copyBytes(data);
  throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${data === null ? "null" : typeof data}`);
}

function decode(b: Uint8Array, encoding: string): string {
  return /^utf-?8$/i.test(encoding) ? dec.decode(b) : Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString(encoding as BufferEncoding);
}

const put = (k: string, data: FileData) => {
  vfs.write(k, data);
  mirror("write", k, data);
};
const makeDir = (k: string) => {
  vfs.mkdir(k);
  mirror("mkdir", k);
};
const del = (k: string) => {
  vfs.remove(k);
  mirror("remove", k);
};

function checkParent(k: string, p: string, syscall: string, dest?: string) {
  const parent = dirname(k);
  if (isFile(parent)) throw fsError("ENOTDIR", syscall, p, dest);
  if (!isDir(parent)) throw fsError("ENOENT", syscall, p, dest);
}

class Stats {
  dev = 1;
  mode: number;
  nlink = 1;
  uid = 1000;
  gid = 1000;
  rdev = 0;
  blksize = 4096;
  ino: number;
  size: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs = START;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime = new Date(START);
  constructor(
    private dir: boolean,
    size: number,
    mtimeMs: number,
    key: string,
  ) {
    this.mode = dir ? 0o40755 : 0o100644;
    this.size = size;
    this.blocks = Math.ceil(size / 512);
    this.atimeMs = this.mtimeMs = this.ctimeMs = mtimeMs;
    this.atime = new Date(mtimeMs);
    this.mtime = new Date(mtimeMs);
    this.ctime = new Date(mtimeMs);
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
    this.ino = h + 1;
  }
  isFile = () => !this.dir;
  isDirectory = () => this.dir;
  isSymbolicLink = () => false;
  isBlockDevice = () => false;
  isCharacterDevice = () => false;
  isFIFO = () => false;
  isSocket = () => false;
}

function statOf(k: string): Stats | undefined {
  const d = vfs.files.get(k);
  if (d !== undefined) return new Stats(false, vfs.size(k)!, vfs.mtimes.get(k) ?? START, k);
  if (isDir(k)) return new Stats(true, 4096, START, k);
}

class Dirent {
  parentPath: string;
  path: string;
  constructor(
    public name: string,
    parent: string,
    private dir: boolean,
  ) {
    this.parentPath = this.path = parent;
  }
  isFile = () => !this.dir;
  isDirectory = () => this.dir;
  isSymbolicLink = () => false;
  isBlockDevice = () => false;
  isCharacterDevice = () => false;
  isFIFO = () => false;
  isSocket = () => false;
}

type Fd = { key: string; path: string; pos: number; read: boolean; write: boolean; append: boolean };
const fds = new Map<number, Fd>();
let nextFd = 3;

const getFd = (fd: number, syscall: string): Fd => {
  const f = fds.get(fd);
  if (!f) throw fsError("EBADF", syscall);
  return f;
};

function parseFlags(f: string | number = "r") {
  if (typeof f === "number") return { read: (f & 3) !== 1, write: (f & 3) !== 0, create: !!(f & 64), excl: !!(f & 128), trunc: !!(f & 512), append: !!(f & 1024) };
  const plus = f.includes("+");
  return { read: f[0] === "r" || plus, write: f[0] !== "r" || plus, create: f[0] !== "r", excl: f.includes("x"), trunc: f[0] === "w", append: f[0] === "a" };
}

function openSync(p: unknown, flags?: string | number, _mode?: number): number {
  const pth = toPath(p);
  const k = keyOf(pth);
  const f = parseFlags(flags);
  if (isDir(k)) {
    if (f.write) throw fsError("EISDIR", "open", pth);
  } else if (isFile(k)) {
    if (f.excl && f.create) throw fsError("EEXIST", "open", pth);
    if (f.trunc) put(k, "");
  } else {
    if (!f.create) throw fsError("ENOENT", "open", pth);
    checkParent(k, pth, "open");
    put(k, "");
  }
  const fd = nextFd++;
  fds.set(fd, { key: k, path: pth, pos: 0, read: f.read, write: f.write, append: f.append });
  return fd;
}

function closeSync(fd: number) {
  getFd(fd, "close");
  fds.delete(fd);
}

function readSync(fd: number, buf: ArrayBufferView, a?: number | { offset?: number; length?: number; position?: number | bigint | null }, length?: number, position?: number | bigint | null): number {
  const f = getFd(fd, "read");
  let offset = 0;
  let len = buf.byteLength;
  let pos = position ?? null;
  if (typeof a === "object" && a !== null) {
    offset = a.offset ?? 0;
    len = a.length ?? buf.byteLength - offset;
    pos = a.position ?? null;
  } else {
    offset = a ?? 0;
    len = length ?? buf.byteLength - offset;
  }
  if (!isFile(f.key)) throw fsError("EISDIR", "read");
  const data = bytesOf(f.key);
  const track = pos === null || pos === -1;
  const at = track ? f.pos : Number(pos);
  const n = Math.max(0, Math.min(len, data.length - at));
  new Uint8Array(buf.buffer, buf.byteOffset + offset, n).set(data.subarray(at, at + n));
  if (track) f.pos += n;
  return n;
}

function writeAt(f: Fd, bytes: Uint8Array, position: number | null) {
  const cur = isFile(f.key) ? bytesOf(f.key) : new Uint8Array(0);
  const at = f.append ? cur.length : (position ?? f.pos);
  const out = new Uint8Array(Math.max(cur.length, at + bytes.length));
  out.set(cur);
  out.set(bytes, at);
  put(f.key, out);
  if (f.append || position === null) f.pos = at + bytes.length;
  return bytes.length;
}

function writeSync(fd: number, data: unknown, a?: unknown, b?: unknown, c?: unknown): number {
  let bytes: Uint8Array;
  let position: number | null = null;
  if (typeof data === "string") {
    bytes = Buffer.from(data, (typeof b === "string" ? b : "utf8") as BufferEncoding);
    position = typeof a === "number" ? a : null;
  } else if (ArrayBuffer.isView(data)) {
    let offset = 0;
    let len = data.byteLength;
    if (typeof a === "object" && a !== null) {
      const o = a as { offset?: number; length?: number; position?: number | null };
      offset = o.offset ?? 0;
      len = o.length ?? data.byteLength - offset;
      position = o.position ?? null;
    } else {
      offset = (a as number) ?? 0;
      len = (b as number) ?? data.byteLength - offset;
      position = typeof c === "number" ? c : null;
    }
    bytes = new Uint8Array(data.buffer, data.byteOffset + offset, len);
  } else {
    toData(data);
    throw new Error("unreachable");
  }
  if (fd === 1 || fd === 2) {
    stdio(fd).write(decode(bytes, "utf8"));
    return bytes.length;
  }
  return writeAt(getFd(fd, "write"), bytes, position);
}

type ReadOpts = string | { encoding?: string | null; flag?: string } | null | undefined;

function readFileSync(p: unknown, opts?: ReadOpts): string | Buffer {
  const o = typeof opts === "string" ? { encoding: opts } : (opts ?? {});
  let data: Uint8Array;
  let str: string | undefined;
  if (typeof p === "number") {
    const f = getFd(p, "read");
    if (!isFile(f.key)) throw fsError("EISDIR", "read");
    data = bytesOf(f.key).subarray(f.pos);
    f.pos += data.length;
  } else {
    const pth = toPath(p);
    const k = keyOf(pth);
    const d = vfs.files.get(k);
    if (d === undefined) throw isDir(k) ? fsError("EISDIR", "read") : fsError("ENOENT", "open", pth);
    if (typeof d === "string") str = d;
    data = typeof d === "string" ? enc.encode(d) : vfs.readBytes(k)!;
  }
  if (o.encoding && o.encoding !== "buffer") return str !== undefined && /^utf-?8$/i.test(o.encoding) ? str : decode(data, o.encoding);
  return Buffer.from(copyBytes(data));
}

type WriteOpts = string | { encoding?: string | null; flag?: string; mode?: number } | null | undefined;

function writeFileSync(p: unknown, data: unknown, opts?: WriteOpts, defaultFlag = "w") {
  const o = typeof opts === "string" ? { encoding: opts } : (opts ?? {});
  const out = toData(data, o.encoding ?? undefined);
  if (typeof p === "number") {
    if (p === 1 || p === 2) return void stdio(p).write(typeof out === "string" ? out : decode(out, "utf8"));
    return void writeAt(getFd(p, "write"), typeof out === "string" ? enc.encode(out) : out, null);
  }
  const pth = toPath(p);
  const k = keyOf(pth);
  const flag = o.flag ?? defaultFlag;
  if (isDir(k)) throw fsError("EISDIR", "open", pth);
  const cur = vfs.files.get(k);
  if (cur !== undefined && flag.includes("x")) throw fsError("EEXIST", "open", pth);
  if (cur === undefined) checkParent(k, pth, "open");
  if (flag.startsWith("a") && cur !== undefined) {
    if (typeof cur === "string" && typeof out === "string") return put(k, cur + out);
    const a = typeof cur === "string" ? enc.encode(cur) : vfs.readBytes(k)!;
    const b = typeof out === "string" ? enc.encode(out) : out;
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    return put(k, joined);
  }
  put(k, out);
}

const appendFileSync = (p: unknown, data: unknown, opts?: WriteOpts) => writeFileSync(p, data, opts, "a");

function statSync(p: unknown, opts?: { throwIfNoEntry?: boolean }, syscall = "stat"): Stats | undefined {
  const pth = toPath(p);
  const s = statOf(keyOf(pth));
  if (!s && opts?.throwIfNoEntry !== false) throw fsError("ENOENT", syscall, pth);
  return s;
}
const lstatSync = (p: unknown, opts?: { throwIfNoEntry?: boolean }) => statSync(p, opts, "lstat");

function fstatSync(fd: number): Stats {
  const f = getFd(fd, "fstat");
  return statOf(f.key)!;
}

function realpathSync(p: unknown): string {
  const pth = toPath(p);
  const k = keyOf(pth);
  if (!exists(k)) throw fsError("ENOENT", "lstat", pth);
  return "/" + k;
}
realpathSync.native = realpathSync;

function readdirSync(p: unknown, opts?: string | { withFileTypes?: boolean; recursive?: boolean; encoding?: string }): (string | Dirent)[] {
  const o = typeof opts === "object" && opts ? opts : {};
  const pth = toPath(p);
  const k = keyOf(pth);
  if (isFile(k)) throw fsError("ENOTDIR", "scandir", pth);
  if (!isDir(k)) throw fsError("ENOENT", "scandir", pth);
  const out: (string | Dirent)[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of vfs.readdir(dir)) {
      const name = rel + e.name;
      out.push(o.withFileTypes ? new Dirent(e.name, "/" + dir, e.dir) : name);
      if (o.recursive && e.dir) walk(dir ? `${dir}/${e.name}` : e.name, name + "/");
    }
  };
  walk(k, "");
  return out;
}

function accessSync(p: unknown, _mode?: number) {
  const pth = toPath(p);
  if (!exists(keyOf(pth))) throw fsError("ENOENT", "access", pth);
}

function mkdirSync(p: unknown, opts?: number | { recursive?: boolean; mode?: number }): string | undefined {
  const pth = toPath(p);
  const k = keyOf(pth);
  const recursive = typeof opts === "object" && !!opts?.recursive;
  if (recursive) {
    const parts = k.split("/").filter(Boolean);
    let first: string | undefined;
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("/");
      if (isFile(sub)) throw fsError(i === parts.length ? "EEXIST" : "ENOTDIR", "mkdir", pth);
      if (!isDir(sub)) first ??= sub;
    }
    if (!first) return undefined;
    makeDir(k);
    return "/" + first;
  }
  if (k === "" || exists(k)) throw fsError("EEXIST", "mkdir", pth);
  checkParent(k, pth, "mkdir");
  makeDir(k);
}

function rmSync(p: unknown, opts?: { recursive?: boolean; force?: boolean }) {
  const pth = toPath(p);
  const k = keyOf(pth);
  if (!exists(k)) {
    if (opts?.force) return;
    throw fsError("ENOENT", "lstat", pth);
  }
  if (isDir(k) && !opts?.recursive) {
    throw Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${pth}`), { code: "ERR_FS_EISDIR", errno: 21, syscall: "rm", path: pth });
  }
  if (k) del(k);
}

function unlinkSync(p: unknown) {
  const pth = toPath(p);
  const k = keyOf(pth);
  if (isDir(k)) throw fsError("EISDIR", "unlink", pth);
  if (!isFile(k)) throw fsError("ENOENT", "unlink", pth);
  del(k);
}

function rmdirSync(p: unknown, opts?: { recursive?: boolean }) {
  const pth = toPath(p);
  const k = keyOf(pth);
  if (isFile(k)) throw fsError("ENOTDIR", "rmdir", pth);
  if (!isDir(k)) throw fsError("ENOENT", "rmdir", pth);
  if (!opts?.recursive && vfs.readdir(k).length) throw fsError("ENOTEMPTY", "rmdir", pth);
  if (k) del(k);
}

function renameSync(a: unknown, b: unknown) {
  const from = toPath(a, "oldPath");
  const to = toPath(b, "newPath");
  const ka = keyOf(from);
  const kb = keyOf(to);
  if (!exists(ka)) throw fsError("ENOENT", "rename", from, to);
  checkParent(kb, from, "rename", to);
  if (ka === kb) return;
  vfs.rename(ka, kb);
  mirror("rename", ka, kb);
}

function copyFileSync(a: unknown, b: unknown, mode = 0) {
  const from = toPath(a, "src");
  const to = toPath(b, "dest");
  const ka = keyOf(from);
  const kb = keyOf(to);
  if (isDir(ka)) throw fsError("EISDIR", "copyfile", from, to);
  const d = vfs.files.get(ka);
  if (d === undefined) throw fsError("ENOENT", "copyfile", from, to);
  if (mode & 1 && exists(kb)) throw fsError("EEXIST", "copyfile", from, to);
  if (isDir(kb)) throw fsError("EISDIR", "copyfile", from, to);
  checkParent(kb, from, "copyfile", to);
  // A lazy file copies as its reference: the store entry it points into never changes.
  put(kb, typeof d === "string" || isLazy(d) ? d : copyBytes(d));
}

function cpSync(a: unknown, b: unknown, opts?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean }) {
  const from = toPath(a, "src");
  const to = toPath(b, "dest");
  const ka = keyOf(from);
  if (!exists(ka)) throw fsError("ENOENT", "cp", from);
  if (isFile(ka)) return copyFileSync(from, to, opts?.errorOnExist && opts.force === false ? 1 : 0);
  if (!opts?.recursive) throw Object.assign(new Error(`Recursive option is required to copy a directory: cp returned EISDIR (${from} is a directory (not copied)) ${from}`), { code: "ERR_FS_EISDIR" });
  mkdirSync(to, { recursive: true });
  for (const e of vfs.readdir(ka)) cpSync(`${from}/${e.name}`, `${to}/${e.name}`, opts);
}

function truncateSync(p: unknown, len = 0) {
  const pth = toPath(p);
  const k = keyOf(pth);
  if (isDir(k)) throw fsError("EISDIR", "open", pth);
  if (!isFile(k)) throw fsError("ENOENT", "open", pth);
  const cur = bytesOf(k);
  const out = new Uint8Array(len);
  out.set(cur.subarray(0, len));
  put(k, out);
}

function mkdtempSync(prefix: string) {
  const p = prefix + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  mkdirSync(p, { recursive: true });
  return p;
}

const touchSync = (syscall: string) => (p: unknown) => {
  const pth = toPath(p);
  if (!exists(keyOf(pth))) throw fsError("ENOENT", syscall, pth);
};

function utimesSync(p: unknown, _atime: unknown, mtime: number | string | Date) {
  touchSync("utime")(p);
  const k = keyOf(toPath(p));
  if (isFile(k)) vfs.mtimes.set(k, mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000);
}

const unsupported = (syscall: string, code = "EPERM") => (p: unknown) => {
  throw fsError(code, syscall, toPath(p));
};

const constants = {
  UV_FS_SYMLINK_DIR: 1,
  UV_FS_SYMLINK_JUNCTION: 2,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  UV_DIRENT_UNKNOWN: 0,
  UV_DIRENT_FILE: 1,
  UV_DIRENT_DIR: 2,
  UV_DIRENT_LINK: 3,
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o40000,
  S_IFCHR: 0o20000,
  S_IFBLK: 0o60000,
  S_IFIFO: 0o10000,
  S_IFLNK: 0o120000,
  S_IFSOCK: 0o140000,
  O_CREAT: 64,
  O_EXCL: 128,
  O_NOCTTY: 256,
  O_TRUNC: 512,
  O_APPEND: 1024,
  O_DIRECTORY: 65536,
  O_NOFOLLOW: 131072,
  O_SYNC: 1052672,
  O_DSYNC: 4096,
  S_IRWXU: 448,
  S_IRUSR: 256,
  S_IWUSR: 128,
  S_IXUSR: 64,
  S_IRWXG: 56,
  S_IRGRP: 32,
  S_IWGRP: 16,
  S_IXGRP: 8,
  S_IRWXO: 7,
  S_IROTH: 4,
  S_IWOTH: 2,
  S_IXOTH: 1,
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  UV_FS_COPYFILE_EXCL: 1,
  COPYFILE_EXCL: 1,
  UV_FS_COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE: 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4,
  COPYFILE_FICLONE_FORCE: 4,
};

type Watch = { key: string; recursive: boolean; emit: (type: "rename" | "change", rel: string) => void };
const watches = new Set<Watch>();
let subscribed: VFS | undefined;

/** Routes VFS changes to the registered watchers; cheap when nothing is watched (installs write thousands of files). */
function fanOut(k: string, type: "rename" | "change") {
  if (!watches.size) return;
  for (const w of watches) {
    if (k === w.key) w.emit(type, path.basename(k));
    else if (k.startsWith(w.key ? w.key + "/" : "")) {
      const rel = k.slice(w.key ? w.key.length + 1 : 0);
      if (w.recursive || !rel.includes("/")) w.emit(type, rel);
    }
  }
}
function subscribe() {
  if (subscribed === vfs) return;
  subscribed = vfs;
  vfs.onChange((e) => fanOut(e.path, e.created || e.removed ? "rename" : "change"));
  vfs.onDir((d) => fanOut(d, "rename"));
}

class FSWatcher extends EventEmitter {
  private w?: Watch;
  /** @internal */
  start(key: string, recursive: boolean) {
    subscribe();
    this.w = { key, recursive, emit: (type, rel) => setTimeout(() => this.emit("change", type, rel), 0) };
    watches.add(this.w);
    hold(this);
  }
  close() {
    if (this.w) watches.delete(this.w);
    this.w = undefined;
    release(this);
    this.emit("close");
  }
  /** A watcher holds the program (loop.ts) until it is closed or `unref`'d. */
  ref() {
    if (this.w) hold(this);
    return this;
  }
  unref() {
    release(this);
    return this;
  }
}

const watch = (p: unknown, a?: unknown, b?: unknown) => {
  const key = keyOf(toPath(p));
  const w = new FSWatcher();
  const opts = typeof a === "object" && a ? (a as { recursive?: boolean }) : {};
  const listener = typeof a === "function" ? a : b;
  if (typeof listener === "function") w.on("change", listener as () => void);
  if (!exists(key)) throw fsError("ENOENT", "watch", toPath(p));
  w.start(key, !!opts.recursive);
  return w;
};

type StatListener = (cur: Stats, prev: Stats) => void;
const statWatchers = new Map<string, Map<StatListener, Watch>>();
/** Polling `fs.watchFile`: the listener gets (current, previous) stats when the file changes or goes missing. */
const watchFile = (p: unknown, a?: unknown, b?: unknown) => {
  const key = keyOf(toPath(p));
  const listener = (typeof a === "function" ? a : b) as StatListener;
  subscribe();
  let prev = statSync(key, { throwIfNoEntry: false }) ?? (new Stats(false, 0, 0, ""));
  const w: Watch = {
    key,
    recursive: false,
    emit: () =>
      setTimeout(() => {
        const cur = statSync(key, { throwIfNoEntry: false }) ?? (new Stats(false, 0, 0, ""));
        const last = prev;
        prev = cur;
        listener(cur, last);
      }, 0),
  };
  watches.add(w);
  hold(w);
  if (!statWatchers.has(key)) statWatchers.set(key, new Map());
  statWatchers.get(key)!.set(listener, w);
  return new FSWatcher();
};
const unwatchFile = (p: unknown, listener?: StatListener) => {
  const key = keyOf(toPath(p));
  const m = statWatchers.get(key);
  if (!m) return;
  for (const [l, w] of [...m]) if (!listener || l === listener) (watches.delete(w), release(w), m.delete(l));
};

class ReadStream extends (Readable as Any) {
  path: string;
  fd: number | null = null;
  bytesRead = 0;
  pending = true;
  private pos: number;
  private last: number;
  private opts: Any;
  constructor(p: unknown, opts: Any = {}) {
    if (typeof opts === "string") opts = { encoding: opts };
    super({ highWaterMark: opts.highWaterMark ?? 65536, encoding: opts.encoding, autoDestroy: opts.autoClose ?? true, emitClose: opts.emitClose ?? true });
    this.path = toPath(p);
    this.pos = opts.start ?? 0;
    this.last = opts.end ?? Infinity;
    this.opts = opts;
  }
  _construct(cb: (e?: Error | null) => void) {
    try {
      this.fd = typeof this.opts.fd === "number" ? this.opts.fd : openSync(this.path, this.opts.flags ?? "r");
      this.pending = false;
      cb();
      this.emit("open", this.fd);
      this.emit("ready");
    } catch (e) {
      cb(e as Error);
    }
  }
  _read(n: number) {
    try {
      const want = Math.max(0, Math.min(n, this.last - this.pos + 1));
      const buf = Buffer.alloc(want);
      const got = want > 0 ? readSync(this.fd!, buf, 0, want, this.pos) : 0;
      this.pos += got;
      this.bytesRead += got;
      this.push(got > 0 ? buf.subarray(0, got) : null);
    } catch (e) {
      this.destroy(e as Error);
    }
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    if (this.fd !== null && fds.has(this.fd)) closeSync(this.fd);
    cb(err);
  }
  close(cb?: () => void) {
    if (cb) this.once("close", cb);
    this.destroy();
  }
}

class WriteStream extends (Writable as Any) {
  path: string;
  fd: number | null = null;
  bytesWritten = 0;
  pending = true;
  private opts: Any;
  constructor(p: unknown, opts: Any = {}) {
    if (typeof opts === "string") opts = { encoding: opts };
    super({ decodeStrings: true, defaultEncoding: opts.encoding ?? "utf8", autoDestroy: opts.autoClose ?? true, emitClose: opts.emitClose ?? true });
    this.path = toPath(p);
    this.opts = opts;
  }
  _construct(cb: (e?: Error | null) => void) {
    try {
      this.fd = typeof this.opts.fd === "number" ? this.opts.fd : openSync(this.path, this.opts.flags ?? "w");
      this.pending = false;
      cb();
      this.emit("open", this.fd);
      this.emit("ready");
    } catch (e) {
      cb(e as Error);
    }
  }
  _write(chunk: Uint8Array, _enc: string, cb: (e?: Error | null) => void) {
    try {
      this.bytesWritten += writeSync(this.fd!, chunk);
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    if (this.fd !== null && fds.has(this.fd)) closeSync(this.fd);
    cb(err);
  }
  close(cb?: () => void) {
    if (cb) this.once("close", cb);
    this.end();
  }
}

class FileHandle extends EventEmitter {
  constructor(readonly fd: number) {
    super();
  }
  readFile = async (o?: ReadOpts) => readFileSync(this.fd, o);
  writeFile = async (d: unknown, o?: WriteOpts) => writeFileSync(this.fd, d, o);
  appendFile = async (d: unknown, o?: WriteOpts) => writeFileSync(this.fd, d, o);
  stat = async () => fstatSync(this.fd);
  truncate = async (len = 0) => truncateSync("/" + getFd(this.fd, "ftruncate").key, len);
  sync = async () => {};
  datasync = async () => {};
  read = async (buf: Any = Buffer.alloc(16384), a?: Any, b?: number, c?: Any) => ({ bytesRead: readSync(this.fd, buf, a, b, c), buffer: buf });
  write = async (d: Any, a?: Any, b?: Any, c?: Any) => ({ bytesWritten: writeSync(this.fd, d, a, b, c), buffer: d });
  close = async () => closeSync(this.fd);
  createReadStream = (o?: Any) => new ReadStream("/" + getFd(this.fd, "read").key, { ...o, fd: this.fd });
  createWriteStream = (o?: Any) => new WriteStream("/" + getFd(this.fd, "write").key, { ...o, fd: this.fd });
  [Symbol.asyncDispose] = () => this.close();
}

const sync: Record<string, (...a: Any[]) => unknown> = {
  readFileSync,
  writeFileSync: (p, d, o) => writeFileSync(p, d, o),
  appendFileSync,
  statSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  renameSync,
  copyFileSync,
  cpSync,
  accessSync,
  realpathSync,
  readlinkSync: unsupported("readlink", "EINVAL"),
  symlinkSync: (target: unknown) => unsupported("symlink")(target),
  linkSync: unsupported("link"),
  chmodSync: touchSync("chmod"),
  chownSync: touchSync("chown"),
  lchownSync: touchSync("lchown"),
  utimesSync,
  lutimesSync: utimesSync,
  truncateSync,
  mkdtempSync,
};

const syncFd: Record<string, (...a: Any[]) => unknown> = {
  openSync,
  closeSync,
  fstatSync,
  fsyncSync: (fd: number) => void getFd(fd, "fsync"),
  fdatasyncSync: (fd: number) => void getFd(fd, "fdatasync"),
  ftruncateSync: (fd: number, len = 0) => truncateSync("/" + getFd(fd, "ftruncate").key, len),
  fchmodSync: (fd: number) => void getFd(fd, "fchmod"),
  fchownSync: (fd: number) => void getFd(fd, "fchown"),
  futimesSync: (fd: number) => void getFd(fd, "futime"),
};

const fs: Record<string, any> = { constants, ...constants, Stats, Dirent, ReadStream, WriteStream, FSWatcher, readSync, writeSync, ...sync, ...syncFd };

/** `fn(...args, cb)` runs `sync` and calls back on a microtask. */
const callbackOf =
  (run: (...a: Any[]) => unknown, report: (cb: Any, r: unknown, args: Any[]) => void = (cb, r) => (r === undefined ? cb(null) : cb(null, r))) =>
  (...args: Any[]) => {
    const cb = args.pop();
    if (typeof cb !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "cb" argument must be of type function. Received ' + typeof cb);
    let result: unknown;
    let error: unknown = null;
    try {
      result = run(...args);
    } catch (e) {
      error = e;
    }
    queueMicrotask(() => (error ? cb(asyncError(error)) : report(cb, result, args)));
  };

const callbacks: Record<string, Any> = {};
for (const [n, fn] of Object.entries({ ...sync, ...syncFd })) callbacks[n.slice(0, -4)] = callbackOf(fn);
callbacks.exists = (p: unknown, cb: (e: boolean) => void) => {
  let r = false;
  try {
    r = exists(keyOf(toPath(p)));
  } catch {}
  queueMicrotask(() => cb(r));
};
callbacks.read = callbackOf(readSync, (cb, n, [, buf]) => cb(null, n, buf));
callbacks.write = callbackOf(writeSync, (cb, n, [, data]) => cb(null, n, data));
callbacks.realpath.native = callbacks.realpath;
Object.assign(fs, callbacks, {
  existsSync: (p: unknown) => {
    try {
      return exists(keyOf(toPath(p)));
    } catch {
      return false;
    }
  },
  createReadStream: (p: unknown, o?: Any) => new ReadStream(p, o),
  createWriteStream: (p: unknown, o?: Any) => new WriteStream(p, o),
  watch,
  watchFile,
  unwatchFile,
});

// Their promises show their state in console.log once settled (promises.ts).
const promises: Record<string, any> = { constants };
for (const n of "readFile writeFile appendFile stat lstat readdir mkdir rm rmdir unlink rename copyFile cp access realpath readlink symlink link chmod chown lchown utimes lutimes truncate mkdtemp".split(" ")) {
  const fn = sync[n + "Sync"];
  promises[n] = (...args: unknown[]) => tracked((async () => fn(...args))().catch((e) => Promise.reject(asyncError(e))));
}
promises.open = (p: unknown, flags?: string | number, mode?: number) => tracked((async () => new FileHandle(openSync(p, flags, mode)))());
promises.watch = (p: unknown, opts?: { signal?: AbortSignal }) => {
  toPath(p);
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })))),
        return: async () => ({ value: undefined, done: true }),
      };
    },
  };
};
fs.promises = promises;

export default fs;
