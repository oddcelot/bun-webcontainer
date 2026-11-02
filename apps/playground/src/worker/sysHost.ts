// Host side of the `bun_sys` wasm import module: Bun's syscall surface (bun/src/sys/wasm_impl.rs,
// which documents the ABI) served from a VFS. Synchronous on purpose: the VFS lives in this worker.
// Plain erasable TypeScript, so node can run it directly (crates/*/test.mjs need Memory64, which bun lacks).
// Linux numbering throughout (errno, O_* flags, AT_*, S_IF*, DT_*), because wasm_libc.rs does too.
import { type FileData, type VFS, dirname, norm } from "../vfs.ts";

const E = { ENOENT: 2, EBADF: 9, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOTEMPTY: 39, ENOSYS: 38 };
const AT_FDCWD = -100;
const AT_SYMLINK_NOFOLLOW = 0x100;
const AT_REMOVEDIR = 0x200;
const O_ACCMODE = 3, O_CREAT = 0o100, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000, O_DIRECTORY = 0o200000;
const DT_DIR = 4, DT_REG = 8;
const STAT_SIZE = 120;
const START = Date.now();

type OpenFile = { key: string; pos: number; read: boolean; write: boolean; append: boolean; dir: boolean; cursor: number; data?: () => Uint8Array };

class Errno extends Error {
  code: number;
  constructor(code: number) {
    super(`errno ${code}`);
    this.code = code;
  }
}

const bytesOf = (d: FileData): Uint8Array => (typeof d === "string" ? new TextEncoder().encode(d) : d);

/**
 * Builds the `bun_sys` import object. Each VFS gets its own fd table (fds start at 3). With `stdin`, fd 0 reads what it
 * returns (for `bun fmt --stdin-filepath`), from the start whenever it returns a new buffer.
 */
export function createSysImports(vfs: VFS, getMemory: () => WebAssembly.Memory, stdin?: () => Uint8Array) {
  const fds = new Map<number, OpenFile>();
  let stdinSeen: Uint8Array | undefined;
  if (stdin)
    fds.set(0, {
      key: "", pos: 0, read: true, write: false, append: false, dir: false, cursor: 0,
      data() {
        const b = stdin();
        if (b !== stdinSeen) (stdinSeen = b), (this.pos = 0);
        return b;
      },
    });
  let nextFd = 3;
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  // Memory64 pointers arrive as BigInt; the buffer may be replaced by memory.grow, so never cache it.
  const u8 = (ptr: bigint, len: bigint) => new Uint8Array(getMemory().buffer, Number(ptr), Number(len));
  const str = (ptr: bigint, len: bigint) => dec.decode(u8(ptr, len));
  const isFile = (k: string) => vfs.files.has(k);
  const isDir = (k: string) => vfs.isDir(k) || (k !== "" && vfs.exists(k) && !isFile(k));

  /** Resolves a path against `dirfd` (AT_FDCWD = the VFS root) to a normalized VFS key. */
  function resolve(dirfd: number, path: string): string {
    if (path.startsWith("/")) return norm(path);
    if (dirfd === AT_FDCWD) return norm(path);
    const d = fds.get(dirfd);
    if (!d) throw new Errno(E.EBADF);
    if (!d.dir) throw new Errno(E.ENOTDIR);
    return norm(d.key + "/" + path);
  }

  function checkParent(k: string) {
    const parent = dirname(k);
    if (isFile(parent)) throw new Errno(E.ENOTDIR);
    if (!isDir(parent)) throw new Errno(E.ENOENT);
  }

  const getFd = (fd: number) => {
    const f = fds.get(fd);
    if (!f) throw new Errno(E.EBADF);
    return f;
  };

  function fileBytes(f: OpenFile): Uint8Array {
    if (f.data) return f.data();
    const d = vfs.files.get(f.key);
    return d === undefined ? new Uint8Array(0) : bytesOf(d);
  }

  function readAt(f: OpenFile, ptr: bigint, len: bigint, at: number): number {
    if (f.dir) throw new Errno(E.EISDIR);
    if (!f.read) throw new Errno(E.EBADF);
    const data = fileBytes(f);
    const n = Math.max(0, Math.min(Number(len), data.length - at));
    u8(ptr, BigInt(n)).set(data.subarray(at, at + n));
    return n;
  }

  function writeAt(f: OpenFile, src: Uint8Array, at: number | null): number {
    if (f.dir) throw new Errno(E.EISDIR);
    if (!f.write) throw new Errno(E.EBADF);
    const cur = fileBytes(f);
    const pos = f.append ? cur.length : (at ?? f.pos);
    const out = new Uint8Array(Math.max(cur.length, pos + src.length));
    out.set(cur);
    out.set(src, pos);
    vfs.write(f.key, out);
    if (at === null) f.pos = pos + src.length;
    return src.length;
  }

  function writeStat(out: bigint, key: string, mode: "file" | "dir") {
    const dv = new DataView(getMemory().buffer, Number(out), STAT_SIZE);
    const dir = mode === "dir";
    const size = dir ? 4096 : bytesOf(vfs.files.get(key)!).length;
    const mtime = dir ? START : (vfs.mtimes.get(key) ?? START);
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
    const sec = BigInt(Math.floor(mtime / 1000));
    const nsec = BigInt((mtime % 1000) * 1_000_000);
    dv.setBigUint64(0, 1n, true); // st_dev
    dv.setBigUint64(8, BigInt(h + 1), true); // st_ino
    dv.setBigUint64(16, 1n, true); // st_nlink
    dv.setUint32(24, dir ? 0o40755 : 0o100644, true); // st_mode
    dv.setUint32(28, 1000, true); // st_uid
    dv.setUint32(32, 1000, true); // st_gid
    dv.setBigUint64(40, 0n, true); // st_rdev
    dv.setBigInt64(48, BigInt(size), true); // st_size
    dv.setBigInt64(56, 4096n, true); // st_blksize
    dv.setBigInt64(64, BigInt(Math.ceil(size / 512)), true); // st_blocks
    for (const off of [72, 88, 104]) {
      dv.setBigInt64(off, sec, true); // st_atime / st_mtime / st_ctime
      dv.setBigInt64(off + 8, nsec, true); // ..._nsec
    }
  }

  function statKey(k: string, out: bigint) {
    if (isFile(k)) writeStat(out, k, "file");
    else if (isDir(k)) writeStat(out, k, "dir");
    else throw new Errno(E.ENOENT);
  }

  /** Runs `f`, mapping a thrown Errno to -errno. Anything else is a bug and propagates. */
  const guard = (f: () => number | bigint): bigint => {
    try {
      return BigInt(f());
    } catch (e) {
      if (e instanceof Errno) return BigInt(-e.code);
      throw e;
    }
  };

  const bun_sys = {
    open: (dirfd: number, path: bigint, len: bigint, flags: number, _mode: number) =>
      guard(() => {
        const k = resolve(dirfd, str(path, len));
        const write = (flags & O_ACCMODE) !== 0;
        const dir = isDir(k);
        if (dir) {
          if (write) throw new Errno(E.EISDIR);
        } else if (isFile(k)) {
          if (flags & O_DIRECTORY) throw new Errno(E.ENOTDIR);
          if (flags & O_CREAT && flags & O_EXCL) throw new Errno(E.EEXIST);
          if (flags & O_TRUNC && write) vfs.write(k, "");
        } else {
          if (!(flags & O_CREAT)) throw new Errno(E.ENOENT);
          checkParent(k);
          vfs.write(k, "");
        }
        const fd = nextFd++;
        fds.set(fd, { key: k, pos: 0, read: (flags & O_ACCMODE) !== 1, write, append: !!(flags & O_APPEND), dir, cursor: 0 });
        return fd;
      }),
    close: (fd: number) =>
      guard(() => {
        getFd(fd);
        fds.delete(fd);
        return 0;
      }),
    read: (fd: number, buf: bigint, len: bigint) =>
      guard(() => {
        const f = getFd(fd);
        f.data?.(); // stdin: rewinds for a new buffer before `pos` is read
        const n = readAt(f, buf, len, f.pos);
        f.pos += n;
        return n;
      }),
    write: (fd: number, buf: bigint, len: bigint) => guard(() => writeAt(getFd(fd), u8(buf, len).slice(), null)),
    pread: (fd: number, buf: bigint, len: bigint, off: bigint) => guard(() => readAt(getFd(fd), buf, len, Number(off))),
    pwrite: (fd: number, buf: bigint, len: bigint, off: bigint) => guard(() => writeAt(getFd(fd), u8(buf, len).slice(), Number(off))),
    lseek: (fd: number, off: bigint, whence: number) =>
      guard(() => {
        const f = getFd(fd);
        const size = f.dir ? 0 : fileBytes(f).length;
        const to = whence === 0 ? Number(off) : whence === 1 ? f.pos + Number(off) : whence === 2 ? size + Number(off) : -1;
        if (to < 0) throw new Errno(E.EINVAL);
        return (f.pos = to);
      }),
    stat: (dirfd: number, path: bigint, len: bigint, _flags: number, out: bigint) => guard(() => (statKey(resolve(dirfd, str(path, len)), out), 0)),
    fstat: (fd: number, out: bigint) => guard(() => (statKey(getFd(fd).key, out), 0)),
    mkdir: (dirfd: number, path: bigint, len: bigint, _mode: number, recursive: number) =>
      guard(() => {
        const k = resolve(dirfd, str(path, len));
        if (k === "" || isDir(k)) {
          if (recursive) return 0;
          throw new Errno(E.EEXIST);
        }
        if (isFile(k)) throw new Errno(recursive ? E.ENOTDIR : E.EEXIST);
        if (!recursive) checkParent(k);
        else for (let p = dirname(k); p !== ""; p = dirname(p)) if (isFile(p)) throw new Errno(E.ENOTDIR);
        vfs.mkdir(k);
        return 0;
      }),
    unlink: (dirfd: number, path: bigint, len: bigint, flags: number) =>
      guard(() => {
        const k = resolve(dirfd, str(path, len));
        if (flags & AT_REMOVEDIR) {
          if (isFile(k)) throw new Errno(E.ENOTDIR);
          if (k === "" || !isDir(k)) throw new Errno(E.ENOENT);
          if (vfs.readdir(k).length) throw new Errno(E.ENOTEMPTY);
        } else {
          if (isDir(k)) throw new Errno(E.EISDIR);
          if (!isFile(k)) throw new Errno(E.ENOENT);
        }
        vfs.remove(k);
        return 0;
      }),
    rename: (fromDir: number, from: bigint, flen: bigint, toDir: number, to: bigint, tlen: bigint) =>
      guard(() => {
        const a = resolve(fromDir, str(from, flen));
        const b = resolve(toDir, str(to, tlen));
        if (!vfs.exists(a) || a === "") throw new Errno(E.ENOENT);
        checkParent(b);
        if (isFile(a) && isDir(b)) throw new Errno(E.EISDIR);
        if (isDir(a) && isFile(b)) throw new Errno(E.ENOTDIR);
        if (a === b) return 0;
        if (isDir(a) && !isFile(b) && isDir(b) && vfs.readdir(b).length) throw new Errno(E.ENOTEMPTY);
        vfs.remove(b);
        vfs.rename(a, b);
        return 0;
      }),
    /** Next batch of directory records for an open directory fd; 0 = end. */
    getdents: (fd: number, buf: bigint, len: bigint) =>
      guard(() => {
        const f = getFd(fd);
        if (!f.dir) throw new Errno(E.ENOTDIR);
        const entries = vfs.readdir(f.key);
        const out = u8(buf, len);
        let n = 0;
        while (f.cursor < entries.length) {
          const e = entries[f.cursor];
          const name = enc.encode(e.name);
          const rec = 4 + name.length + 1;
          if (n + rec > out.length) {
            if (n === 0) throw new Errno(E.EINVAL); // buffer too small for one record
            break;
          }
          out[n] = e.dir ? DT_DIR : DT_REG;
          out[n + 1] = 0;
          out[n + 2] = name.length & 0xff;
          out[n + 3] = name.length >> 8;
          out.set(name, n + 4);
          out[n + 4 + name.length] = 0;
          n += rec;
          f.cursor++;
        }
        return n;
      }),
    /** Writes the cwd (always "/") without NUL; returns its length. */
    getcwd: (buf: bigint, len: bigint) =>
      guard(() => {
        if (Number(len) < 2) throw new Errno(34 /* ERANGE */);
        u8(buf, 1n)[0] = 0x2f;
        return 1;
      }),
  };
  return { bun_sys };
}
