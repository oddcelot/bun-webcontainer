/**
 * A large installed file kept out of memory: `size` bytes at `at` in package-store entry `lazy` (the playground's
 * pkgStore.ts). A plain object, so it travels to workers in messages. Read it with `data`, `readText`, `readBytes`
 * or `textOf` (which load it), or load it ahead with `ensure` where blocking isn't possible (the page).
 */
export type LazyData = { lazy: string; at: number; size: number };
export type FileData = string | Uint8Array | LazyData;
/** Loaded contents. */
export type FileContents = string | Uint8Array;

export const isLazy = (d: FileData | undefined): d is LazyData => typeof d === "object" && d !== null && "lazy" in d;

/** A synchronous read of a lazy file where loading can't block (the page): `ensure` it, then try again. */
export class LazyMiss extends Error {
  readonly paths: string[];
  constructor(...paths: string[]) {
    super(`${paths.join(", ")} isn't loaded yet`);
    this.paths = paths;
  }
}

/**
 * Runs `fn`, loading each lazy file it reads synchronously and running it again, until it gets through. For page code
 * that reads files it can't know up front (the module server following requires). `fn` must be safe to repeat.
 */
export async function withLoaded<T>(vfs: VFS, fn: () => Promise<T> | T): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof LazyMiss)) throw e;
      await vfs.ensure(e.paths);
    }
  }
}
export type VfsEvent = { path: string; created: boolean; removed?: boolean };

export function norm(p: string): string {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

export const dirname = (p: string) => p.split("/").slice(0, -1).join("/");

const dec = new TextDecoder();
const enc = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

const SAB = typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : undefined;
/**
 * Installed packages can sit in shared memory (see `shareFiles`), handed to workers without a copy. Many Web APIs
 * refuse views of it (TextDecoder, Blob, Response, crypto.subtle, messages to the service worker), so readers get a
 * copy: `readText`, `textOf` and `readBytes` never return shared memory; `read` and `files` can.
 */
export const unshared = (u: Uint8Array): Uint8Array => (SAB && u.buffer instanceof SAB ? u.slice() : u);

/**
 * Copies the files of one package (views of its unpacked tarball) into one SharedArrayBuffer where the page is
 * cross-origin isolated: posting them to a worker shares them instead of copying. Elsewhere each gets a buffer of its
 * own, so a message carrying one file doesn't carry the whole tarball. `share: false` for a worker on another origin
 * (a content origin), where a shared buffer in a message can't be delivered (`messageerror`).
 */
export function shareFiles<T extends { data: Uint8Array }>(files: T[], share = true): T[] {
  if (!share || !SAB || !(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) return files.map((f) => ({ ...f, data: f.data.slice() }));
  let size = 0;
  for (const f of files) size += f.data.byteLength;
  const mem = new Uint8Array(new SAB(size));
  let at = 0;
  return files.map((f) => {
    mem.set(f.data, at);
    const data = mem.subarray(at, (at += f.data.byteLength));
    return { ...f, data };
  });
}

export class VFS {
  readonly files = new Map<string, FileData>();
  readonly dirs = new Set<string>();
  /** Last write time (ms) per file; files without one count as written at startup. */
  readonly mtimes = new Map<string, number>();
  /** Loads a lazy file synchronously: a worker, blocking until the page has read it. Unset on the page. */
  loadSync?: (path: string, ref: LazyData) => Uint8Array;
  /** Loads a lazy file asynchronously (the page, from the package store). */
  loadAsync?: (path: string, ref: LazyData) => Promise<Uint8Array>;
  private listeners = new Set<(e: VfsEvent) => void>();
  private dirListeners = new Set<(path: string, removed: boolean) => void>();
  private clearListeners = new Set<() => void>();

  /** Returns the unsubscribe. */
  onChange(fn: (e: VfsEvent) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Fires when a directory is created or removed (file events don't cover empty directories). Returns the unsubscribe. */
  onDir(fn: (path: string, removed: boolean) => void) {
    this.dirListeners.add(fn);
    return () => void this.dirListeners.delete(fn);
  }

  /** Fires after `clear` (and so `load`), which drop everything without per-file events. */
  onClear(fn: () => void) {
    this.clearListeners.add(fn);
  }

  /** The entry as stored: a lazy file stays a reference (see `data`). */
  read(path: string): FileData | undefined {
    return this.files.get(norm(path));
  }

  /** The file's contents, loading a lazy file; throws for one where loading can't block (the page: `ensure` first). */
  data(path: string): FileContents | undefined {
    const p = norm(path);
    const d = this.files.get(p);
    if (!isLazy(d)) return d;
    if (!this.loadSync) throw new LazyMiss(p);
    return this.adopt(p, d, this.loadSync(p, d));
  }

  /** Keeps loaded bytes for a lazy file, if it's still that file. No change event: the contents didn't change. */
  adopt(path: string, ref: LazyData, bytes: Uint8Array): Uint8Array {
    const p = norm(path);
    const d = this.files.get(p);
    if (isLazy(d) && d.lazy === ref.lazy && d.at === ref.at) this.files.set(p, bytes);
    return bytes;
  }

  /** Loads the lazy files among `paths`, so synchronous reads of them work where they can't block. */
  async ensure(paths: Iterable<string>): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const path of paths) {
      const p = norm(path);
      const d = this.files.get(p);
      if (!isLazy(d)) continue;
      if (this.loadAsync) work.push(this.loadAsync(p, d).then((b) => this.adopt(p, d, b)));
      else this.data(p);
    }
    await Promise.all(work);
  }

  /** A file's size in bytes (a lazy one without loading it); undefined when missing. */
  size(path: string): number | undefined {
    const d = this.read(path);
    return d === undefined ? undefined : typeof d === "string" ? enc.encode(d).length : isLazy(d) ? d.size : d.byteLength;
  }

  readText(path: string): string | undefined {
    const d = this.data(path);
    return d === undefined ? undefined : typeof d === "string" ? d : dec.decode(unshared(d));
  }

  /**
   * The file as text where it is text: a string, or bytes that are valid UTF-8 (installed packages are kept as
   * bytes); null for a binary file, undefined for a missing one.
   */
  textOf(path: string): string | null | undefined {
    const d = this.data(path);
    if (d === undefined || typeof d === "string") return d;
    try {
      return strict.decode(unshared(d));
    } catch {
      return null;
    }
  }

  readBytes(path: string): Uint8Array | undefined {
    const d = this.data(path);
    return d === undefined ? undefined : typeof d === "string" ? enc.encode(d) : unshared(d);
  }

  write(path: string, data: FileData) {
    const p = norm(path);
    const created = !this.files.has(p);
    this.files.set(p, data);
    this.mtimes.set(p, Date.now());
    if (created) this.mkdir(dirname(p));
    for (const fn of this.listeners) fn({ path: p, created });
  }

  /** Drops every file and directory, e.g. before loading another project. */
  clear() {
    this.files.clear();
    this.dirs.clear();
    this.mtimes.clear();
    for (const fn of this.clearListeners) fn();
  }

  /** Replaces the contents with another VFS's snapshot (the worker's copy of the page VFS). */
  load(files: Map<string, FileData>, dirs: Set<string>) {
    this.clear();
    for (const [k, v] of files) this.files.set(k, v);
    for (const d of dirs) this.dirs.add(d);
  }

  isDir(path: string): boolean {
    const p = norm(path);
    return p === "" || this.dirs.has(p);
  }

  /** Direct children of a directory. */
  readdir(path: string): { name: string; dir: boolean }[] {
    const p = norm(path);
    const pre = p ? p + "/" : "";
    const out = new Map<string, boolean>();
    for (const k of this.files.keys()) if (k.startsWith(pre)) {
      const rest = k.slice(pre.length);
      const i = rest.indexOf("/");
      if (i < 0) out.set(rest, false);
      else out.set(rest.slice(0, i), true);
    }
    for (const d of this.dirs) if (d.startsWith(pre) && d.length > pre.length) out.set(d.slice(pre.length).split("/")[0], true);
    return [...out].map(([name, dir]) => ({ name, dir })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Deletes a file, or a directory with everything below it. */
  remove(path: string) {
    const p = norm(path);
    const pre = p + "/";
    for (const k of [...this.files.keys()]) {
      if (k !== p && !k.startsWith(pre)) continue;
      this.files.delete(k);
      this.mtimes.delete(k);
      for (const fn of this.listeners) fn({ path: k, created: false, removed: true });
    }
    for (const d of [...this.dirs]) if (d === p || d.startsWith(pre)) {
      this.dirs.delete(d);
      for (const fn of this.dirListeners) fn(d, true);
    }
  }

  /** Moves a file, or a directory with everything below it. */
  rename(from: string, to: string) {
    const a = norm(from);
    const b = norm(to);
    const pre = a + "/";
    // The directories to move, taken before moving files creates the target's (a -> a/b makes a/b).
    const dirs = [...this.dirs].filter((d) => d === a || d.startsWith(pre));
    for (const k of [...this.files.keys()]) {
      if (k !== a && !k.startsWith(pre)) continue;
      const data = this.files.get(k)!;
      this.remove(k);
      this.write(b + k.slice(a.length), data);
    }
    for (const d of dirs) {
      // Moving a directory into its own subtree (a -> a/b) keeps it as the target's parent. Removing it would be
      // recursive for listeners (the worker's mirror), taking the files just moved below it.
      if (b.startsWith(d + "/")) continue;
      this.dirs.delete(d);
      for (const fn of this.dirListeners) fn(d, true);
      this.mkdir(b + d.slice(a.length));
    }
  }

  mkdir(path: string) {
    const parts = norm(path).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (this.dirs.has(d)) continue;
      this.dirs.add(d);
      for (const fn of this.dirListeners) fn(d, false);
    }
  }

  exists(path: string): boolean {
    const p = norm(path);
    if (p === "" || this.files.has(p) || this.dirs.has(p)) return true;
    for (const k of this.files.keys()) if (k.startsWith(p + "/")) return true;
    return false;
  }

  list(prefix = ""): string[] {
    const p = norm(prefix);
    const pre = p ? p + "/" : "";
    return [...this.files.keys()].filter((k) => k.startsWith(pre)).sort();
  }
}
