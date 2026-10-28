import { BASE } from "../base";
import type { VFS } from "../vfs";
import { createSysImports } from "./sysHost";

/** What `bundle_c` takes (see bundle-wasm/src/lib.rs); `write` is left out: outputs always come back in memory. */
export interface BundleConfig {
  cwd?: string;
  entryPoints: string[];
  target?: "browser" | "bun" | "node";
  format?: "esm" | "cjs" | "iife";
  minify?: boolean | { whitespace?: boolean; syntax?: boolean; identifiers?: boolean };
  splitting?: boolean;
  outdir?: string;
  external?: string[];
  define?: Record<string, string>;
  conditions?: string[];
  sourcemap?: "none" | "inline" | "external" | "linked";
  naming?: { entry?: string; chunk?: string; asset?: string };
  publicPath?: string;
  banner?: string;
  footer?: string;
}

export interface BundleLog {
  level: "error" | "warning" | "note" | "debug" | "verbose";
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface BundleOutput {
  path: string;
  kind: string;
  loader: string;
  hash: string;
  contents: string;
}

export interface BundleResult {
  success: boolean;
  outputs: BundleOutput[];
  logs: BundleLog[];
}

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  bundle_c(ptr: bigint, len: bigint): bigint;
  output_free(out: bigint): void;
  panic_message_c(): bigint;
};

let compiled: Promise<WebAssembly.Module> | undefined;

/** Fetched and compiled on first use (about 10 MB), then kept: each bundle instantiates it afresh. */
function loadModule() {
  compiled ??= fetch(new URL(`${BASE}bun_bundle_wasm.wasm`, location.href))
    .then((r) => {
      if (!r.ok) throw new Error(`bun_bundle_wasm.wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((b) => WebAssembly.compile(b))
    .catch((e) => {
      compiled = undefined;
      throw e;
    });
  return compiled;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const failure = (message: string): BundleResult => ({ success: false, outputs: [], logs: [{ level: "error", message }] });

/**
 * Bundles `config.entryPoints` from `vfs` with Bun's bundler. A panic aborts the wasm instance, so every call gets
 * a fresh one; a trap comes back as a failed result carrying the panic message.
 */
export async function bundle(vfs: VFS, config: BundleConfig): Promise<BundleResult> {
  const mod = await loadModule();
  let memory!: WebAssembly.Memory;
  const w = new WebAssembly.Instance(mod, createSysImports(vfs, () => memory) as WebAssembly.Imports).exports as unknown as Exports;
  memory = w.memory;
  const input = enc.encode(JSON.stringify({ cwd: "/", ...config, write: false }));
  const len = BigInt(input.length);
  const p = w.alloc(len);
  new Uint8Array(memory.buffer, Number(p), input.length).set(input);
  let out: bigint;
  try {
    out = w.bundle_c(p, len);
  } catch (e) {
    let msg = (e as Error).message;
    try {
      const [, mp, ml] = new BigUint64Array(memory.buffer, Number(w.panic_message_c()), 3);
      msg = `${dec.decode(new Uint8Array(memory.buffer, Number(mp), Number(ml)))} (${msg})`;
    } catch {}
    return failure(`bundler panicked: ${msg}`);
  }
  w.dealloc(p, len);
  const [status, ptr, n] = new BigUint64Array(memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(memory.buffer, Number(ptr), Number(n)));
  w.output_free(out);
  if (status !== 0n) return failure(text);
  return JSON.parse(text) as BundleResult;
}
