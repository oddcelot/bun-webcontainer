// Bun's module resolver (bun_resolver, from crates/resolve-wasm) over the page VFS, through the same `bun_sys` host
// imports the worker uses. Its directory, package.json and tsconfig caches live as long as the instance, as in Bun;
// VFS changes invalidate the directories they touch, and clearing the VFS starts a fresh instance.
import { BASE } from "./base";
import { dirname, type VFS } from "@runbun/vfs";
import { createSysImports } from "@runbun/vfs/sysHost";

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  resolve_c(sp: bigint, sl: bigint, dp: bigint, dl: bigint, kind: number, target: number, cp: bigint, cl: bigint): bigint;
  output_free(out: bigint): void;
  invalidate_c(p: bigint, l: bigint): number;
  panic_message_c(): bigint;
};

export type ResolveKind = "import" | "require";
export type ResolveTarget = "browser" | "bun";
/** bun_ast::ImportKind and resolve-wasm's target numbering. */
const KIND = { import: 2, require: 3 } as const;
const TARGET = { browser: 0, bun: 1 } as const;
/** Bun's dev server and runtime both add `development` outside production builds. */
const CONDITIONS = "development";

const enc = new TextEncoder();
const dec = new TextDecoder();

let compiled: Promise<WebAssembly.Module> | undefined;
let module: WebAssembly.Module | undefined;
let bound: VFS | undefined;
let w: Exports | undefined;

function instantiate(vfs: VFS) {
  let memory: WebAssembly.Memory | undefined;
  w = new WebAssembly.Instance(module!, createSysImports(vfs, () => memory!) as unknown as WebAssembly.Imports).exports as unknown as Exports;
  memory = w.memory;
}

function withStr<T>(s: string, f: (ptr: bigint, len: bigint) => T): T {
  const b = enc.encode(s);
  const len = BigInt(b.length);
  const ptr = w!.alloc(len);
  new Uint8Array(w!.memory.buffer, Number(ptr), b.length).set(b);
  try {
    return f(ptr, len);
  } finally {
    w!.dealloc(ptr, len);
  }
}

function invalidate(dir: string) {
  if (w) withStr("/" + dir, (p, l) => w!.invalidate_c(p, l));
}

/** Loads the resolver (once; ~900 KB) and binds it to `vfs`. Call before `resolve`. */
export async function loadResolver(vfs: VFS): Promise<void> {
  compiled ??= WebAssembly.compileStreaming(fetch(new URL(`${BASE}bun_resolve_wasm.wasm`, location.href)));
  module = await compiled;
  if (bound === vfs) return;
  bound = vfs;
  instantiate(vfs);
  // A new file changes the listing of every directory up to the root (they may be new too); an edit matters only for
  // package.json/tsconfig.json, which are cached per directory.
  vfs.onChange(({ path, created, removed }) => {
    if (bound !== vfs) return;
    if (created) for (let d = dirname(path); ; d = dirname(d)) {
      invalidate(d);
      if (!d) break;
    }
    else if (removed || /(^|\/)(package|tsconfig)\.json$/.test(path)) invalidate(dirname(path));
  });
  vfs.onDir((path) => bound === vfs && invalidate(dirname(path)));
  vfs.onClear(() => bound === vfs && instantiate(vfs));
}

/** The VFS path `spec` imported from `dir` resolves to, or null (not found, or not a file). */
export function resolve(spec: string, dir: string, kind: ResolveKind, target: ResolveTarget): string | null {
  if (!w) throw new Error("resolver not loaded");
  let out: bigint;
  try {
    out = withStr(spec, (sp, sl) => withStr("/" + dir, (dp, dl) => withStr(CONDITIONS, (cp, cl) => w!.resolve_c(sp, sl, dp, dl, KIND[kind], TARGET[target], cp, cl))));
  } catch (e) {
    // panic=abort traps and leaves the instance unusable: report the panic and start over.
    const m = w.panic_message_c();
    const [, mp, ml] = new BigUint64Array(w.memory.buffer, Number(m), 3);
    const msg = dec.decode(new Uint8Array(w.memory.buffer, Number(mp), Number(ml)));
    instantiate(bound!);
    throw new Error(`resolver panicked on ${JSON.stringify(spec)} from /${dir}: ${msg}`, { cause: e });
  }
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out);
  return status === 0n && text.startsWith("/") ? text.slice(1) : null;
}
