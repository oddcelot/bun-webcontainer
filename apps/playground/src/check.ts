import { BASE } from "./base";
import type { VFS } from "@runbun/vfs";
import { createSysImports } from "@runbun/vfs/sysHost";

// `bun check` (Bun's TypeScript 7 type checker) compiled to wasm64; see crates/check-wasm. It reads the project over
// the VFS like Bun reads the disk: tsconfig.json, the files it includes, node_modules' types. Loaded on first use
// (~3.3 MB compressed).

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  run_c(argsPtr: bigint, argsLen: bigint, colors: number): bigint;
  run_output_free(out: bigint): void;
};

/** What `bun check` printed: the errors on stdout, the summary on stderr. */
export type CheckResult = { exitCode: number; stdout: string; stderr: string };

let compiled: Promise<WebAssembly.Module> | undefined;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A fresh instance per check: nothing a check caches (the program, its parsed files) outlives it. */
async function instantiate(vfs: VFS): Promise<Exports> {
  compiled ??= WebAssembly.compileStreaming(fetch(new URL(`${BASE}bun_check_wasm.wasm`, location.href))).catch((e) => {
    compiled = undefined;
    throw e;
  });
  const module = await compiled;
  let memory: WebAssembly.Memory | undefined;
  // Not `new WebAssembly.Instance`: Chrome refuses that on the main thread for a module over 8 MB.
  const instance = await WebAssembly.instantiate(module, createSysImports(vfs, () => memory!, () => new Uint8Array(0)) as unknown as WebAssembly.Imports);
  const w = instance.exports as unknown as Exports;
  memory = w.memory;
  return w;
}

/** `bun check [args]` over the project in `vfs`. `colors`: ANSI colors and source excerpts, as in a terminal. */
export async function check(vfs: VFS, args: string[], colors = true): Promise<CheckResult> {
  const w = await instantiate(vfs);
  const bytes = enc.encode(args.join("\0"));
  const len = BigInt(bytes.length);
  const ptr = w.alloc(len);
  new Uint8Array(w.memory.buffer, Number(ptr), bytes.length).set(bytes);
  const out = w.run_c(ptr, len, colors ? 1 : 0);
  w.dealloc(ptr, len);
  const view = new DataView(w.memory.buffer);
  const at = (i: number) => view.getBigUint64(Number(out) + 8 * i, true);
  const str = (p: bigint, n: bigint) => dec.decode(new Uint8Array(w.memory.buffer, Number(p), Number(n)));
  const result = { exitCode: Number(at(0)), stdout: str(at(1), at(2)), stderr: str(at(3), at(4)) };
  w.run_output_free(out);
  return result;
}
