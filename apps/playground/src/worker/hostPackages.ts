// Host packages: the playground supplies these itself instead of the user's node_modules copy.
// The specifiers are exactly the ones Vite 8 imports from rolldown (native bindings can't run in a browser).
// Note: the wasm binding allocates a 1 GiB shared memory, so this module must only be imported by the worker.
import { dirname, type FileData, type VFS } from "@runbun/vfs";
import { builtins } from "./node";

const loaders: Record<string, () => Promise<object>> = {
  rolldown: () => import("@rolldown/browser"),
  "rolldown/experimental": () => import("@rolldown/browser/experimental"),
  "rolldown/filter": () => import("@rolldown/browser/filter"),
  "rolldown/parseAst": () => import("@rolldown/browser/parseAst"),
  "rolldown/plugins": () => import("@rolldown/browser/plugins"),
  "rolldown/utils": () => import("@rolldown/browser/utils"),
};

export const hostSpecifiers = Object.keys(loaders);

type Volume = {
  mkdirSync(p: string, o: { recursive: true }): void;
  writeFileSync(p: string, d: FileData): void;
  readFileSync(p: string): Uint8Array;
  rmSync(p: string, o: { force: true }): void;
};
/** The node:fs-like object rolldown's WASI calls (on this thread, and for its worker threads). */
type WasiFs = Record<"openSync" | "writeSync" | "ftruncateSync" | "closeSync" | "renameSync" | "unlinkSync" | "rmdirSync" | "mkdirSync", (...a: never[]) => unknown>;

let vfs: VFS | undefined;
/** The VFS that rolldown's wasm should see (Vite 8 resolves every import through it). */
export function setHostVfs(v: VFS) {
  vfs = v;
}

/**
 * rolldown's wasm has its own in-memory fs: give it the VFS and keep it up to date, and bring what it writes (Vite's
 * optimized dependencies) back into the VFS through node:fs.
 */
async function mirrorVfs() {
  const { memfs } = (await import("@rolldown/browser/experimental")) as unknown as { memfs?: { fs: WasiFs; volume: Volume } };
  const vol = memfs?.volume;
  if (!vol || !vfs) return;
  let fromWasm = false;
  for (const d of vfs.dirs) vol.mkdirSync("/" + d, { recursive: true });
  for (const [p, data] of vfs.files) vol.writeFileSync("/" + p, data);
  vfs.onChange((e) => {
    if (fromWasm) return;
    if (e.removed) return vol.rmSync("/" + e.path, { force: true });
    vol.mkdirSync("/" + dirname(e.path), { recursive: true });
    vol.writeFileSync("/" + e.path, vfs!.read(e.path)!);
  });

  const fs = builtins.fs as typeof import("node:fs");
  const wasi = memfs.fs;
  const sync = (fn: () => void) => {
    fromWasm = true;
    try {
      fn();
    } finally {
      fromWasm = false;
    }
  };
  const paths = new Map<number, string>();
  const written = new Set<number>();
  const wrap = <K extends keyof WasiFs>(name: K, after: (ret: unknown, ...a: never[]) => void) => {
    const orig = wasi[name];
    wasi[name] = (...a: never[]) => {
      const ret = orig(...a);
      after(ret, ...a);
      return ret;
    };
  };
  wrap("openSync", (fd, path: string) => paths.set(fd as number, String(path)));
  wrap("writeSync", (_, fd: number) => written.add(fd));
  wrap("ftruncateSync", (_, fd: number) => written.add(fd));
  wrap("closeSync", (_, fd: number) => {
    const path = paths.get(fd);
    paths.delete(fd);
    if (written.delete(fd) && path) sync(() => {
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(path, vol.readFileSync(path));
    });
  });
  wrap("renameSync", (_, from: string, to: string) => sync(() => fs.existsSync(from) && fs.renameSync(from, to)));
  wrap("unlinkSync", (_, path: string) => sync(() => fs.rmSync(path, { force: true })));
  wrap("rmdirSync", (_, path: string) => sync(() => fs.rmSync(path, { recursive: true, force: true })));
  wrap("mkdirSync", (_, path: string) => sync(() => fs.mkdirSync(path, { recursive: true })));
}

const cache = new Map<string, Promise<object>>();
let mirrored: Promise<void> | undefined;
(globalThis as Record<string, unknown>).__hostPackage = (spec: string) => {
  let p = cache.get(spec);
  if (!p) cache.set(spec, (p = Promise.all([loaders[spec](), (mirrored ??= mirrorVfs())]).then(([m]) => m)));
  return p;
};
