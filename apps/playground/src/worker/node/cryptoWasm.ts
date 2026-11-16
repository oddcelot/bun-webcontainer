// The byte-buffer ABI of crypto-wasm (crates/crypto-wasm/src/lib.rs): RustCrypto behind node:crypto's synchronous
// ciphers, signatures and key objects. The module loads on the first call that needs it, synchronously, as the
// transpiler does for `Bun.Transpiler#transformSync` (src/transpiler/index.ts): the worker registers how to get the
// compiled module (a synchronous XHR and compile, see runtime.ts), and a program that never uses a cipher or a key
// never fetches the 0.6 MB. Nothing runs when this module is evaluated: the page imports it too.
import { codeError } from "./errors";

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  call(op: number, ptr: bigint, len: bigint): bigint;
};

type Field = Uint8Array | string | number;

let source: (() => WebAssembly.Module) | undefined;
let wasm: Exports | undefined;

/** How to get the compiled module, synchronously. Set once by the worker (or a test). */
export function setCryptoWasm(load: () => WebAssembly.Module) {
  source = load;
}

function instance(): Exports {
  if (wasm) return wasm;
  if (!source) throw new Error("node:crypto's ciphers and keys need the crypto module, which isn't available here");
  const env = {
    host_random(ptr: bigint, len: bigint) {
      const mem = new Uint8Array(wasm!.memory.buffer, Number(ptr), Number(len));
      for (let i = 0; i < mem.length; i += 65536) crypto.getRandomValues(mem.subarray(i, i + 65536));
    },
  };
  return (wasm = new WebAssembly.Instance(source(), { env }).exports as unknown as Exports);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Errors in the class Node gives them: a RangeError for lengths, a TypeError for arguments. */
function wasmError(code: string, message: string): Error {
  const Ctor = code === "ERR_CRYPTO_INVALID_KEYLEN" ? RangeError : code === "ERR_CRYPTO_INVALID_IV" || code === "ERR_CRYPTO_INVALID_DIGEST" || code === "ERR_CRYPTO_INVALID_AUTH_TAG" || code.startsWith("ERR_INVALID_ARG") ? TypeError : Error;
  // Node and Bun give no code to a failed authentication or a call in the wrong state.
  if (code === "ERR_CRYPTO_UNSUPPORTED_STATE") return new Error(message);
  const e = codeError(Ctor, code, message) as Error & { reason?: string; library?: string };
  // "error:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT": BoringSSL's text, which Bun's errors carry.
  const m = /^error:[0-9a-fA-F]+:([^:]*):(?:[^:]*:)?([^:]*)$/.exec(message);
  if (m) [e.library, e.reason] = [m[1], m[2]];
  return e;
}

/** One call of crate `op` with `fields` (bytes, strings, or numbers as 4 little-endian bytes): its result fields. */
export function wcall(op: number, ...fields: Field[]): Uint8Array[] {
  const w = instance();
  const parts = fields.map((f) => {
    if (typeof f === "number") {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, f, true);
      return b;
    }
    return typeof f === "string" ? enc.encode(f) : f;
  });
  const total = parts.reduce((n, p) => n + 4 + p.length, 0);
  const ptr = w.alloc(BigInt(total));
  let at = Number(ptr);
  for (const p of parts) {
    new DataView(w.memory.buffer).setUint32(at, p.length, true);
    new Uint8Array(w.memory.buffer, at + 4, p.length).set(p);
    at += 4 + p.length;
  }
  let res: bigint;
  try {
    res = w.call(op, ptr, BigInt(total));
  } finally {
    w.dealloc(ptr, BigInt(total));
  }
  // The memory may have grown: read through the current buffer.
  const mem = new Uint8Array(w.memory.buffer);
  const view = new DataView(w.memory.buffer);
  const base = Number(res);
  const len = view.getUint32(base, true);
  const status = view.getUint32(base + 4, true);
  const out: Uint8Array[] = [];
  for (let i = base + 8; i < base + len; ) {
    const n = view.getUint32(i, true);
    out.push(mem.slice(i + 4, i + 4 + n));
    i += 4 + n;
  }
  w.dealloc(res, BigInt(len));
  if (status !== 0) throw wasmError(dec.decode(out[0]), dec.decode(out[1]));
  return out;
}
