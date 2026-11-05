export type FileData = string | Uint8Array;
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
 * own, so a message carrying one file doesn't carry the whole tarball.
 */
export function shareFiles<T extends { data: Uint8Array }>(files: T[]): T[] {
  if (!SAB || !(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) return files.map((f) => ({ ...f, data: f.data.slice() }));
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
  private listeners = new Set<(e: VfsEvent) => void>();
  private dirListeners = new Set<(path: string, removed: boolean) => void>();
  private clearListeners = new Set<() => void>();

  /** Returns the unsubscribe. */
  onChange(fn: (e: VfsEvent) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Fires when a directory is created or removed (file events don't cover empty directories). */
  onDir(fn: (path: string, removed: boolean) => void) {
    this.dirListeners.add(fn);
  }

  /** Fires after `clear` (and so `load`), which drop everything without per-file events. */
  onClear(fn: () => void) {
    this.clearListeners.add(fn);
  }

  read(path: string): FileData | undefined {
    return this.files.get(norm(path));
  }

  readText(path: string): string | undefined {
    const d = this.read(path);
    return d === undefined ? undefined : typeof d === "string" ? d : dec.decode(unshared(d));
  }

  /**
   * The file as text where it is text: a string, or bytes that are valid UTF-8 (installed packages are kept as
   * bytes); null for a binary file, undefined for a missing one.
   */
  textOf(path: string): string | null | undefined {
    const d = this.read(path);
    if (d === undefined || typeof d === "string") return d;
    try {
      return strict.decode(unshared(d));
    } catch {
      return null;
    }
  }

  readBytes(path: string): Uint8Array | undefined {
    const d = this.read(path);
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
    for (const k of [...this.files.keys()]) {
      if (k !== a && !k.startsWith(pre)) continue;
      const data = this.files.get(k)!;
      this.remove(k);
      this.write(b + k.slice(a.length), data);
    }
    for (const d of [...this.dirs]) if (d === a || d.startsWith(pre)) {
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
