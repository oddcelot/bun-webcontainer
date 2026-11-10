import { type VFS, isLazy } from "@runbun/vfs";

// The git worker's copy of the project (worker.ts): the page sends its VFS changes as ops, git runs over the copy, and
// what git changed comes back to the page. Pure functions over two VFS instances, so node can test them (mirror.test.ts).
//
// node_modules stays out: git never needs it (projects ignore it), and its installed packages are large and lazy
// (loaded from the package store on read), so a copy would double the memory for nothing.

/** A file as the copy needs it: its contents and its write time (git's index compares them); none for a file loaded with the project. */
export type FileOp = { path: string; data: string | Uint8Array; mtime?: number };
/** One change to the copy, in order. */
export type Op = { write: FileOp } | { remove: string } | { mkdir: string } | { clear: true };

/** What a git run changed, as the files and directories are after it (not every step on the way). */
export type Changes = { removed: string[]; dirs: string[]; files: FileOp[] };

/** Paths the copy leaves out. */
export const skipped = (path: string) => path === "node_modules" || path.startsWith("node_modules/") || path.includes("/node_modules/") || path.endsWith("/node_modules");

/** The whole project as ops, for a new copy. Lazy files (installed packages) are left out, as node_modules is. */
export function snapshot(vfs: VFS): Op[] {
  const ops: Op[] = [];
  for (const d of vfs.dirs) if (!skipped(d)) ops.push({ mkdir: d });
  for (const [path, data] of vfs.files) {
    if (skipped(path) || isLazy(data)) continue;
    ops.push({ write: { path, data, mtime: vfs.mtimes.get(path) } });
  }
  return ops;
}

/**
 * Follows `vfs`'s changes: `send` gets them batched, once per microtask (or at `flush`). While `applying` (the page taking a git run's
 * result, `apply`, which is synchronous) the events are git's own changes: the copy has them, so they aren't sent back.
 */
export function follow(vfs: VFS, send: (ops: Op[]) => void, applying: () => boolean) {
  let queue: Op[] = [];
  // The project was replaced (`clear`, then `load` without per-file events): the copy starts over from a snapshot,
  // taken once the load is done.
  let reset = false;
  let scheduled = false;
  const flush = () => {
    if (!scheduled) return;
    scheduled = false;
    const ops = reset ? [{ clear: true } as Op, ...snapshot(vfs)] : queue;
    queue = [];
    reset = false;
    if (ops.length) send(ops);
  };
  const push = (op?: Op) => {
    if (!scheduled) queueMicrotask(flush);
    scheduled = true;
    if (op) queue.push(op);
  };
  vfs.onClear(() => {
    reset = true;
    push();
  });
  const offChange = vfs.onChange(({ path, removed }) => {
    if (skipped(path) || applying()) return;
    const data = vfs.read(path);
    if (removed || data === undefined) push({ remove: path });
    else if (!isLazy(data)) push({ write: { path, data, mtime: vfs.mtimes.get(path) } });
  });
  const offDir = vfs.onDir((path, removed) => {
    if (skipped(path) || applying()) return;
    push(removed ? { remove: path } : { mkdir: path });
  });
  return {
    /** Sends what is batched now, e.g. before a command, which must see the changes made just before it. */
    flush,
    stop() {
      offChange();
      offDir();
    },
  };
}

/** Keeps the other side's write time (`write` set now). */
function setMtime(vfs: VFS, f: FileOp) {
  if (f.mtime === undefined) vfs.mtimes.delete(f.path);
  else vfs.mtimes.set(f.path, f.mtime);
}

/** The copy takes the page's ops (the worker). */
export function applyOps(copy: VFS, ops: Op[]) {
  for (const op of ops) {
    if ("write" in op) {
      copy.write(op.write.path, op.write.data);
      setMtime(copy, op.write);
    } else if ("remove" in op) copy.remove(op.remove);
    else if ("mkdir" in op) copy.mkdir(op.mkdir);
    else copy.clear();
  }
}

/** Runs `fn` over the copy and returns what it changed there, as the copy is after it. */
export async function collect(copy: VFS, fn: () => Promise<unknown>): Promise<Changes> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const offChange = copy.onChange(({ path }) => void files.add(path));
  const offDir = copy.onDir((path) => void dirs.add(path));
  try {
    await fn();
  } finally {
    offChange();
    offDir();
  }
  const out: Changes = { removed: [], dirs: [], files: [] };
  for (const d of dirs) (copy.dirs.has(d) ? out.dirs : out.removed).push(d);
  for (const path of files) {
    const data = copy.read(path);
    if (data === undefined || isLazy(data)) out.removed.push(path);
    else out.files.push({ path, data, mtime: copy.mtimes.get(path) });
  }
  // Deepest first, so a removed directory goes after what was in it (removing it removes that too, but no matter).
  out.removed.sort((a, b) => b.length - a.length);
  return out;
}

/** The page takes a git run's changes, keeping git's write times. */
export function apply(vfs: VFS, changes: Changes) {
  for (const path of changes.removed) if (vfs.exists(path)) vfs.remove(path);
  for (const d of changes.dirs) vfs.mkdir(d);
  for (const f of changes.files) {
    vfs.write(f.path, f.data);
    setMtime(vfs, f);
  }
}
