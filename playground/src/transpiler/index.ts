import { BASE } from "../base";

// Bun's own transpiler (bun_js_parser + bun_js_printer) compiled to wasm64; see ../../../transpile-wasm.
// Output matches `bun build --no-bundle --target=browser`.

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  transpile_resolve_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
  transpile_flags_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number, flags: number): bigint;
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
// The wasm import is global to the instance; calls are synchronous, so the current call's resolver lives here.
let current: Resolver | undefined;
let resolveError: unknown;

async function load(): Promise<Exports> {
  const res = await fetch(new URL(`${BASE}bun_transpile_wasm.wasm`, location.href));
  let w: Exports;
  // ABI: see transpile-wasm/src/lib.rs ("Host resolver ABI"). Returns 0 (keep) or alloc'd [u64 len][utf-8 bytes].
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
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), { env });
  w = instance.exports as unknown as Exports;
  return w;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * JS/TS to browser JS. With `resolve`, every import specifier Bun's parser found (static import, `export ... from`,
 * `import("literal")`; never `require()` or text in strings/comments) is replaced by its result before printing.
 */
export async function transpile(source: string, path: string, tsconfig: TsconfigFlags = {}, resolve?: Resolver): Promise<string> {
  const w = await (ready ??= load());
  const put = (s: string): [bigint, bigint] => {
    const b = enc.encode(s);
    const len = BigInt(b.length);
    const ptr = w.alloc(len);
    new Uint8Array(w.memory.buffer, Number(ptr), b.length).set(b);
    return [ptr, len];
  };
  const [pp, pl] = put(path);
  const [sp, sl] = put(source);
  const flags = (tsconfig.experimentalDecorators ? 1 : 0) | (tsconfig.emitDecoratorMetadata ? 2 : 0) | 4; // 4: errors as JSON
  const loader = LOADERS[path.slice(path.lastIndexOf(".") + 1)] ?? 0;
  current = resolve;
  resolveError = undefined;
  let out: bigint;
  try {
    out = resolve ? w.transpile_resolve_c(pp, pl, sp, sl, loader, flags) : w.transpile_flags_c(pp, pl, sp, sl, loader, flags);
  } finally {
    current = undefined;
  }
  try {
    if (resolveError !== undefined) throw resolveError;
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
