import { shareFiles, type LazyData, type VFS } from "@runbun/vfs";
import { gunzip, untar } from "./lockfile";
import { fetchTarball } from "./pkgCache";
import { bucket } from "./storage";
import { CONTENT_ORIGIN } from "./contentOrigin";
import type { ToHost } from "./contentProtocol";
import { isHostIsolated } from "./contentHost";

/**
 * Large installed files, kept out of memory. A program reads few of an install's files, and the large ones hold
 * most of the bytes (Next.js + MUI + TypeScript 5: the 2% of files above 16 KB hold 83% of 260 MB). So at install
 * those go to the package store, one OPFS file per package version (`store/<key>`), and the VFS gets a reference
 * (LazyData: entry, offset, size). Reading one loads it: a worker blocks on Atomics.wait while the page reads it
 * (`serveLazyRead`); the page itself can't block, so its readers load first (`VFS.ensure`, `withLoaded`).
 *
 * With a content origin the store is on that origin (host/main.ts answers the worker, which is there; a shared buffer
 * can't cross origins): the page installs as ever and hands each package's large files over once (`store-put`), and
 * reads them back when it needs one (`store-read`: the module server, the editor, the type checker).
 *
 * Only where workers can block (cross-origin isolated: SharedArrayBuffer, Atomics.wait) and there's OPFS; elsewhere
 * every file stays in memory. A store entry that's gone (cleared, evicted) is rebuilt from the tarball.
 */
const LAZY_MIN = 16 * 1024;
/** Read synchronously on the page (resolver, tsconfig), or needed whole by the type checker as soon as it runs. */
const EAGER = /(^|\/)(package\.json|tsconfig[^/]*\.json)$|\.d\.[cm]?ts$/;
/** The store's size the oldest entries go above (entries this page uses stay). */
const STORE_BUDGET = 2 ** 30;

/** This is the editor page of a content origin: the store is the host frame's, over the port (see the head). */
const remote = !!CONTENT_ORIGIN && globalThis.location?.origin !== CONTENT_ORIGIN;
const askHost = async <T>(m: ToHost, transfer: Transferable[] = []): Promise<T> => {
  const res = await (await import("./contentHost")).askHost<T & { error?: string }>(m, transfer);
  if (res.error) throw new Error(res.error);
  return res;
};

// With a content origin it is the host frame that must be isolated (it says so in its handshake): the Worker blocks there.
// An embedder that doesn't delegate `cross-origin-isolated`, or isn't isolated itself, leaves it not, and files stay in memory.
const enabled = () =>
  remote
    ? isHostIsolated()
    : typeof SharedArrayBuffer === "function" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true && !!navigator.storage?.getDirectory;

/** Told when the store could not do what it was asked (a failed put): boot.ts shows it in the console. */
let onProblem: ((message: string) => void) | undefined;
export const reportStoreProblems = (fn: typeof onProblem) => void (onProblem = fn);
const problem = (message: string) => (onProblem ? onProblem(message) : console.error(`[store] ${message}`));

/** Entries the store could not keep, held in memory (a failed write on the host, or a put that failed twice in the editor). */
const memory = new Map<string, Uint8Array>();

type File = { name: string; data: Uint8Array };

/** The store entry's name for a tarball URL. */
const keyOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/[^\w.@-]/g, "_");
/** Entries installed on this page: their tarball, to rebuild a missing one. */
const sources = new Map<string, string>();
/** Entries being written. */
const writing = new Map<string, Promise<void>>();

let storeDir: Promise<FileSystemDirectoryHandle> | undefined;
const dir = () => (storeDir ??= bucket("pkg-cache", { durability: "relaxed" }).then(async (b) => (await b.getDirectory()).getDirectoryHandle("store", { create: true })));

/** The files that go to the store, in store order. */
const lazyFiles = (files: File[]) => files.filter((f) => f.data.byteLength > LAZY_MIN && !EAGER.test(f.name));

/**
 * A package's files (views of its unpacked tarball, from `url`) as VFS data: large ones as store references (the
 * entry written in the background), the rest in shared memory (shareFiles).
 */
export function splitPackage(files: File[], url: string): { name: string; data: Uint8Array | LazyData }[] {
  const lazy = enabled() ? new Set(lazyFiles(files)) : new Set<File>();
  if (!lazy.size) return shareFiles(files, !CONTENT_ORIGIN);
  const key = keyOf(url);
  sources.set(key, url);
  const out: { name: string; data: Uint8Array | LazyData }[] = [];
  let at = 0;
  for (const f of lazy) {
    out.push({ name: f.name, data: { lazy: key, at, size: f.data.byteLength } });
    at += f.data.byteLength;
  }
  const size = at;
  if (!writing.has(key)) {
    const parts = [...lazy].map((f) => f.data);
    const done = (remote ? put(key, url, parts, size) : write(key, parts, size)).finally(() => writing.delete(key));
    writing.set(key, done.catch(() => {}));
  }
  return [...out, ...shareFiles(files.filter((f) => !lazy.has(f)), !CONTENT_ORIGIN)];
}

/** Hands an entry to the host frame: its bytes in one buffer that is transferred (the frame writes it to its store). */
async function put(key: string, url: string, parts: Uint8Array[], size: number) {
  const buf = new ArrayBuffer(size);
  const all = new Uint8Array(buf);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  // The buffer is transferred, so a retry needs its own copy; the editor keeps it for good if the retry fails too.
  const spare = buf.slice(0);
  const send = async (b: ArrayBuffer) => {
    const res = await askHost<{ warning?: string }>({ kind: "store-put", key, url, buf: b }, [b]);
    if (res.warning) problem(res.warning);
  };
  try {
    await send(buf);
  } catch (first) {
    try {
      await send(spare.slice(0));
    } catch (second) {
      memory.set(key, new Uint8Array(spare));
      problem(`couldn't store package files (${second instanceof Error ? second.message : second}). They stay in memory, so reading them may fail.`);
    }
  }
}

async function write(key: string, parts: Uint8Array[], size: number) {
  const d = await dir();
  const existing = await d.getFileHandle(key).then((h) => h.getFile(), () => undefined);
  if (existing?.size === size) return;
  const w = await (await d.getFileHandle(key, { create: true })).createWritable();
  try {
    for (const p of parts) await w.write(p.slice() as FileSystemWriteChunkType);
  } catch (e) {
    // A write that fails (quota) leaves nothing half-written for a read to trust.
    await w.abort().catch(() => {});
    await d.removeEntry(key).catch(() => {});
    throw e;
  }
  await w.close();
  void prune().catch(() => {});
}

/** Over budget: drops the least recently written entries no page install uses now. */
async function prune() {
  const d = await dir();
  const files: { name: string; size: number; time: number }[] = [];
  for await (const [name, h] of d as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind !== "file") continue;
    const f = await (h as FileSystemFileHandle).getFile();
    files.push({ name, size: f.size, time: f.lastModified });
  }
  let total = files.reduce((t, f) => t + f.size, 0);
  for (const f of files.sort((a, b) => a.time - b.time)) {
    if (total <= STORE_BUDGET) break;
    if (sources.has(f.name)) continue;
    await d.removeEntry(f.name).catch(() => {});
    total -= f.size;
  }
}

/** Rebuilds a missing entry from its tarball (the package cache, else the network); returns its bytes. */
async function rebuild(key: string): Promise<Uint8Array> {
  const url = sources.get(key);
  if (!url) throw new Error(`package store entry ${key} is gone`);
  const files: File[] = [];
  for (const { name, data } of untar(await gunzip(await fetchTarball(url)))) {
    const rel = name.split("/").slice(1).join("/");
    if (rel) files.push({ name: rel, data });
  }
  const parts = lazyFiles(files).map((f) => f.data);
  const size = parts.reduce((t, p) => t + p.byteLength, 0);
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  await write(key, [all], size).catch(() => {});
  return all;
}

/** A lazy file's bytes, read into `into` (shared memory, so the page can keep it and hand it to workers). */
async function readLazy(ref: LazyData, into?: Uint8Array): Promise<Uint8Array> {
  await writing.get(ref.lazy);
  const held = memory.get(ref.lazy);
  if (held && held.byteLength >= ref.at + ref.size) {
    const bytes = held.subarray(ref.at, ref.at + ref.size);
    if (!into) return bytes.slice();
    into.set(bytes);
    return into;
  }
  if (remote) {
    const { buf } = await askHost<{ buf: ArrayBuffer }>({ kind: "store-read", key: ref.lazy, url: sources.get(ref.lazy) ?? "", at: ref.at, size: ref.size });
    return new Uint8Array(buf);
  }
  into ??= new Uint8Array(new SharedArrayBuffer(ref.size));
  const file = await (await dir()).getFileHandle(ref.lazy).then((h) => h.getFile(), () => undefined);
  if (file && file.size >= ref.at + ref.size) into.set(new Uint8Array(await file.slice(ref.at, ref.at + ref.size).arrayBuffer()));
  else into.set((await rebuild(ref.lazy)).subarray(ref.at, ref.at + ref.size));
  return into;
}

/** Lets the page's VFS load lazy files (VFS.ensure). */
export function attachStore(vfs: VFS) {
  vfs.loadAsync = (_, ref) => readLazy(ref);
}

/** What a worker sends when it reads a lazy file: it waits on the first Int32 of `sab`, the bytes go after 8. */
export type LazyRead = { type: "lazy-read"; path: string; ref: LazyData; sab: SharedArrayBuffer };

/**
 * Answers a worker blocked on a lazy file: its bytes into the worker's buffer, then the state word set and notified
 * (1 read, 2 failed). The page keeps that buffer as the file's data, so it holds the bytes once with the worker.
 */
export async function serveLazyRead(vfs: VFS | undefined, { path, ref, sab }: LazyRead) {
  const state = new Int32Array(sab, 0, 1);
  try {
    const into = new Uint8Array(sab, 8, ref.size);
    const have = vfs?.read(path);
    if (have instanceof Uint8Array && have.byteLength === ref.size) into.set(have);
    else {
      const bytes = await readLazy(ref, into);
      vfs?.adopt(path, ref, bytes);
    }
    Atomics.store(state, 0, 1);
  } catch {
    Atomics.store(state, 0, 2);
  }
  Atomics.notify(state, 0);
}

/** The store's entries and size, for `bun pm cache`. */
export async function storeInfo(): Promise<{ entries: number; bytes: number }> {
  if (remote) return askHost<{ entries: number; bytes: number }>({ kind: "store-info" }).catch(() => ({ entries: 0, bytes: 0 }));
  const info = { entries: 0, bytes: 0 };
  if (!navigator.storage?.getDirectory) return info;
  for await (const [, h] of (await dir()) as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind !== "file") continue;
    info.entries++;
    info.bytes += (await (h as FileSystemFileHandle).getFile()).size;
  }
  return info;
}

/** Empties the store. Files of this page's installs come back from their tarballs when read. */
export async function clearStore() {
  memory.clear();
  if (remote) return void (await askHost({ kind: "store-clear" }).catch(() => {}));
  if (!navigator.storage?.getDirectory) return;
  const root = await (await bucket("pkg-cache", { durability: "relaxed" })).getDirectory();
  await root.removeEntry("store", { recursive: true }).catch(() => {});
  storeDir = undefined;
}

/** The host frame's side of the store: what the editor hands over or asks for (contentProtocol.ts `store-*`). */
export async function answerStore(m: Extract<ToHost, { kind: `store-${string}` }>): Promise<unknown> {
  try {
    if ("key" in m && (!/^[\w.@-]{1,300}$/.test(m.key) || /^\.+$/.test(m.key))) throw new Error("bad store key");
    if (m.kind === "store-put") {
      if (m.url) sources.set(m.key, m.url);
      if (!writing.has(m.key)) {
        const bytes = new Uint8Array(m.buf);
        // One more try, then the entry is kept in this frame's memory: the Worker's reads still find it.
        const done = write(m.key, [bytes], bytes.byteLength).catch(() => write(m.key, [bytes], bytes.byteLength));
        writing.set(m.key, done.catch(() => {}).finally(() => writing.delete(m.key)));
        try {
          await done;
        } catch (e) {
          memory.set(m.key, bytes);
          return { warning: `the package store could not write ${m.key} (${e instanceof Error ? e.message : e}); its files stay in memory` };
        }
      } else await writing.get(m.key);
      return {};
    }
    if (m.kind === "store-read") {
      if (!Number.isSafeInteger(m.at) || !Number.isSafeInteger(m.size) || m.at < 0 || m.size < 0 || m.size > 2 ** 31) throw new Error("bad range");
      if (m.url && !sources.has(m.key)) sources.set(m.key, m.url);
      const bytes = await readLazy({ lazy: m.key, at: m.at, size: m.size }, new Uint8Array(m.size));
      return { buf: bytes.buffer };
    }
    if (m.kind === "store-info") return await storeInfo();
    await clearStore();
    return {};
  } catch (e) {
    return { error: String(e) };
  }
}
