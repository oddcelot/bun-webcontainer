// A SQLite VFS (sqlite3_vfs + sqlite3_io_methods, in JS) over the program's file system: a file database is a real
// file in the worker's VFS, with its `-journal`, `-wal` and `-shm` files next to it as native SQLite on Linux makes
// them, visible to node:fs and Bun.file and mirrored to the page (and so persisted) like any file the program writes.
//
// Each file's bytes live in a growable buffer (`Node`) shared by every handle on it in this worker; the worker's VFS
// entry is a view of it, republished when SQLite syncs (a commit) or closes the file, and when a write sits unsynced
// for a moment, and when it truncates the file (a checkpoint). Republishing doesn't copy: the buffer is copied on the next write instead (copy on write), so a
// reader holding the old view keeps the old bytes. The page gets a copy at most every FLUSH_MS (and on flush()).
//
// Locks (xLock, xCheckReservedLock) and the WAL index (xShmMap, xShmLock) are shared between the handles of this
// worker, so several connections on one file in one program see each other's commits and get SQLITE_BUSY as native
// does. Another worker (a child process) has locks and a WAL index of its own: two processes writing one database
// at once is not coordinated. The `-shm` file is a placeholder of the right size; the WAL index itself is in memory.
import { norm } from "@runbun/vfs";

type Fn = (...args: any[]) => any;

/** What the VFS needs of the file system: the worker's VFS, and a way to send a path's current state to the page. */
export interface Host {
  /** The file's bytes (the caller won't write to them), or undefined when missing or a directory. */
  read(path: string): Uint8Array | undefined;
  exists(path: string): boolean;
  isDir(path: string): boolean;
  /** Sets the file to `data` in the worker's VFS (not to be written to afterwards). */
  write(path: string, data: Uint8Array): void;
  remove(path: string): void;
  /** Sends the path's current state (its bytes, or that it is gone) to the page. */
  mirror(path: string): void;
  /** Runs `fn` after `ms`, without keeping the program alive. */
  later(fn: () => void, ms: number): unknown;
}

const FLUSH_MS = 200;

// sqlite3.h
const OK = 0;
const BUSY = 5;
const NOTFOUND = 12;
const CANTOPEN = 14;
const IOERR_SHORT_READ = 522;
const IOERR_DELETE = 2570;
const OPEN_CREATE = 0x4;
const OPEN_DELETEONCLOSE = 0x8;
const OPEN_EXCLUSIVE = 0x10;
const LOCK_SHARED = 1;
const LOCK_RESERVED = 2;
const LOCK_PENDING = 3;
const LOCK_EXCLUSIVE = 4;
const SHM_UNLOCK = 1;
const SHM_SHARED = 4;
const SHM_EXCLUSIVE = 8;
const ACCESS_EXISTS = 0;
const FCNTL_SIZE_HINT = 5;
const FCNTL_CHUNK_SIZE = 6;
const FCNTL_PERSIST_WAL = 10;
const FCNTL_POWERSAFE_OVERWRITE = 13;
const FCNTL_HAS_MOVED = 20;
const IOCAP_POWERSAFE_OVERWRITE = 0x1000;
/** unix's default (SQLITE_DEFAULT_SECTOR_SIZE); with POWERSAFE_OVERWRITE the pager uses 512 for journal headers. */
const SECTOR_SIZE = 4096;

/** A file's bytes, shared by every handle on it in this worker. */
class Node {
  buf: Uint8Array = new Uint8Array(0);
  size = 0;
  /** `buf` is also the worker VFS's copy: copy it before writing. */
  shared = false;
  /** Written since it was last published. */
  dirty = false;
  /** Deleted while open (unlinked): its handles keep it, the file system no longer has it. */
  deleted = false;
  handles = new Set<Handle>();
  shm: Shm | undefined;
  constructor(readonly path: string | null) {}

  /** Room for `n` bytes, and `buf` ours to write. */
  reserve(n: number) {
    if (n <= this.buf.byteLength && !this.shared) return;
    const next = new Uint8Array(n <= this.buf.byteLength ? this.buf.byteLength : Math.max(n, this.buf.byteLength * 2, 4096));
    next.set(this.buf.subarray(0, this.size));
    this.buf = next;
    this.shared = false;
  }
}

/** The WAL index of a database (its `-shm`): regions in wasm memory, and the slot locks of each handle. */
interface Shm {
  regions: number[];
  size: number;
  handles: Set<Handle>;
}

interface Handle {
  node: Node;
  flags: number;
  lock: number;
  shmShared: number;
  shmExcl: number;
  persistWal: boolean;
  psow: boolean;
}

export interface SqliteVfs {
  name: string;
  /** Publishes every unsynced file and sends the changed ones to the page now (the worker is about to stop). */
  flush(): void;
}

/** Registers the VFS (as `name`) with `sqlite3`, the initialized @sqlite.org/sqlite-wasm module. */
export function installVfs(sqlite3: any, host: Host, name = "runbun"): SqliteVfs {
  const { capi, wasm } = sqlite3 as { capi: Record<string, any>; wasm: Record<string, Fn> & { heap8u(): Uint8Array } };
  const nodes = new Map<string, Node>();
  const handles = new Map<number, Handle>();

  /** Paths whose state the page hasn't seen yet. */
  const unsent = new Set<string>();
  let timer: unknown;
  const flush = () => {
    timer = undefined;
    for (const n of nodes.values()) if (n.dirty) publish(n);
    for (const p of unsent) host.mirror(p);
    unsent.clear();
  };
  const changed = (path: string) => {
    unsent.add(path);
    timer ??= host.later(flush, FLUSH_MS);
  };

  /** Makes the worker's VFS show the node's current bytes. */
  const publish = (n: Node) => {
    n.dirty = false;
    if (n.path === null || n.deleted) return;
    // removed behind SQLite's back (node:fs): it stays gone, as an unlinked file does
    if (!host.exists(n.path)) return void (n.deleted = true);
    host.write(n.path, n.buf.subarray(0, n.size));
    n.shared = true;
    changed(n.path);
  };

  const remove = (path: string) => {
    if (!host.exists(path)) return;
    host.remove(path);
    changed(path);
  };

  const others = (h: Handle) => [...h.node.handles].filter((o) => o !== h);

  const io = new capi.sqlite3_io_methods();
  io.$iVersion = 2;
  const ioMethods: Record<string, Fn> = {
    xClose(pFile: number) {
      const h = handles.get(pFile);
      if (!h) return OK;
      handles.delete(pFile);
      const n = h.node;
      n.handles.delete(h);
      if (n.handles.size) return OK;
      if (h.flags & OPEN_DELETEONCLOSE && n.path !== null) {
        if (!n.deleted) remove(n.path);
        n.deleted = true;
      } else if (n.dirty) publish(n);
      if (n.path !== null && nodes.get(n.path) === n) nodes.delete(n.path);
      return OK;
    },
    xRead(pFile: number, pDest: number, amount: number, offset: bigint) {
      const n = handles.get(pFile)!.node;
      const at = Number(offset);
      const heap = wasm.heap8u();
      const got = Math.max(0, Math.min(amount, n.size - at));
      if (got) heap.set(n.buf.subarray(at, at + got), pDest);
      if (got < amount) {
        heap.fill(0, pDest + got, pDest + amount);
        return IOERR_SHORT_READ;
      }
      return OK;
    },
    xWrite(pFile: number, pSrc: number, amount: number, offset: bigint) {
      const n = handles.get(pFile)!.node;
      const at = Number(offset);
      const end = at + amount;
      n.reserve(end);
      // a write past the end leaves a hole of zeros (the buffer may hold old bytes there)
      if (at > n.size) n.buf.fill(0, n.size, at);
      n.buf.set(wasm.heap8u().subarray(pSrc, pSrc + amount), at);
      if (end > n.size) n.size = end;
      touch(n);
      return OK;
    },
    xTruncate(pFile: number, size: bigint) {
      const n = handles.get(pFile)!.node;
      const to = Number(size);
      if (to === n.size) return OK;
      n.reserve(to);
      if (to > n.size) n.buf.fill(0, n.size, to);
      n.size = to;
      publish(n);
      return OK;
    },
    xSync(pFile: number, _flags: number) {
      const n = handles.get(pFile)!.node;
      if (n.dirty) publish(n);
      return OK;
    },
    xFileSize(pFile: number, pOut: number) {
      wasm.poke64(pOut, BigInt(handles.get(pFile)!.node.size));
      return OK;
    },
    xLock(pFile: number, level: number) {
      const h = handles.get(pFile)!;
      if (h.lock >= level) return OK;
      const rest = others(h);
      if (level === LOCK_SHARED) {
        if (rest.some((o) => o.lock >= LOCK_PENDING)) return BUSY;
      } else if (level === LOCK_RESERVED) {
        if (rest.some((o) => o.lock >= LOCK_RESERVED)) return BUSY;
      } else if (level === LOCK_EXCLUSIVE) {
        // as unix: PENDING first (no new readers), EXCLUSIVE once the other readers are gone
        if (rest.some((o) => o.lock >= LOCK_PENDING)) return BUSY;
        if (rest.some((o) => o.lock >= LOCK_SHARED)) {
          h.lock = LOCK_PENDING;
          return BUSY;
        }
      }
      h.lock = level;
      return OK;
    },
    xUnlock(pFile: number, level: number) {
      const h = handles.get(pFile)!;
      if (h.lock > level) h.lock = level;
      return OK;
    },
    xCheckReservedLock(pFile: number, pOut: number) {
      const h = handles.get(pFile)!;
      wasm.poke32(pOut, others(h).some((o) => o.lock >= LOCK_RESERVED) ? 1 : 0);
      return OK;
    },
    xFileControl(pFile: number, op: number, pArg: number) {
      const h = handles.get(pFile)!;
      const flag = (k: "persistWal" | "psow") => {
        const v = wasm.peek32(pArg);
        if (v < 0) wasm.poke32(pArg, h[k] ? 1 : 0);
        else h[k] = v !== 0;
        return OK;
      };
      switch (op) {
        case FCNTL_PERSIST_WAL:
          return flag("persistWal");
        case FCNTL_POWERSAFE_OVERWRITE:
          return flag("psow");
        case FCNTL_HAS_MOVED:
          wasm.poke32(pArg, h.node.deleted || (h.node.path !== null && !host.exists(h.node.path)) ? 1 : 0);
          return OK;
        case FCNTL_SIZE_HINT:
        case FCNTL_CHUNK_SIZE:
          return OK;
      }
      return NOTFOUND;
    },
    xSectorSize: () => SECTOR_SIZE,
    xDeviceCharacteristics(pFile: number) {
      return handles.get(pFile)?.psow ? IOCAP_POWERSAFE_OVERWRITE : 0;
    },
    xShmMap(pFile: number, region: number, size: number, extend: number, pp: number) {
      const h = handles.get(pFile)!;
      const n = h.node;
      if (!n.shm) {
        n.shm = { regions: [], size, handles: new Set() };
        if (n.path !== null) shmFile(n.path + "-shm", 0);
      }
      const shm = n.shm;
      shm.handles.add(h);
      if (region >= shm.regions.length) {
        if (!extend) {
          wasm.pokePtr(pp, 0);
          return OK;
        }
        while (shm.regions.length <= region) {
          const p = capi.sqlite3_malloc(size);
          if (!p) return capi.SQLITE_NOMEM;
          wasm.heap8u().fill(0, p, p + size);
          shm.regions.push(p);
        }
        if (n.path !== null) shmFile(n.path + "-shm", shm.regions.length * size);
      }
      wasm.pokePtr(pp, shm.regions[region]);
      return OK;
    },
    xShmLock(pFile: number, offset: number, count: number, flags: number) {
      const h = handles.get(pFile)!;
      const mask = ((1 << count) - 1) << offset;
      if (flags & SHM_UNLOCK) {
        h.shmShared &= ~mask;
        h.shmExcl &= ~mask;
        return OK;
      }
      const rest = [...(h.node.shm?.handles ?? [])].filter((o) => o !== h);
      if (flags & SHM_SHARED) {
        if (rest.some((o) => o.shmExcl & mask)) return BUSY;
        h.shmShared |= mask;
      } else if (flags & SHM_EXCLUSIVE) {
        if (rest.some((o) => (o.shmExcl | o.shmShared) & mask)) return BUSY;
        h.shmExcl |= mask;
      }
      return OK;
    },
    xShmBarrier() {},
    xShmUnmap(pFile: number, deleteFlag: number) {
      const h = handles.get(pFile)!;
      const n = h.node;
      h.shmShared = h.shmExcl = 0;
      const shm = n.shm;
      if (!shm) return OK;
      shm.handles.delete(h);
      if (shm.handles.size) return OK;
      for (const p of shm.regions) capi.sqlite3_free(p);
      n.shm = undefined;
      if (deleteFlag && n.path !== null) remove(n.path + "-shm");
      return OK;
    },
  };

  /** The `-shm` file as the file system sees it: zeros of the WAL index's size (the index is in memory). */
  const shmFile = (path: string, size: number) => {
    host.write(path, new Uint8Array(size));
    changed(path);
  };

  /** A write: publish it soon even if SQLite doesn't sync (synchronous=off, a WAL without checkpoint). */
  const touch = (n: Node) => {
    if (n.dirty) return;
    n.dirty = true;
    if (n.path !== null) changed(n.path);
  };

  const vfs = new capi.sqlite3_vfs();
  const base = new capi.sqlite3_vfs(capi.sqlite3_vfs_find(null));
  vfs.$iVersion = 2;
  vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  vfs.$mxPathname = 1024;
  vfs.$xRandomness = base.$xRandomness;
  vfs.$xCurrentTime = base.$xCurrentTime;
  vfs.$xCurrentTimeInt64 = base.$xCurrentTimeInt64;
  base.dispose();

  const pathOf = (z: number) => "/" + norm(wasm.cstrToJs(z) as string);
  const vfsMethods: Record<string, Fn> = {
    xOpen(_pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number) {
      const path = zName ? pathOf(zName) : null;
      let n: Node | undefined;
      if (path === null) n = new Node(null);
      else {
        n = nodes.get(path);
        const exists = !!n || host.exists(path);
        if (host.isDir(path)) return CANTOPEN;
        if (exists && flags & OPEN_EXCLUSIVE && flags & OPEN_CREATE) return CANTOPEN;
        if (!exists && !(flags & OPEN_CREATE)) return CANTOPEN;
        if (!exists && !host.isDir(path.slice(0, path.lastIndexOf("/")) || "/")) return CANTOPEN;
        if (!n) {
          n = new Node(path);
          const data = host.read(path);
          if (data) {
            n.buf = data;
            n.size = data.byteLength;
            n.shared = true;
          } else {
            host.write(path, new Uint8Array(0));
            n.shared = true;
            changed(path);
          }
          nodes.set(path, n);
        }
      }
      const h: Handle = { node: n, flags, lock: 0, shmShared: 0, shmExcl: 0, persistWal: false, psow: true };
      n.handles.add(h);
      handles.set(pFile, h);
      const file = new capi.sqlite3_file(pFile);
      file.$pMethods = io.pointer;
      file.dispose();
      if (pOutFlags) wasm.poke32(pOutFlags, flags);
      return OK;
    },
    xDelete(_pVfs: number, zName: number, _syncDir: number) {
      const path = pathOf(zName);
      const n = nodes.get(path);
      if (n) {
        n.deleted = true;
        n.dirty = false;
        nodes.delete(path);
      }
      if (!host.exists(path) || host.isDir(path)) return n ? OK : IOERR_DELETE;
      remove(path);
      return OK;
    },
    xAccess(_pVfs: number, zName: number, flags: number, pOut: number) {
      const path = pathOf(zName);
      const there = nodes.has(path) || (host.exists(path) && !host.isDir(path));
      wasm.poke32(pOut, there || (flags !== ACCESS_EXISTS && host.isDir(path)) ? 1 : 0);
      return OK;
    },
    xFullPathname(_pVfs: number, zName: number, nOut: number, pOut: number) {
      const full = wasm.allocCString(pathOf(zName));
      try {
        return wasm.cstrncpy(pOut, full, nOut) < nOut ? OK : CANTOPEN;
      } finally {
        wasm.dealloc(full);
      }
    },
    /** Nothing else in this worker can release a lock while it sleeps, but a busy timeout still takes its time. */
    xSleep(_pVfs: number, us: number) {
      const until = performance.now() + us / 1000;
      while (performance.now() < until);
      return us;
    },
    xGetLastError: () => 0,
  };
  sqlite3.vfs.installVfs({ io: { struct: io, methods: ioMethods }, vfs: { struct: vfs, methods: vfsMethods, name } });
  return { name, flush };
}
