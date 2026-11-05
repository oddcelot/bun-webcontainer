// What the project looked like where it came from (its baseline), and how the files differ from it now: the Changes
// tab's data. A project loaded this visit is snapshotted as it loads; one restored from storage is rebuilt from its
// source (the demo, an example, a share link, a GitHub repo) the first time it's asked for.
import { VFS, isLazy, type FileData } from "@runbun/vfs";
import { SKIP } from "./persist";

/** A file's contents for comparing: text, or bytes (binary files, and text kept as bytes). */
export type Baseline = Map<string, string | Uint8Array>;

export type Change = {
  path: string;
  kind: "added" | "deleted" | "modified";
  /** Text before and after ("" for a missing side); null when either side is binary. */
  before: string | null;
  after: string | null;
};

const strict = new TextDecoder("utf-8", { fatal: true });

/** A file's text, or its bytes when they aren't UTF-8. Lazy files (installed packages only) are skipped by SKIP. */
function contents(d: FileData): string | Uint8Array {
  if (typeof d === "string") return d;
  if (isLazy(d)) return new Uint8Array(0);
  try {
    return strict.decode(d);
  } catch {
    return d;
  }
}

/** The project files of `vfs` (not node_modules or .git) as they are now. */
export function snapshot(vfs: VFS): Baseline {
  const out: Baseline = new Map();
  for (const [path, d] of vfs.files) if (!SKIP.test(path)) out.set(path, contents(d));
  return out;
}

const same = (a: string | Uint8Array, b: string | Uint8Array) => {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
};

/** The files of `vfs` that differ from `base`, sorted by path. */
export function changes(vfs: VFS, base: Baseline): Change[] {
  const out: Change[] = [];
  const now = snapshot(vfs);
  const text = (d: string | Uint8Array | undefined) => (d === undefined ? "" : typeof d === "string" ? d : null);
  for (const [path, d] of now) {
    const was = base.get(path);
    if (was !== undefined && same(was, d)) continue;
    const before = text(was);
    const after = text(d);
    const binary = before === null || after === null;
    out.push({ path, kind: was === undefined ? "added" : "modified", before: binary ? null : before, after: binary ? null : after });
  }
  for (const [path, was] of base) {
    if (now.has(path)) continue;
    const before = text(was);
    out.push({ path, kind: "deleted", before, after: before === null ? null : "" });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

let load: (() => Promise<Baseline | null>) | null = null;
let current: Promise<Baseline | null> | null = null;
/** Rebuilding the baseline costs network requests (a GitHub repo): only when the Changes tab asks. */
let costly = false;
const listeners = new Set<() => void>();
/** Trackers waiting for a costly baseline someone else loads. */
const waiting = new Set<() => void>();

/** The project's baseline, loading it the first time; null when its source can't be loaded (a repo offline). */
export function baseline(): Promise<Baseline | null> {
  if (!current) {
    current = load ? load().catch(() => null) : Promise.resolve(null);
    void current.then(() => {
      for (const fn of [...waiting]) fn();
    });
  }
  return current;
}

/** True when `baseline()` is loaded, or cheap to load (not a repo to fetch again). */
const baselineCheap = () => current !== null || !costly;

/** Sets the baseline to the files `vfs` holds now (a project just loaded, or a folder just opened). */
export function setBaseline(vfs: VFS) {
  const base = snapshot(vfs);
  load = null;
  costly = false;
  current = Promise.resolve(base);
  for (const fn of listeners) fn();
}

/**
 * Sets how the baseline is rebuilt when first asked for: by writing the source's files into a scratch VFS. A
 * `costly` one (network requests) is rebuilt only for the Changes tab, not for the status bar's count.
 */
export function setBaselineSource(fill: (scratch: VFS) => Promise<unknown> | unknown, opts: { costly?: boolean } = {}) {
  costly = !!opts.costly;
  load = async () => {
    const scratch = new VFS();
    await fill(scratch);
    return snapshot(scratch);
  };
  current = null;
  for (const fn of listeners) fn();
}

/** Calls `fn` when the baseline is replaced (another project or folder opened); returns the unsubscribe. */
export function onBaseline(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * Calls `fn` with the project's changes now and shortly after each edit; null while the baseline loads, and when it
 * can't be loaded (`missing`). With `eager` false, a costly baseline (a repo fetched again) waits until something
 * else loads it. Returns the unsubscribe.
 */
export function trackChanges(vfs: VFS, fn: (list: Change[] | null, missing: boolean) => void, eager = true) {
  let base: Baseline | null | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;
  const refresh = () => {
    if (base) fn(changes(vfs, base), false);
  };
  const load = () => {
    base = undefined;
    fn(null, false);
    if (!eager && !baselineCheap()) return void waiting.add(load);
    waiting.delete(load);
    void baseline().then((b) => {
      if (gone) return;
      base = b;
      if (b) refresh();
      else fn(null, true);
    });
  };
  load();
  const offChange = vfs.onChange(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  });
  const offBaseline = onBaseline(load);
  return () => {
    gone = true;
    clearTimeout(timer);
    offChange();
    offBaseline();
    waiting.delete(load);
  };
}
