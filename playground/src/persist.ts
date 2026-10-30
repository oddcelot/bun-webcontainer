import { bucket } from "./storage";
import type { VFS } from "./vfs";

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
    if (h.kind === "directory") await walk(h as Dir, `${prefix}${name}/`, out);
    else out.push([prefix + name, await (h as FileSystemFileHandle).getFile()]);
  }
}

/** Loads the saved files of a project into the VFS; returns how many (0 when nothing is saved or OPFS fails). */
export async function restore(id: string, vfs: VFS, log: Log): Promise<number> {
  try {
    const dir = await projectDir(id, false);
    if (!dir) return 0;
    const found: [string, File][] = [];
    await walk(dir, "", found);
    const dec = new TextDecoder("utf-8", { fatal: true });
    for (const [path, file] of found) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let data: string | Uint8Array = bytes;
      try {
        data = dec.decode(bytes);
      } catch {}
      vfs.write(path, data);
    }
    return found.length;
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

/**
 * Mirrors the VFS into OPFS (`projects/<id>/`), write-behind: changes are collected and flushed after a short
 * pause. `all` saves every file now (a project just loaded from its source). Only the tab holding the project's
 * lock writes. Never throws; returns a function that stops saving and settles once a flush in progress is done.
 */
export async function attach(id: string, vfs: VFS, log: Log, all: boolean): Promise<() => Promise<void>> {
  let stopped = false;
  const stop = async () => {
    stopped = true;
  };
  try {
    if (!navigator.storage?.getDirectory) throw new Error("OPFS is not available");
    if (navigator.locks) {
      const got = await new Promise<boolean>((resolve) => {
        // Held until the page goes away.
        void navigator.locks.request("bwc-project:" + id, { ifAvailable: true }, (lock) => {
          resolve(!!lock);
          return lock ? new Promise<void>(() => {}) : undefined;
        });
      });
      if (!got) {
        log("warn", "[storage] project open in another tab; changes here won't be saved");
        return stop;
      }
    }
    const dir = await projectDir(id, true);
    if (!dir) throw new Error("can't create the project directory");

    const dirty = new Set<string>();
    /** Taken out of `dirty` by the flush in progress, not yet written. */
    const writing = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chain: Promise<void> = Promise.resolve();
    let warned = false;
    let asked = false;

    const writeOne = async (path: string) => {
      const parts = path.split("/");
      const name = parts.pop()!;
      const data = vfs.files.get(path);
      if (data === undefined) {
        // Gone from the VFS: delete the entry, then prune parents left empty.
        const dirs: Dir[] = [dir];
        try {
          for (const p of parts) dirs.push(await dirs[dirs.length - 1].getDirectoryHandle(p));
          await dirs[dirs.length - 1].removeEntry(name);
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
    };

    // Flushes run one after another, never overlapping.
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      chain = chain.then(async () => {
        if (stopped) return;
        if (!asked) {
          asked = true;
          void projects()
            .then((b) => b.persist())
            .catch(() => {});
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
              log("warn", `[storage] can't save ${path}: ${e}`);
            }
          }
          writing.delete(path);
        }
        if (!dirty.size && !writing.size) {
          try {
            sessionStorage.removeItem(stashKey(id));
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
    try {
      const stash: Record<string, string | null> = JSON.parse(sessionStorage.getItem(stashKey(id)) ?? "{}");
      for (const [path, data] of Object.entries(stash)) {
        if (data === null) vfs.remove(path);
        else vfs.write(path, data);
        dirty.add(path);
      }
      if (dirty.size) schedule();
    } catch {}

    const unsub = vfs.onChange(({ path }) => {
      if (stopped || SKIP.test(path)) return;
      dirty.add(path);
      schedule();
    });
    const onHide = () => {
      if (document.visibilityState !== "hidden" || !(dirty.size || writing.size)) return;
      const stash: Record<string, string | null> = {};
      for (const path of [...writing, ...dirty]) {
        const data = vfs.files.get(path);
        if (data === undefined) stash[path] = null;
        else if (typeof data === "string") stash[path] = data;
      }
      try {
        sessionStorage.setItem(stashKey(id), JSON.stringify(stash));
      } catch (e) {
        log("warn", `[storage] can't keep unsaved files across the reload: ${e}`);
      }
      if (dirty.size) void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    addEventListener("pagehide", onHide);
    if (all) {
      for (const p of vfs.files.keys()) if (!SKIP.test(p)) dirty.add(p);
      schedule();
    }
    return () => {
      stop();
      unsub();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onHide);
      removeEventListener("pagehide", onHide);
      return chain;
    };
  } catch (e) {
    log("warn", `[storage] saving is unavailable (${e}); this project won't be kept across reloads`);
    return stop;
  }
}
