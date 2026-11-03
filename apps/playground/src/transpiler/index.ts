import { BASE } from "../base";
import { FLAGS, LOADER_NUMBERS, type RuntimeOptions } from "./options";

// Bun's own transpiler (bun_js_parser + bun_js_printer) compiled to wasm64; see crates/transpile-wasm.
// Output matches `bun build --no-bundle --target=browser`.

const { RUNTIME_TRANSPILER, IMPORT_META_REQUIRE, SYNC_ESM } = FLAGS;

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  transpile_resolve_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
  transpile_flags_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
  scan_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
  scan_imports_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
  jsx_c(ptr: bigint, len: bigint): void;
  options_c(ptr: bigint, len: bigint): bigint;
  output_free(out: bigint): void;
};

/** One parser message. `line`/`column` are 1-based and `column`/`length` count UTF-8 bytes (see transpile-wasm's `format_json`). */
export type Diagnostic = {
  severity: "error" | "warning";
  text: string;
  line?: number;
  column?: number;
  length?: number;
  notes: { text: string; line?: number; column?: number; length?: number }[];
};

/** Thrown when Bun's parser rejects the source; `message` is the messages' text, one per line. */
export class TranspileError extends Error {
  constructor(message: string, readonly diagnostics: Diagnostic[]) {
    super(message);
    this.name = "TranspileError";
  }
}

/** tsconfig `compilerOptions` the output depends on (bits of transpile-wasm's `flags`, and its `jsx_c`). */
export type TsconfigFlags = {
  experimentalDecorators?: boolean;
  emitDecoratorMetadata?: boolean;
  jsx?: string;
  jsxImportSource?: string;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
};

const JSX_OPTIONS = ["jsx", "jsxImportSource", "jsxFactory", "jsxFragmentFactory"] as const;

/** The JSX options as transpile-wasm's `jsx_c` takes them (NUL-separated, non-strings unset); also a cache key. */
export const jsxKey = (t: TsconfigFlags): string => JSX_OPTIONS.map((k) => (typeof t[k] === "string" ? t[k] : "")).join("\0");

/** The loader for a file extension, as Bun's defaults have them: `.js` is parsed as JSX, `.mjs` and `.cjs` are not. */
const EXTENSIONS: Record<string, number> = { js: 1, mjs: 0, cjs: 0, jsx: 1, ts: 2, mts: 2, cts: 2, tsx: 3 };
const loaderOf = (path: string) => EXTENSIONS[path.slice(path.lastIndexOf(".") + 1)] ?? 0;
/** transpile-wasm's `flags` for the tsconfig options. */
const tsFlags = (t: TsconfigFlags) => (t.experimentalDecorators ? 1 : 0) | (t.emitDecoratorMetadata ? 2 : 0);

/** Import kinds the resolver is asked about (bun_ast::ImportKind): `import`/`export ... from`, and `import("literal")`. */
export type ImportKind = "stmt" | "dynamic";

/** Returns the specifier to print instead, or null to keep it. */
export type Resolver = (specifier: string, kind: ImportKind) => string | null;

let ready: Promise<Exports> | undefined;
/** The instance, once loaded (by `load` or `loadSync`). */
let loaded: Exports | undefined;
// The wasm import is global to the instance; calls are synchronous, so the current call's resolver lives here.
let current: Resolver | undefined;
let resolveError: unknown;
/** SHA-256 of the wasm, set once it loads: output from another build of the transpiler can differ. */
let wasmId = "";

const wasmUrl = () => new URL(`${BASE}bun_transpile_wasm.wasm`, location.href);

function instantiate(module: WebAssembly.Module): Exports {
  let w: Exports;
  // ABI: see crates/transpile-wasm/src/lib.rs ("Host resolver ABI"). Returns 0 (keep) or alloc'd [u64 len][utf-8 bytes].
  const env = {
    resolve_specifier(ptr: bigint, len: bigint, kind: number): bigint {
      try {
        const spec = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
        const r = current?.(spec, kind === 4 ? "dynamic" : "stmt");
        if (r == null || r === spec) return 0n;
        const b = enc.encode(r);
        const p = w.alloc(BigInt(8 + b.length));
        new DataView(w.memory.buffer).setBigUint64(Number(p), BigInt(b.length), true);
        new Uint8Array(w.memory.buffer, Number(p) + 8, b.length).set(b);
        return p;
      } catch (e) {
        // Don't unwind through wasm frames: keep the specifier and rethrow once the call returns.
        resolveError ??= e;
        return 0n;
      }
    },
  };
  w = new WebAssembly.Instance(module, { env }).exports as unknown as Exports;
  return w;
}

async function load(): Promise<Exports> {
  const bytes = await (await fetch(wasmUrl())).arrayBuffer();
  wasmId = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const module = await WebAssembly.compile(bytes);
  return (loaded ??= instantiate(module));
}

/**
 * The instance, loaded synchronously if it isn't yet (a synchronous XHR and compile): for `Bun.Transpiler#transformSync`
 * in the worker, which loads the 3 MB module only when a program uses it. Workers only: the page may not compile
 * modules this large synchronously.
 */
function loadSync(): Exports {
  if (loaded) return loaded;
  const xhr = new XMLHttpRequest();
  xhr.open("GET", wasmUrl(), false);
  xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status !== 200) throw new Error(`failed to load the transpiler: HTTP ${xhr.status}`);
  return (loaded = instantiate(new WebAssembly.Module(xhr.response as ArrayBuffer)));
}

/** Which build of the transpiler this is (a hash of its wasm). */
export async function transpilerId(): Promise<string> {
  await (ready ??= load());
  return wasmId;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * JS/TS to browser JS. With `resolve`, every import specifier Bun's parser found (static import, `export ... from`,
 * `import("literal")`; never `require()` or text in strings/comments) is replaced by its result before printing.
 * With `metaRequire`, a file that uses a free `require` starts with `var {require}=import.meta;`, as Bun prints ES
 * modules for its runtime.
 */
export async function transpile(source: string, path: string, tsconfig: TsconfigFlags = {}, resolve?: Resolver, metaRequire = false): Promise<string> {
  const w = await (ready ??= load());
  const flags = tsFlags(tsconfig) | (metaRequire ? IMPORT_META_REQUIRE : 0);
  const loader = loaderOf(path);
  current = resolve;
  resolveError = undefined;
  try {
    return call(w, resolve ? "transpile_resolve_c" : "transpile_flags_c", path, source, loader, flags, jsxKey(tsconfig), NO_OPTIONS, () => {
      if (resolveError !== undefined) throw resolveError;
    });
  } finally {
    current = undefined;
  }
}

type Entry = "transpile_resolve_c" | "transpile_flags_c" | "scan_c" | "scan_imports_c";

const NO_OPTIONS = new Uint8Array();

/** The text of an `Output` (status 0), or throws a TranspileError for its diagnostics. Frees it. */
function output(w: Exports, out: bigint): string {
  try {
    const view = new DataView(w.memory.buffer);
    const at = Number(out);
    const status = view.getBigUint64(at, true);
    const ptr = Number(view.getBigUint64(at + 8, true));
    const len = Number(view.getBigUint64(at + 16, true));
    const text = dec.decode(new Uint8Array(w.memory.buffer, ptr, len));
    if (status !== 0n) {
      let diagnostics: Diagnostic[] = [];
      try {
        diagnostics = (JSON.parse(text) as { diagnostics: Diagnostic[] }).diagnostics;
      } catch {
        // Not JSON (e.g. "print failed"): keep the text.
        throw new Error(text.trim() || "transpile failed");
      }
      throw new TranspileError(diagnostics.map((d) => d.text).join("\n") || "transpile failed", diagnostics);
    }
    return text;
  } finally {
    w.output_free(out);
  }
}

/**
 * Calls `fn` (always with DIAGNOSTICS_JSON) with the JSX options `jsx` (`jsxKey`) and `Bun.Transpiler`'s `options`
 * (`options_c`'s input, empty for none) and returns its text, or throws a TranspileError. `check` runs first.
 */
function call(w: Exports, fn: Entry, path: string, source: string, loader: number, flags: number, jsx: string, options: Uint8Array, check?: () => void): string {
  const put = (b: Uint8Array): [bigint, bigint] => {
    const len = BigInt(b.length);
    const ptr = w.alloc(len);
    new Uint8Array(w.memory.buffer, Number(ptr), b.length).set(b);
    return [ptr, len];
  };
  const [jp, jl] = put(enc.encode(jsx));
  w.jsx_c(jp, jl);
  w.dealloc(jp, jl);
  const [op, ol] = put(options);
  try {
    output(w, w.options_c(op, ol));
  } finally {
    w.dealloc(op, ol);
  }
  const [pp, pl] = put(enc.encode(path));
  const [sp, sl] = put(enc.encode(source));
  try {
    const out = w[fn](pp, pl, sp, sl, loader, flags | 4); // 4: errors as JSON
    try {
      check?.();
    } catch (e) {
      w.output_free(out);
      throw e;
    }
    return output(w, out);
  } finally {
    w.dealloc(pp, pl);
    w.dealloc(sp, sl);
  }
}

/** What `Bun.Transpiler` runs: its output (`transform`, as Bun's runtime transpiler prints it), `scan` or `scanImports` (JSON). */
export type RuntimeOp = "transform" | "scan" | "scanImports";
const ENTRY: Record<RuntimeOp, Entry> = { transform: "transpile_flags_c", scan: "scan_c", scanImports: "scan_imports_c" };

/** The loaders `runtimeTranspile` takes: js, jsx, ts, tsx and the data loaders (json, toml, text, ...). */
export const RUNTIME_LOADERS = Object.keys(LOADER_NUMBERS);

/**
 * For `Bun.Transpiler` in the worker: synchronous, loading the module on first use. `loader` is one of
 * `RUNTIME_LOADERS`; `options` are its other options (`runtimeOptions`). Also validates `options` alone (its define
 * values) when `source` is null, returning "".
 */
export function runtimeTranspile(op: RuntimeOp, source: string | null, loader: string, tsconfig: TsconfigFlags, options: RuntimeOptions): string {
  const w = loadSync();
  const flags = tsFlags(tsconfig) | options.flags | RUNTIME_TRANSPILER;
  if (source === null) {
    const b = options.options;
    const p = w.alloc(BigInt(b.length));
    new Uint8Array(w.memory.buffer, Number(p), b.length).set(b);
    try {
      return output(w, w.options_c(p, BigInt(b.length)));
    } finally {
      w.dealloc(p, BigInt(b.length));
    }
  }
  // Bun names the source after the loader (`Loader::stdin_name`), which its messages show.
  return call(w, ENTRY[op], `input.${loader}`, source, LOADER_NUMBERS[loader], flags, jsxKey(tsconfig), options.options);
}

/**
 * `transpile` without a resolver, synchronous (in the worker, loading the module on first use): for CommonJS the
 * worker loads at run time, which Bun's runtime transpiles as `bun build --no-bundle` does (the JSX runtime imported).
 */
export function transpileSync(source: string, path: string, tsconfig: TsconfigFlags = {}): string {
  return call(loadSync(), "transpile_flags_c", path, source, loaderOf(path), tsFlags(tsconfig), jsxKey(tsconfig), NO_OPTIONS);
}

/**
 * An ES module as the body of a function of `hmr` (transpile-wasm's SYNC_ESM): for `require()` of one the worker
 * hasn't imported, which it runs synchronously (worker/node/module.ts). Throws Bun's error for top-level await.
 */
export function transpileSyncEsm(source: string, path: string, tsconfig: TsconfigFlags = {}): string {
  return call(loadSync(), "transpile_flags_c", path, source, loaderOf(path), tsFlags(tsconfig) | SYNC_ESM, jsxKey(tsconfig), NO_OPTIONS);
}
