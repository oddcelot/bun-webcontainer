import { BASE } from "./base";

// `bun fmt` (Bun's own Prettier-compatible formatter) compiled to wasm64; see ../../fmt-wasm. Output matches
// `bun fmt --stdin-filepath <path>` with no config file. Loaded on first use (~2 MB compressed).

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  format_c(pathPtr: bigint, pathLen: bigint, textPtr: bigint, textLen: bigint, flags: number, printWidth: number): bigint;
  walks_c(pathPtr: bigint, pathLen: bigint): number;
  output_free(out: bigint): void;
};

/** The `bun fmt` flags that change the output. */
export type FormatOptions = { useTabs?: boolean; noSemi?: boolean; singleQuote?: boolean; printWidth?: number };

/** Why a file was left as is. */
export type FormatFailure = "syntax" | "bug" | "unsupported";

let ready: Promise<Exports> | undefined;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function load(): Promise<Exports> {
  const res = await fetch(new URL(`${BASE}bun_fmt_wasm.wasm`, location.href));
  if (!res.ok) throw new Error(`bun_fmt_wasm.wasm: HTTP ${res.status}`);
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
  return instance.exports as unknown as Exports;
}

/** Loads the formatter; later calls of `format` and `walks` are synchronous once this resolves. */
export const loadFormatter = () => (ready ??= load().catch((e) => ((ready = undefined), Promise.reject(e))));

function put(w: Exports, s: string): [bigint, bigint] {
  const b = enc.encode(s);
  const n = BigInt(b.length);
  const p = w.alloc(n);
  new Uint8Array(w.memory.buffer, Number(p), b.length).set(b);
  return [p, n];
}

/** Formats `text` as the file at `path` (its name picks the language). */
export async function format(path: string, text: string, options: FormatOptions = {}): Promise<{ text: string } | { error: FormatFailure }> {
  const w = await loadFormatter();
  const flags = (options.useTabs ? 1 : 0) | (options.noSemi ? 2 : 0) | (options.singleQuote ? 4 : 0);
  const [pp, pl] = put(w, path);
  const [tp, tl] = put(w, text);
  const out = w.format_c(pp, pl, tp, tl, flags, options.printWidth ?? 0);
  const view = new DataView(w.memory.buffer);
  const status = view.getBigUint64(Number(out), true);
  const ptr = view.getBigUint64(Number(out) + 8, true);
  const len = view.getBigUint64(Number(out) + 16, true);
  const result = status === 0n ? { text: dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len))) } : { error: (["syntax", "bug", "unsupported"] as const)[Number(status) - 1] ?? "bug" };
  w.output_free(out);
  w.dealloc(pp, pl);
  w.dealloc(tp, tl);
  return result;
}

/** Whether `bun fmt <dir>` formats the file at `path`: a language it supports, and not a lock file or minified. */
export async function walks(path: string): Promise<boolean> {
  const w = await loadFormatter();
  const [pp, pl] = put(w, path);
  const yes = w.walks_c(pp, pl) === 1;
  w.dealloc(pp, pl);
  return yes;
}
