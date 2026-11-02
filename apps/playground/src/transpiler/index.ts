import { BASE } from "../base";

// Bun's own transpiler (bun_js_parser + bun_js_printer) compiled to wasm64; see crates/transpile-wasm.
// Output matches `bun build --no-bundle --target=browser`.

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  transpile_resolve_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
  transpile_flags_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
  scan_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
  scan_imports_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
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

/** tsconfig `compilerOptions` the output depends on (bits of transpile-wasm's `flags`). */
export type TsconfigFlags = { experimentalDecorators?: boolean; emitDecoratorMetadata?: boolean };

const LOADERS: Record<string, number> = { js: 0, mjs: 0, jsx: 1, ts: 2, mts: 2, cts: 2, tsx: 3 };

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
 */
export async function transpile(source: string, path: string, tsconfig: TsconfigFlags = {}, resolve?: Resolver): Promise<string> {
  const w = await (ready ??= load());
  const flags = (tsconfig.experimentalDecorators ? 1 : 0) | (tsconfig.emitDecoratorMetadata ? 2 : 0);
  const loader = LOADERS[path.slice(path.lastIndexOf(".") + 1)] ?? 0;
  current = resolve;
  resolveError = undefined;
  try {
    return call(w, resolve ? "transpile_resolve_c" : "transpile_flags_c", path, source, loader, flags, () => {
      if (resolveError !== undefined) throw resolveError;
    });
  } finally {
    current = undefined;
  }
}

type Entry = "transpile_resolve_c" | "transpile_flags_c" | "scan_c" | "scan_imports_c";

/** Calls `fn` (always with DIAGNOSTICS_JSON) and returns its text, or throws a TranspileError. `check` runs first. */
function call(w: Exports, fn: Entry, path: string, source: string, loader: number, flags: number, check?: () => void): string {
  const put = (s: string): [bigint, bigint] => {
    const b = enc.encode(s);
    const len = BigInt(b.length);
    const ptr = w.alloc(len);
    new Uint8Array(w.memory.buffer, Number(ptr), b.length).set(b);
    return [ptr, len];
  };
  const [pp, pl] = put(path);
  const [sp, sl] = put(source);
  const out = w[fn](pp, pl, sp, sl, loader, flags | 4); // 4: errors as JSON
  try {
    check?.();
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
    w.dealloc(pp, pl);
    w.dealloc(sp, sl);
  }
}

/** What `Bun.Transpiler` runs: its output (`transform`, as Bun's runtime transpiler prints it), `scan` or `scanImports` (JSON). */
export type RuntimeOp = "transform" | "scan" | "scanImports";
const RUNTIME_TRANSPILER = 8;
const ENTRY: Record<RuntimeOp, Entry> = { transform: "transpile_flags_c", scan: "scan_c", scanImports: "scan_imports_c" };

/** For `Bun.Transpiler` in the worker: synchronous, loading the module on first use. `loader` is js, jsx, ts or tsx. */
export function runtimeTranspile(op: RuntimeOp, source: string, loader: "js" | "jsx" | "ts" | "tsx", tsconfig: TsconfigFlags = {}): string {
  const flags = (tsconfig.experimentalDecorators ? 1 : 0) | (tsconfig.emitDecoratorMetadata ? 2 : 0) | RUNTIME_TRANSPILER;
  // Bun names the source after the loader (`Loader::stdin_name`), which its messages show.
  return call(loadSync(), ENTRY[op], `input.${loader}`, source, LOADERS[loader], flags);
}
