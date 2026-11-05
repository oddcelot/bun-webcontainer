import { bucket } from "./storage";
import type { FileContents as FileData, VFS } from "@runbun/vfs";

type Log = (level: string, text: string) => void;
type Dir = FileSystemDirectoryHandle;

/** Paths that are never saved: they come back from `bun install` or the source. */
export const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;
const DEBOUNCE = 300;

/**
 * OPFS writes are async and don't finish before the page unloads, so unsaved files also go to sessionStorage on
 * pagehide (synchronous, kept across a reload in the same tab). `attach` replays them and saves them for real.
 * Values are file text, or null for a deleted file; binary files aren't stashed.
 */
const stashKey = (id: string) => "bwc-unsaved:" + id;

/** Project id for a share link: the first 16 hex of the SHA-256 of its payload. */
export async function shareProjectId(hash: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hash));
  return "share:" + [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const projects = () => bucket("projects", { durability: "strict" });

async function copyDir(from: Dir, to: Dir) {
  for await (const [name, h] of from as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind === "directory") await copyDir(h as Dir, await to.getDirectoryHandle(name, { create: true }));
    else {
      const w = await (await to.getFileHandle(name, { create: true })).createWritable();
      try {
        await w.write(await (h as FileSystemFileHandle).getFile());
      } finally {
        await w.close();
      }
    }
  }
}

let moved: Promise<void> | undefined;
/**
 * Projects saved before the `projects` bucket existed sit in the default storage: copy each one over, then delete
 * it. A move cut short copies again next time, so nothing is lost.
 */
function moveOldProjects(): Promise<void> {
  return (moved ??= (async () => {
    const b = await projects();
    if (!b.own) return;
    const move = async () => {
      const old = await (await navigator.storage.getDirectory()).getDirectoryHandle("projects").catch(() => null);
      if (!old) return;
      const to = await (await b.getDirectory()).getDirectoryHandle("projects", { create: true });
      for await (const [name, h] of old as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        if (h.kind !== "directory") continue;
        await copyDir(h as Dir, await to.getDirectoryHandle(name, { create: true }));
        await old.removeEntry(name, { recursive: true });
      }
      await (await navigator.storage.getDirectory()).removeEntry("projects", { recursive: true });
    };
    await (navigator.locks ? navigator.locks.request("bwc-move-projects", move) : move());
  })().catch(() => {}));
}

/** The project's OPFS directory (null when missing and `create` is off). */
async function projectDir(id: string, create: boolean): Promise<Dir | null> {
  try {
    await moveOldProjects();
    const root = await (await projects()).getDirectory();
    const projectsDir = await root.getDirectoryHandle("projects", { create });
    return await projectsDir.getDirectoryHandle(encodeURIComponent(id), { create });
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return null;
    throw e;
  }
}

async function walk(dir: Dir, prefix: string, out: [string, File][]) {
  for await (const [name, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (SKIP.test(prefix + name)) continue;
    if (h.kind === "directory") await walk(h as Dir, `${prefix}${name}/`, out);
    else out.push([prefix + name, await (h as FileSystemFileHandle).getFile()]);
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
/** A file's contents as text where it decodes as UTF-8, else bytes. */
async function contents(file: File): Promise<FileData> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return utf8.decode(bytes);
  } catch {
    return bytes;
  }
}

/** Every file below `dir` but node_modules and .git, as text where it decodes as UTF-8, else bytes. */
export async function readDir(dir: Dir, prefix = ""): Promise<[string, FileData][]> {
  const found: [string, File][] = [];
  await walk(dir, prefix, found);
  return Promise.all(found.map(async ([path, file]): Promise<[string, FileData]> => [path, await contents(file)]));
}

const same = (a: FileData | null | undefined, b: FileData | null | undefined) =>
  a === b ||
  (a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]));

/** Loads the saved files of a project into the VFS; returns how many (0 when nothing is saved or OPFS fails). */
export async function restore(id: string, vfs: VFS, log: Log): Promise<number> {
  try {
    const dir = await projectDir(id, false);
    if (!dir) return 0;
    const files = await readDir(dir);
    for (const [path, data] of files) vfs.write(path, data);
    return files.length;
  } catch (e) {
    log("warn", `[storage] can't read saved files: ${e}`);
    return 0;
  }
}

/** Deletes a project's saved files. */
export async function discard(id: string): Promise<void> {
  await moveOldProjects();
  const root = await (await projects()).getDirectory();
  const dir = await root.getDirectoryHandle("projects").catch(() => null);
  await dir?.removeEntry(encodeURIComponent(id), { recursive: true }).catch(() => {});
  try {
    sessionStorage.removeItem(stashKey(id));
  } catch {}
}

export type SavedProject = { id: string; files: number; bytes: number; modified: number };

async function measure(dir: Dir, p: SavedProject) {
  for await (const [, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind === "directory") await measure(h as Dir, p);
    else {
      const f = await (h as FileSystemFileHandle).getFile();
      p.files++;
      p.bytes += f.size;
      p.modified = Math.max(p.modified, f.lastModified);
    }
  }
}

/** Every saved project with its size and when a file in it last changed, newest first. */
export async function listProjects(): Promise<SavedProject[]> {
  await moveOldProjects();
  const root = await (await projects()).getDirectory();
  const dir = await root.getDirectoryHandle("projects").catch(() => null);
  const out: SavedProject[] = [];
  for await (const [name, h] of (dir ?? []) as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind !== "directory") continue;
    const p = { id: decodeURIComponent(name), files: 0, bytes: 0, modified: 0 };
    await measure(h as Dir, p);
    out.push(p);
  }
  return out.sort((a, b) => b.modified - a.modified);
}

const LOCK = "bwc-project:";
/** Ids of the projects a tab saves into (it holds their lock until it closes), this tab's included. */
export async function heldProjects(): Promise<Set<string>> {
  const q = await navigator.locks?.query().catch(() => undefined);
  return new Set((q?.held ?? []).flatMap((l) => (l.name?.startsWith(LOCK) ? [l.name.slice(LOCK.length)] : [])));
}

/** Whether the browser keeps saved projects when space runs low; `ask`: request that first. */
export async function projectsKept(ask = false): Promise<boolean> {
  const b = await projects();
  return (ask && (await b.persist().catch(() => false))) || (await b.persisted().catch(() => false));
}

/**
 * Mirrors the VFS into OPFS (`projects/<id>/`), write-behind (see `mirror`). `all` saves every file now (a project
 * just loaded from its source). Only the tab holding the project's lock writes. Never throws; returns a function that
 * stops saving and settles once a flush in progress is done.
 */
export async function attach(id: string, vfs: VFS, log: Log, all: boolean): Promise<() => Promise<void>> {
  const off = async () => {};
  try {
    if (!navigator.storage?.getDirectory) throw new Error("OPFS is not available");
    if (navigator.locks) {
      const got = await new Promise<boolean>((resolve) => {
        // Held until the page goes away.
        void navigator.locks.request(LOCK + id, { ifAvailable: true }, (lock) => {
          resolve(!!lock);
          return lock ? new Promise<void>(() => {}) : undefined;
        });
      });
      if (!got) {
        log("warn", "[storage] project open in another tab; changes here won't be saved");
        return off;
      }
    }
    const dir = await projectDir(id, true);
    if (!dir) throw new Error("can't create the project directory");
    return mirror(dir, vfs, log, {
      all,
      stash: stashKey(id),
      tag: "[storage]",
      // Asked on the first save, not on every visit.
      onFirstFlush: () => void projects().then((b) => b.persist()).catch(() => {}),
    });
  } catch (e) {
    log("warn", `[storage] saving is unavailable (${e}); this project won't be kept across reloads`);
    return off;
  }
}

type MirrorOptions = {
  /** Write every file now, not only changed ones. */
  all: boolean;
  /** sessionStorage key for files a reload cut off (see `stashKey`); replayed first. */
  stash?: string;
  /** Log prefix. */
  tag: string;
  onFirstFlush?: () => void;
  /** Also bring changes made to `dir` from outside (another editor) into the VFS, where FileSystemObserver exists. */
  watch?: boolean;
};

/** FileSystemObserver (Chromium 129+), not in TypeScript's DOM types yet. */
type ChangeRecord = {
  relativePathComponents: string[];
  relativePathMovedFrom?: string[] | null;
  type: "appeared" | "disappeared" | "modified" | "moved" | "unknown" | "errored";
};
type Observer = { observe(dir: Dir, options: { recursive: boolean }): Promise<void>; disconnect(): void };
type ObserverClass = new (callback: (records: ChangeRecord[]) => void) => Observer;

/**
 * Writes VFS changes into `dir` (OPFS or a folder on disk), write-behind: changes are collected and flushed after a
 * short pause, and on pagehide. node_modules and .git are left alone. Returns a function that stops writing and
 * settles once a flush in progress is done.
 */
export function mirror(dir: Dir, vfs: VFS, log: Log, { all, stash: stashAt, tag, onFirstFlush, watch }: MirrorOptions): () => Promise<void> {
  let stopped = false;
  const dirty = new Set<string>();
  /** What `dir` is known to hold per path (null: nothing), from our writes and from outside changes read back. */
  const onDisk = new Map<string, FileData | null>();
  /** Taken out of `dirty` by the flush in progress, not yet written. */
  const writing = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let warned = false;
  let flushed = false;
  const writeOne = async (path: string) => {
    const parts = path.split("/");
    const name = parts.pop()!;
    const data = vfs.data(path);
    if (data === undefined) {
      // Gone from the VFS: delete the entry, then prune parents left empty.
      const dirs: Dir[] = [dir];
      try {
        for (const p of parts) dirs.push(await dirs[dirs.length - 1].getDirectoryHandle(p));
        await dirs[dirs.length - 1].removeEntry(name);
        onDisk.set(path, null);
      } catch (e) {
        if (e instanceof DOMException && e.name === "NotFoundError") return;
        throw e;
      }
      for (let i = dirs.length - 1; i > 0; i--) {
        let empty = true;
        for await (const _ of dirs[i] as unknown as AsyncIterable<unknown>) {
          empty = false;
          break;
        }
        if (!empty) break;
        await dirs[i - 1].removeEntry(parts[i - 1]).catch(() => {});
      }
      return;
    }
    let d = dir;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(name, { create: true })).createWritable();
    try {
      await w.write(data as FileSystemWriteChunkType);
    } finally {
      await w.close();
    }
    onDisk.set(path, data);
  };

  // Flushes run one after another, never overlapping.
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    chain = chain.then(async () => {
      if (stopped) return;
      if (!flushed) {
        flushed = true;
        onFirstFlush?.();
      }
      const paths = [...dirty];
      dirty.clear();
      for (const p of paths) writing.add(p);
      for (const path of paths) {
        if (stopped) return;
        try {
          await writeOne(path);
        } catch (e) {
          if (!warned) {
            warned = true;
            log("warn", `${tag} can't save ${path}: ${e}`);
          }
        }
        writing.delete(path);
      }
      if (stashAt && !dirty.size && !writing.size) {
        try {
          sessionStorage.removeItem(stashAt);
        } catch {}
      }
    });
    return chain;
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE);
  };

  // Edits a reload cut off last time: back into the VFS, then saved like any other change.
  if (stashAt) {
    try {
      const stash: Record<string, string | null> = JSON.parse(sessionStorage.getItem(stashAt) ?? "{}");
      for (const [path, data] of Object.entries(stash)) {
        if (data === null) vfs.remove(path);
        else vfs.write(path, data);
        dirty.add(path);
      }
      if (dirty.size) schedule();
    } catch {}
  }

  const unsub = vfs.onChange(({ path }) => {
    if (stopped || SKIP.test(path)) return;
    // Already what the folder holds: an outside change just read in, or an edit undone.
    const known = onDisk.get(path);
    if (known !== undefined && same(known, vfs.data(path) ?? null)) return;
    dirty.add(path);
    schedule();
  });
  const onHide = () => {
    if (document.visibilityState !== "hidden" || !(dirty.size || writing.size)) return;
    if (stashAt) {
      const stash: Record<string, string | null> = {};
      for (const path of [...writing, ...dirty]) {
        const data = vfs.data(path);
        if (data === undefined) stash[path] = null;
        else if (typeof data === "string") stash[path] = data;
      }
      try {
        sessionStorage.setItem(stashAt, JSON.stringify(stash));
      } catch (e) {
        log("warn", `${tag} can't keep unsaved files across the reload: ${e}`);
      }
    }
    if (dirty.size) void flush();
  };
  document.addEventListener("visibilitychange", onHide);
  addEventListener("pagehide", onHide);
  if (all) {
    for (const p of vfs.files.keys()) if (!SKIP.test(p)) dirty.add(p);
    schedule();
  }
  const unwatch = watch ? observe() : undefined;

  /**
   * Outside changes to `dir`, into the VFS. A path with a local change not yet written is left alone (the local
   * change wins and overwrites it); one that holds what we wrote, or what the VFS has, is no change.
   */
  function observe(): (() => void) | undefined {
    const FSO = (globalThis as { FileSystemObserver?: ObserverClass }).FileSystemObserver;
    if (!FSO) return;
    /** Chrome's temporary files for a write in progress (`createWritable`, ours included). */
    const TEMP = /\.crswap$/;
    let queue = Promise.resolve();
    const local = (path: string) => dirty.has(path) || writing.has(path);
    const take = (path: string, data: FileData | null) => {
      if (SKIP.test(path) || TEMP.test(path) || local(path)) return;
      const known = onDisk.get(path);
      if (same(data, vfs.data(path) ?? null) || (known !== undefined && same(data, known))) return;
      onDisk.set(path, data);
      if (data === null) vfs.remove(path);
      else vfs.write(path, data);
    };
    /** Everything at `path` (a file, a folder, or nothing) as it is on disk now. */
    const sync = async (parts: string[]) => {
      const path = parts.join("/");
      if (SKIP.test(path) || TEMP.test(path)) return;
      let handle: FileSystemHandle | null = dir;
      try {
        for (const [i, p] of parts.entries()) {
          const d = handle as Dir;
          handle = i < parts.length - 1 ? await d.getDirectoryHandle(p) : await d.getFileHandle(p).catch(() => d.getDirectoryHandle(p));
        }
      } catch (e) {
        if (!(e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError"))) throw e;
        handle = null;
      }
      if (handle?.kind === "file") return take(path, await contents(await (handle as FileSystemFileHandle).getFile()));
      // A folder (or nothing): bring in what it holds, drop the VFS files below it that are gone.
      const found = handle ? await readDir(handle as Dir, path ? path + "/" : "") : [];
      const seen = new Set(found.map(([p]) => p));
      for (const [p, data] of found) take(p, data);
      const below = path ? path + "/" : "";
      for (const p of [...vfs.files.keys()]) if ((p === path || p.startsWith(below)) && !seen.has(p)) take(p, null);
    };
    let failed = false;
    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      log("warn", `${tag} can't pick up changes made outside the playground: ${e}`);
    };
    // A save is often several records (created empty, then written; a temporary file renamed over the file), so the
    // paths are collected for a moment and each is then read as it ends up.
    const changed = new Map<string, string[]>();
    let settle: ReturnType<typeof setTimeout> | undefined;
    const o = new FSO((records) => {
      for (const r of records) {
        if (r.type === "errored") return fail("the folder can't be watched any more");
        // "unknown": changes were missed, so look at everything.
        const paths = r.type === "unknown" ? [[]] : [r.relativePathComponents, ...(r.type === "moved" && r.relativePathMovedFrom ? [r.relativePathMovedFrom] : [])];
        for (const parts of paths) changed.set(parts.join("/"), parts);
      }
      clearTimeout(settle);
      settle = setTimeout(() => {
        const batch = changed.has("") ? [[]] : [...changed.values()];
        changed.clear();
        queue = queue.then(async () => {
          for (const parts of batch) if (!stopped) await sync(parts).catch(fail);
        });
      }, 100);
    });
    o.observe(dir, { recursive: true }).catch((e) => log("warn", `${tag} can't watch the folder for outside changes: ${e}`));
    return () => {
      o.disconnect();
      clearTimeout(settle);
    };
  }

  return () => {
    stopped = true;
    unwatch?.();
    unsub();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onHide);
    removeEventListener("pagehide", onHide);
    return chain;
  };
}
