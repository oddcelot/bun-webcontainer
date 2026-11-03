// Bun's module resolver (bun_resolver, from crates/resolve-wasm) over the page VFS, through the same `bun_sys` host
// imports the worker uses. Its directory, package.json and tsconfig caches live as long as the instance, as in Bun;
// VFS changes invalidate the directories they touch, and clearing the VFS starts a fresh instance. The same module
// has `Bun.Glob`'s matcher and walker (bun_glob), Bun's YAML and TOML parsers and `Bun.password`'s argon2 and bcrypt,
// which the worker uses.
import { BASE } from "./base";
import { dirname, type VFS } from "@runbun/vfs";
import { createSysImports } from "@runbun/vfs/sysHost";
import { fromDataTree } from "./dataTree";

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  resolve_c(sp: bigint, sl: bigint, dp: bigint, dl: bigint, kind: number, target: number, cp: bigint, cl: bigint): bigint;
  output_free(out: bigint): void;
  invalidate_c(p: bigint, l: bigint): number;
  panic_message_c(): bigint;
  glob_match_c(pp: bigint, pl: bigint, sp: bigint, sl: bigint): number;
  glob_scan_c(pp: bigint, pl: bigint, cp: bigint, cl: bigint, flags: number): bigint;
  data_parse_c(p: bigint, l: bigint, format: number): bigint;
  password_hash_c(pp: bigint, pl: bigint, sp: bigint, sl: bigint, algorithm: number, memoryCost: number, timeCost: number): bigint;
  password_verify_c(pp: bigint, pl: bigint, hp: bigint, hl: bigint, algorithm: number): bigint;
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
  return withBytes(enc.encode(s), f);
}

function withBytes<T>(b: Uint8Array, f: (ptr: bigint, len: bigint) => T): T {
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

/** The compiled module, once `loadResolver` has started (another worker can instantiate it: see passwordWorker.ts). */
export const resolverModule = (): Promise<WebAssembly.Module> | undefined => compiled;

/** Binds a module compiled elsewhere (and sent here) to `vfs`, instead of `loadResolver`. */
export function startResolver(m: WebAssembly.Module, vfs: VFS) {
  compiled = Promise.resolve(m);
  module = m;
  bound = vfs;
  instantiate(vfs);
}

/** Runs a call into the module. panic=abort traps and leaves the instance unusable: report the panic and start over. */
function guard<T>(what: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    const m = w!.panic_message_c();
    const [, mp, ml] = new BigUint64Array(w!.memory.buffer, Number(m), 3);
    const msg = dec.decode(new Uint8Array(w!.memory.buffer, Number(mp), Number(ml)));
    instantiate(bound!);
    throw new Error(`resolver panicked ${what}: ${msg}`, { cause: e });
  }
}

/** The VFS path `spec` imported from `dir` resolves to, or null (not found, or not a file). */
export function resolve(spec: string, dir: string, kind: ResolveKind, target: ResolveTarget): string | null {
  if (!w) throw new Error("resolver not loaded");
  const out = guard(`on ${JSON.stringify(spec)} from /${dir}`, () =>
    withStr(spec, (sp, sl) => withStr("/" + dir, (dp, dl) => withStr(CONDITIONS, (cp, cl) => w!.resolve_c(sp, sl, dp, dl, KIND[kind], TARGET[target], cp, cl)))),
  );
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out);
  return status === 0n && text.startsWith("/") ? text.slice(1) : null;
}

/** `Bun.Glob#match` (bun_glob's matcher, in the same module). */
export function globMatch(pattern: string, path: string): boolean {
  if (!w) throw new Error("resolver not loaded");
  return guard(`matching ${JSON.stringify(pattern)}`, () => withStr(pattern, (pp, pl) => withStr(path, (sp, sl) => w!.glob_match_c(pp, pl, sp, sl)))) === 1;
}

/** `Bun.Glob#scan` options, as resolve-wasm's flags. */
export type GlobScanFlags = { dot: boolean; absolute: boolean; onlyFiles: boolean; followSymlinks: boolean; throwErrorOnBrokenSymlink: boolean };
const GLOB_FLAGS: Record<keyof GlobScanFlags, number> = { dot: 1, absolute: 2, onlyFiles: 4, followSymlinks: 8, throwErrorOnBrokenSymlink: 16 };

/** Thrown by `globScan` when a syscall fails: Bun's error code (`ENOENT`), the syscall and its path. */
export class GlobScanError extends Error {
  constructor(readonly code: string, readonly syscall: string, readonly path: string) {
    super(`${code}: ${syscall} '${path}'`);
  }
}

/**
 * `Bun.Glob#scanSync`: the paths `pattern` matches under `cwd` (an absolute VFS path, `/` first), relative to it unless
 * `absolute`, in walk order. Reads the VFS directly, past the resolver's caches.
 */
export function globScan(pattern: string, cwd: string, opts: GlobScanFlags): string[] {
  if (!w) throw new Error("resolver not loaded");
  let flags = 0;
  for (const k of Object.keys(GLOB_FLAGS) as (keyof GlobScanFlags)[]) if (opts[k]) flags |= GLOB_FLAGS[k];
  const out = guard(`scanning ${JSON.stringify(pattern)} in ${cwd}`, () => withStr(pattern, (pp, pl) => withStr(cwd, (cp, cl) => w!.glob_scan_c(pp, pl, cp, cl, flags))));
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out);
  if (status !== 0n) {
    const [code, syscall, path] = text.split("\0");
    throw new GlobScanError(code, syscall ?? "", path ?? "");
  }
  return text ? text.slice(0, -1).split("\0") : [];
}

/** `Bun.YAML.parse`/`Bun.TOML.parse` (bun_parsers, in the same module). Throws Bun's SyntaxError. */
export function parseData(text: string, format: "yaml" | "toml"): unknown {
  if (!w) throw new Error("resolver not loaded");
  const out = guard(`parsing ${format.toUpperCase()}`, () => withStr(text, (p, l) => w!.data_parse_c(p, l, format === "toml" ? 1 : 0)));
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const json = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out);
  if (status !== 0n) throw new SyntaxError(json);
  return fromDataTree(json);
}

/** `Bun.password`'s algorithms, numbered as resolve-wasm's password.rs. */
export const PASSWORD_ALGORITHMS = { argon2d: 1, argon2i: 2, argon2id: 3, bcrypt: 4 } as const;
export type PasswordAlgorithm = keyof typeof PASSWORD_ALGORITHMS;

/** Thrown by `passwordHash`/`passwordVerify`: Bun's error name (`InvalidEncoding`, `WeakParameters`, …). */
export class PasswordError extends Error {}

function passwordOutput(out: bigint): string {
  const [status, ptr, len] = new BigUint64Array(w!.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w!.memory.buffer, Number(ptr), Number(len)));
  w!.output_free(out);
  if (status !== 0n) throw new PasswordError(text);
  return text;
}

/** The encoded hash (PHC for argon2, `$2b$` for bcrypt) of `password` with `salt` (32 bytes for argon2, 16 for bcrypt). */
export function passwordHash(password: Uint8Array, salt: Uint8Array, algorithm: PasswordAlgorithm, memoryCost: number, timeCost: number): string {
  if (!w) throw new Error("resolver not loaded");
  return passwordOutput(guard("hashing a password", () => withBytes(password, (pp, pl) => withBytes(salt, (sp, sl) => w!.password_hash_c(pp, pl, sp, sl, PASSWORD_ALGORITHMS[algorithm], memoryCost, timeCost)))));
}

/** Whether `password` matches `hash`, checked as `algorithm`. */
export function passwordVerify(password: Uint8Array, hash: Uint8Array, algorithm: PasswordAlgorithm): boolean {
  if (!w) throw new Error("resolver not loaded");
  return passwordOutput(guard("verifying a password", () => withBytes(password, (pp, pl) => withBytes(hash, (hp, hl) => w!.password_verify_c(pp, pl, hp, hl, PASSWORD_ALGORITHMS[algorithm]))))) === "1";
}
