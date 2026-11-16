// Zstandard and Brotli (crates/compress-wasm, pure Rust) for `Bun.zstd*` and node:zlib. The APIs are synchronous, so the
// module is fetched (a synchronous XHR, which a worker may do) and instantiated on the first call, not at boot.
// Compressed bytes differ from native Bun's encoders'; they decode with any zstd or brotli decoder.
import { BASE } from "../base";
import { XHR } from "./xhr";
import { Buffer } from "./node/buffer";
import { brotliConstants } from "./node/zlibConstants";

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  out_ptr(): bigint;
  out_len(): bigint;
  out_free(): void;
  zstd_compress(ptr: bigint, len: bigint, level: number): number;
  zstd_decompress(ptr: bigint, len: bigint): number;
  brotli_compress(ptr: bigint, len: bigint, quality: number, lgwin: number, mode: number, sizeHint: number, lgblock: number, disableCtx: number, largeWindow: number): number;
  brotli_decompress(ptr: bigint, len: bigint, largeWindow: number): number;
};

let exports: Exports | undefined;

/** One instance per worker (a tab gets only about 60 wasm64 memories, see resolver.ts), made on first use. */
function wasm(): Exports {
  if (exports) return exports;
  const xhr = new XHR();
  xhr.open("GET", new URL(`${BASE}bun_compress_wasm.wasm`, location.href).href, false);
  xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status !== 200) throw new Error(`could not load bun_compress_wasm.wasm (${xhr.status})`);
  return (exports = new WebAssembly.Instance(new WebAssembly.Module(xhr.response as ArrayBuffer), {}).exports as unknown as Exports);
}

/** Runs `call(ptr, len)` over `data` in wasm memory: the result if it returned 0, else its status. */
function run(data: Uint8Array, call: (w: Exports, ptr: bigint, len: bigint) => number): Uint8Array | number {
  const w = wasm();
  const len = BigInt(data.length);
  const ptr = w.alloc(len);
  try {
    new Uint8Array(w.memory.buffer, Number(ptr), data.length).set(data);
    const status = call(w, ptr, len);
    if (status !== 0) return status;
    const out = new Uint8Array(w.memory.buffer, Number(w.out_ptr()), Number(w.out_len())).slice();
    w.out_free();
    return out;
  } finally {
    w.dealloc(ptr, len);
  }
}

const ok = (r: Uint8Array | number): Uint8Array => {
  if (typeof r === "number") throw new Error(`compression failed (${r})`);
  return r;
};

/** Zstandard at `level` (1..22; below 1 is zstd's fast range). */
export const zstdCompress = (data: Uint8Array, level: number): Uint8Array => ok(run(data, (w, p, l) => w.zstd_compress(p, l, level)));

/** What `zstdDecompress` stopped at: the crate's status (compress-wasm's ZSTD_* constants). */
export const ZSTD = { BAD_FRAME: 1, CORRUPT: 2, TRUNCATED: 3, BAD_CHECKSUM: 4, UNSUPPORTED: 5 } as const;

/** The bytes of every frame in `data`, or a `ZSTD` status. */
export const zstdDecompress = (data: Uint8Array): Uint8Array | number => run(data, (w, p, l) => w.zstd_decompress(p, l));

export type BrotliParams = { quality?: number; lgwin?: number; mode?: number; sizeHint?: number; lgblock?: number; disableLiteralContextModeling?: number; largeWindow?: number };

/** Brotli with the encoder parameters set (each unset one is the library's default: quality 11, 4 MiB window). */
export function brotliCompress(data: Uint8Array, p: BrotliParams = {}): Uint8Array {
  // Out-of-range values are clamped, as the C library does.
  const clamp = (v: number | undefined, lo: number, hi: number) => (v === undefined ? -1 : Math.min(Math.max(v, lo), hi));
  const large = p.largeWindow ? 1 : 0;
  return ok(
    run(data, (w, ptr, len) =>
      w.brotli_compress(
        ptr,
        len,
        clamp(p.quality, brotliConstants.BROTLI_MIN_QUALITY, brotliConstants.BROTLI_MAX_QUALITY),
        clamp(p.lgwin, brotliConstants.BROTLI_MIN_WINDOW_BITS, large ? brotliConstants.BROTLI_LARGE_MAX_WINDOW_BITS : brotliConstants.BROTLI_MAX_WINDOW_BITS),
        clamp(p.mode, 0, 2),
        p.sizeHint === undefined ? -1 : Math.max(0, Math.min(p.sizeHint, 2 ** 30)),
        clamp(p.lgblock, brotliConstants.BROTLI_MIN_INPUT_BLOCK_BITS, brotliConstants.BROTLI_MAX_INPUT_BLOCK_BITS),
        p.disableLiteralContextModeling === undefined ? -1 : p.disableLiteralContextModeling ? 1 : 0,
        large,
      ),
    ),
  );
}

/** `BROTLI_TRUNCATED`, or the decoder's negative `BROTLI_DECODER_ERROR_*` value, when it isn't bytes. */
export const BROTLI_TRUNCATED = 1000;
export const brotliDecompress = (data: Uint8Array, largeWindow = false): Uint8Array | number => run(data, (w, p, l) => w.brotli_decompress(p, l, largeWindow ? 1 : 0));

/** Bun's `data` argument: a string (as UTF-8), an ArrayBuffer or a view; the same message for anything else. */
export function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw Object.assign(new TypeError("data must be a string, ArrayBuffer or ArrayBufferView"), { code: "ERR_INVALID_ARG_TYPE" });
}

const buffer = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

function bunLevel(options: unknown): number {
  const given = options && typeof options === "object" ? (options as { level?: unknown }).level : undefined;
  if (given === undefined) return 3;
  // A number, or a string that is one ("3"), cut to an integer, as Bun does.
  const level = typeof given === "number" || typeof given === "string" ? Math.trunc(Number(given)) : NaN;
  if (!(level >= 1 && level <= 22)) throw Object.assign(new TypeError("Compression level must be between 1 and 22"), { code: "ERR_INVALID_ARG_TYPE" });
  return level;
}

/** `Bun.zstdCompressSync(data, { level })`: a Buffer; the level defaults to 3. */
export const bunZstdCompressSync = (data: unknown, options?: unknown): Buffer => {
  const bytes = toBytes(data);
  return buffer(zstdCompress(bytes, bunLevel(options)));
};

/** `Bun.zstdDecompressSync(data)`: a Buffer; corrupt input throws what Bun's does (`ERR_ZSTD`). */
export function bunZstdDecompressSync(data: unknown): Buffer {
  return inflate(toBytes(data));
}

function inflate(bytes: Uint8Array): Buffer {
  const r = zstdDecompress(bytes);
  if (typeof r === "number")
    throw Object.assign(new Error(`Decompression failed: ${r === ZSTD.BAD_FRAME || r === ZSTD.TRUNCATED ? "InvalidZstdData" : "DecompressionFailed"}`), { code: "ERR_ZSTD" });
  return buffer(r);
}

// The promise variants check their arguments before they return (a bad one throws, as in Bun), then settle after the call, as a pool thread's work would.
export function bunZstdCompress(data: unknown, options?: unknown): Promise<Buffer> {
  const bytes = toBytes(data);
  const level = bunLevel(options);
  return Promise.resolve().then(() => buffer(zstdCompress(bytes, level)));
}
export function bunZstdDecompress(data: unknown): Promise<Buffer> {
  const bytes = toBytes(data);
  return Promise.resolve().then(() => inflate(bytes));
}

// Bun's names for them (the runtime's tracking wrapper takes the name from the function).
for (const [fn, name] of [[bunZstdCompressSync, "zstdCompressSync"], [bunZstdDecompressSync, "zstdDecompressSync"], [bunZstdCompress, "zstdCompress"], [bunZstdDecompress, "zstdDecompress"]] as const)
  Object.defineProperty(fn, "name", { value: name });

const BROTLI_OR_ZSTD = ["brotli", "zstd"];

/** What a stream of `format` does at its end: Brotli's and zstd's codecs only run on a whole input, so those streams hold it until then. */
function wholeStream(format: "brotli" | "zstd", compress: boolean): TransformStream<unknown, Uint8Array> {
  const chunks: Uint8Array[] = [];
  return new TransformStream({
    transform(chunk) {
      chunks.push(toBytes(chunk));
    },
    flush(controller) {
      const input = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let at = 0;
      for (const c of chunks) {
        input.set(c, at);
        at += c.byteLength;
      }
      const out = compress ? (format === "brotli" ? brotliCompress(input) : zstdCompress(input, 3)) : format === "brotli" ? brotliDecompress(input) : zstdDecompress(input);
      if (typeof out === "number") throw new TypeError("Decompression failed");
      controller.enqueue(out);
    },
  });
}

/**
 * `CompressionStream` and `DecompressionStream` that also take "brotli" and "zstd", as Bun's do (Chrome's take gzip,
 * deflate and deflate-raw only, until it adds them; then its own is used first).
 */
export function withBrotliZstd<T extends typeof CompressionStream | typeof DecompressionStream>(Native: T, compress: boolean): T {
  const Wrapped = function (format: string) {
    try {
      return new (Native as new (f: string) => object)(format);
    } catch (e) {
      if (!BROTLI_OR_ZSTD.includes(format)) throw e;
      return wholeStream(format as "brotli" | "zstd", compress);
    }
  } as unknown as T;
  Wrapped.prototype = Native.prototype;
  return Wrapped;
}
