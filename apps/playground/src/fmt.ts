import { BASE } from "./base";
import type { VFS } from "@runbun/vfs";
import { createSysImports } from "@runbun/vfs/sysHost";

// `bun fmt` (Bun's own Prettier-compatible formatter) compiled to wasm64; see crates/fmt-wasm. Each call runs
// `bun fmt [flags] --stdin-filepath <path>` itself over the VFS, so the project's configs apply as in Bun: bunfig.toml's
// [fmt], .prettierrc*, package.json's "prettier", .editorconfig and .prettierignore. Loaded on first use (~2.5 MB
// compressed).

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  run_c(argsPtr: bigint, argsLen: bigint, colors: number): bigint;
  run_output_free(out: bigint): void;
  walks_c(pathPtr: bigint, pathLen: bigint): number;
};

/** What `bun fmt --stdin-filepath` printed: the formatted text on stdout; errors (with a code frame) on stderr. */
export type FmtResult = { exitCode: number; stdout: string; stderr: string };

let compiled: Promise<WebAssembly.Module> | undefined;
let bound: { vfs: VFS; w: Exports } | undefined;
// The text `bun fmt` reads as standard input; sysHost rewinds fd 0 when this changes.
let stdin = new Uint8Array(0);
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Loads the formatter (once) and binds it to `vfs`, where it reads the project's configs. */
export async function loadFormatter(vfs: VFS): Promise<Exports> {
  compiled ??= WebAssembly.compileStreaming(fetch(new URL(`${BASE}bun_fmt_wasm.wasm`, location.href))).catch((e) => {
    compiled = undefined;
    throw e;
  });
  const module = await compiled;
  if (bound?.vfs !== vfs) {
    let memory: WebAssembly.Memory | undefined;
    // Not `new WebAssembly.Instance`: Chrome refuses that on the main thread for a module over 8 MB.
    const instance = await WebAssembly.instantiate(module, createSysImports(vfs, () => memory!, () => stdin) as unknown as WebAssembly.Imports);
    const w = instance.exports as unknown as Exports;
    memory = w.memory;
    bound = { vfs, w };
  }
  return bound.w;
}

function withBytes<T>(w: Exports, bytes: Uint8Array, f: (ptr: bigint, len: bigint) => T): T {
  const len = BigInt(bytes.length);
  const ptr = w.alloc(len);
  new Uint8Array(w.memory.buffer, Number(ptr), bytes.length).set(bytes);
  try {
    return f(ptr, len);
  } finally {
    w.dealloc(ptr, len);
  }
}

/** `bun fmt [flags] --stdin-filepath <path>` with `text` as its input. `colors`: ANSI colors in stderr. */
export async function fmt(vfs: VFS, path: string, text: string, flags: string[] = [], colors = false): Promise<FmtResult> {
  const w = await loadFormatter(vfs);
  stdin = enc.encode(text);
  const out = withBytes(w, enc.encode([...flags, "--stdin-filepath", path].join("\0")), (p, n) => w.run_c(p, n, colors ? 1 : 0));
  const view = new DataView(w.memory.buffer);
  const at = (i: number) => view.getBigUint64(Number(out) + 8 * i, true);
  const str = (ptr: bigint, len: bigint) => dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  const result = { exitCode: Number(at(0)), stdout: str(at(1), at(2)), stderr: str(at(3), at(4)) };
  w.run_output_free(out);
  return result;
}

/** Whether `bun fmt <dir>` formats the file at `path`: a language it supports, and not a lock file or minified. */
export async function walks(vfs: VFS, path: string): Promise<boolean> {
  const w = await loadFormatter(vfs);
  return withBytes(w, enc.encode(path), (p, n) => w.walks_c(p, n)) === 1;
}

/** `bun fmt`'s stderr as one console entry (a code frame is one error, not one per line). */
export const asConsoleEntry = (stderr: string) => stderr.replace(/\n$/, "").replaceAll("\n", "\r\n");

/** Where `bun fmt`'s error points (`at <path>:<line>:<column>`) and its message, from stderr without colors. */
export function errorLocation(stderr: string): { message: string; line: number; column: number } | null {
  const at = /\n\s*at .+:(\d+):(\d+)\s*$/m.exec(stderr);
  const message = /^error: (.*)$/m.exec(stderr)?.[1];
  return at && message ? { message, line: Number(at[1]), column: Number(at[2]) } : null;
}
