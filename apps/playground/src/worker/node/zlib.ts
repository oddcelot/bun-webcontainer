// node:zlib over fflate: gzip, zlib-wrapped and raw deflate, sync, callback and stream APIs; brotli and zstd over
// compress-wasm (../compress.ts), whose streams buffer their input and compress it when the stream ends.
import { Buffer } from "buffer";
import * as fflate from "fflate";
import { brotliCompress, brotliDecompress, BROTLI_TRUNCATED, zstdCompress, zstdDecompress, ZSTD, type BrotliParams } from "../compress";
import { brotliConstants, zstdConstants } from "./zlibConstants";
import { codeError } from "./errors";
import stream from "./stream";

type Data = string | ArrayBuffer | ArrayBufferView;
type Options = { level?: number; memLevel?: number; dictionary?: Data; info?: boolean; finishFlush?: number; params?: Record<number, number> };
type Callback = (err: Error | null, result?: Buffer) => void;
type Engine = { ondata: fflate.FlateStreamHandler; push(chunk: Uint8Array, final?: boolean): void; flush?(): void };

const zlibConstants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  ZLIB_VERNUM: 4865,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9,
  Z_DEFAULT_LEVEL: -1,
};

function bytes(data: Data): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const got = data === null || data === undefined ? String(data) : typeof data === "object" ? `an instance of ${(data as object).constructor?.name ?? "Object"}` : typeof data === "function" ? `function ${(data as { name: string }).name}` : `type ${typeof data} (${String(data)})`;
  throw Object.assign(new TypeError(`The "buffer" argument must be of type string, Buffer, TypedArray, DataView, or ArrayBuffer. Received ${got}`), { code: "ERR_INVALID_ARG_TYPE" });
}

/** fflate's options from Node's: level -1 is the default (6). */
function deflateOpts(o: Options = {}) {
  const level = o.level === undefined || o.level < 0 ? 6 : Math.min(o.level, 9);
  return { level, mem: o.memLevel, dictionary: o.dictionary === undefined ? undefined : bytes(o.dictionary) } as fflate.DeflateOptions;
}
const inflateOpts = (o: Options = {}) => ({ dictionary: o.dictionary === undefined ? undefined : bytes(o.dictionary) });

/** fflate's errors as Node's: corrupt input is a Z_DATA_ERROR. */
function zError(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if ((err as { code?: unknown }).code !== undefined) return err; // the brotli and zstd errors arrive with their codes
  return Object.assign(err, { code: "Z_DATA_ERROR", errno: constants.Z_DATA_ERROR });
}

const constants = { ...zlibConstants, ...brotliConstants, ...zstdConstants };

type Kind = "gzip" | "gunzip" | "deflate" | "inflate" | "deflateRaw" | "inflateRaw" | "unzip" | "brotliCompress" | "brotliDecompress" | "zstdCompress" | "zstdDecompress";

/** `options.params` entries as Node checks them: the key must be a parameter of the codec, the value a number. */
function paramEntries(o: Options | undefined, valid: (key: number) => boolean, what: "Brotli" | "zstd"): [number, number][] {
  const params = o?.params;
  if (params === undefined) return [];
  if (typeof params !== "object" || params === null) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.params" property must be of type object.');
  return Object.entries(params).map(([k, v]) => {
    const key = Number(k);
    if (!Number.isInteger(key) || !valid(key)) throw codeError(RangeError, what === "Brotli" ? "ERR_BROTLI_INVALID_PARAM" : "ERR_ZSTD_INVALID_PARAM", `${k} is not a valid ${what} parameter`);
    if (typeof v !== "number") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.params[${k}]" property must be of type number.`);
    return [key, v];
  });
}

const BROTLI_ENCODER_KEYS: Record<number, keyof BrotliParams | undefined> = { 0: "mode", 1: "quality", 2: "lgwin", 3: "lgblock", 4: "disableLiteralContextModeling", 5: "sizeHint", 6: "largeWindow", 7: undefined, 8: undefined };
const ZSTD_COMPRESS_KEYS = new Set([100, 101, 102, 103, 104, 105, 106, 107, 160, 161, 162, 163, 164, 200, 201, 202, 400, 401, 402]);
const ZSTD_DECOMPRESS_KEYS = new Set([100]);

function brotliCompressOpts(o?: Options): BrotliParams {
  const p: BrotliParams = {};
  // NPOSTFIX and NDIRECT are accepted and left to the encoder's own choice.
  for (const [k, v] of paramEntries(o, (k) => k in BROTLI_ENCODER_KEYS, "Brotli")) {
    const name = BROTLI_ENCODER_KEYS[k];
    if (name) p[name] = v;
  }
  return p;
}
const brotliLargeWindow = (o?: Options) => paramEntries(o, (k) => k === 0 || k === 1, "Brotli").some(([k, v]) => k === 1 && v !== 0);

/** Compression level from `params[ZSTD_c_compressionLevel]`: 0 (or unset) is zstd's default, 3. */
function zstdLevel(o?: Options): number {
  const level = paramEntries(o, (k) => ZSTD_COMPRESS_KEYS.has(k), "zstd").find(([k]) => k === zstdConstants.ZSTD_c_compressionLevel)?.[1] ?? 0;
  return level === 0 ? zstdConstants.ZSTD_CLEVEL_DEFAULT : level;
}

const BROTLI_ERROR_NAMES = new Map(Object.entries(brotliConstants).filter(([k]) => k.startsWith("BROTLI_DECODER_ERROR_")).map(([k, v]) => [v, k]));

/** Brotli's decoder statuses as Bun's errors: a stream that ends early is Z_BUF_ERROR; the rest keep the decoder's error name and number. */
function brotliInflate(d: Uint8Array, o?: Options): Uint8Array {
  const r = brotliDecompress(d, brotliLargeWindow(o));
  if (typeof r !== "number") return r;
  if (r === BROTLI_TRUNCATED) throw Object.assign(new Error("unexpected end of file"), { code: "Z_BUF_ERROR", errno: constants.Z_BUF_ERROR });
  const name = BROTLI_ERROR_NAMES.get(r) ?? "BROTLI_DECODER_ERROR_UNREACHABLE";
  // Bun drops the prefix but not the underscore after it: ERR__ERROR_FORMAT_PADDING_1.
  throw Object.assign(new Error("Decompression failed"), { code: `ERR_${name.slice("BROTLI_DECODER".length)}`, errno: r });
}

/** zstd's statuses as node:zlib's errors under Bun. Input that ends inside a frame gives no error there, just no output. */
function zstdInflate(d: Uint8Array, o?: Options): Uint8Array {
  paramEntries(o, (k) => ZSTD_DECOMPRESS_KEYS.has(k), "zstd");
  const r = zstdDecompress(d);
  if (typeof r !== "number") return r;
  if (r === ZSTD.TRUNCATED) return new Uint8Array(0);
  const [code, errno, message] =
    r === ZSTD.BAD_FRAME
      ? ["ZSTD_error_prefix_unknown", zstdConstants.ZSTD_error_prefix_unknown, "Unknown frame descriptor"]
      : r === ZSTD.BAD_CHECKSUM
        ? ["ZSTD_error_checksum_wrong", zstdConstants.ZSTD_error_checksum_wrong, "Restored data doesn't match checksum"]
        : r === ZSTD.UNSUPPORTED
          ? ["ZSTD_error_frameParameter_unsupported", zstdConstants.ZSTD_error_frameParameter_unsupported, "Unsupported frame parameter"]
          : ["ZSTD_error_corruption_detected", zstdConstants.ZSTD_error_corruption_detected, "Corrupted block detected"];
  throw Object.assign(new Error(message as string), { code, errno });
}

const SYNC: Record<Kind, (d: Uint8Array, o?: Options) => Uint8Array> = {
  gzip: (d, o) => fflate.gzipSync(d, deflateOpts(o)),
  gunzip: (d) => fflate.gunzipSync(d),
  deflate: (d, o) => fflate.zlibSync(d, deflateOpts(o)),
  inflate: (d, o) => fflate.unzlibSync(d, inflateOpts(o)),
  deflateRaw: (d, o) => fflate.deflateSync(d, deflateOpts(o)),
  inflateRaw: (d, o) => fflate.inflateSync(d, inflateOpts(o)),
  unzip: (d, o) => fflate.decompressSync(d, inflateOpts(o)),
  brotliCompress: (d, o) => brotliCompress(d, brotliCompressOpts(o)),
  brotliDecompress: (d, o) => brotliInflate(d, o),
  zstdCompress: (d, o) => zstdCompress(d, zstdLevel(o)),
  zstdDecompress: (d, o) => zstdInflate(d, o),
};

/** An engine for the codecs that only run on a whole input: it holds the chunks and emits the result at the end. */
function whole(run: (d: Uint8Array) => Uint8Array): Engine {
  const chunks: Uint8Array[] = [];
  const engine: Engine = {
    ondata: () => {},
    push(chunk, final) {
      if (chunk.byteLength) chunks.push(chunk);
      if (!final) return;
      const input = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let at = 0;
      for (const c of chunks) {
        input.set(c, at);
        at += c.byteLength;
      }
      chunks.length = 0;
      engine.ondata(run(input) as Uint8Array<ArrayBuffer>, true);
    },
  };
  return engine;
}

const ENGINE: Record<Kind, (o?: Options) => Engine> = {
  gzip: (o) => new fflate.Gzip(deflateOpts(o)),
  gunzip: () => new fflate.Gunzip(),
  deflate: (o) => new fflate.Zlib(deflateOpts(o)),
  inflate: (o) => new fflate.Unzlib(inflateOpts(o)),
  deflateRaw: (o) => new fflate.Deflate(deflateOpts(o)),
  inflateRaw: (o) => new fflate.Inflate(inflateOpts(o)),
  unzip: (o) => new fflate.Decompress(inflateOpts(o)),
  brotliCompress: (o) => whole((d) => SYNC.brotliCompress(d, o)),
  brotliDecompress: (o) => whole((d) => SYNC.brotliDecompress(d, o)),
  zstdCompress: (o) => whole((d) => SYNC.zstdCompress(d, o)),
  zstdDecompress: (o) => whole((d) => SYNC.zstdDecompress(d, o)),
};

function runSync(kind: Kind, data: Data, opts?: Options): Buffer {
  try {
    const out = SYNC[kind](bytes(data), opts);
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  } catch (e) {
    throw zError(e);
  }
}

function runAsync(kind: Kind, data: Data, opts: Options | Callback, cb?: Callback) {
  if (typeof opts === "function") [opts, cb] = [{}, opts];
  let result: Buffer;
  try {
    result = runSync(kind, data, opts);
  } catch (e) {
    return queueMicrotask(() => cb!(e as Error));
  }
  queueMicrotask(() => cb!(null, result));
}

/** A Transform stream like Node's zlib classes. `flush()` emits what's buffered so far (compression middleware calls it). */
function createStream(kind: Kind, opts?: Options) {
  const engine = ENGINE[kind](opts);
  const Transform = (stream as unknown as { Transform: new (o: object) => any }).Transform;
  const t = new Transform({
    transform(chunk: Data, _enc: string, cb: (err?: Error | null) => void) {
      try {
        const b = bytes(chunk);
        t.bytesWritten += b.byteLength;
        engine.push(b, false);
        cb();
      } catch (e) {
        cb(zError(e));
      }
    },
    flush(cb: (err?: Error | null) => void) {
      try {
        engine.push(new Uint8Array(0), true);
        cb();
      } catch (e) {
        cb(zError(e));
      }
    },
  });
  engine.ondata = (d) => {
    if (d.byteLength) t.push(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
  };
  return Object.assign(t, {
    bytesWritten: 0,
    flush(kind?: number | (() => void), cb?: () => void) {
      if (typeof kind === "function") cb = kind;
      engine.flush?.();
      if (cb) queueMicrotask(cb);
    },
    params(_level: number, _strategy: number, cb?: () => void) {
      if (cb) queueMicrotask(cb);
    },
    reset() {},
    close(cb?: () => void) {
      t.destroy();
      if (cb) queueMicrotask(cb);
    },
  });
}

let CRC_TABLE: Int32Array | undefined;
function crc32(data: Data, value = 0): number {
  const table = (CRC_TABLE ??= Int32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n;
  }));
  let c = ~value;
  for (const b of bytes(data)) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const zlib: Record<string, unknown> = {
  constants,
  codes: { Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6 },
  crc32,
};
Object.assign(zlib, zlibConstants);
const CLASS: Record<Kind, string> = { gzip: "Gzip", gunzip: "Gunzip", deflate: "Deflate", inflate: "Inflate", deflateRaw: "DeflateRaw", inflateRaw: "InflateRaw", unzip: "Unzip", brotliCompress: "BrotliCompress", brotliDecompress: "BrotliDecompress", zstdCompress: "ZstdCompress", zstdDecompress: "ZstdDecompress" };
for (const kind of Object.keys(SYNC) as Kind[]) {
  const name = CLASS[kind];
  zlib[`${kind}Sync`] = (data: Data, opts?: Options) => runSync(kind, data, opts);
  zlib[kind] = (data: Data, opts: Options | Callback, cb?: Callback) => runAsync(kind, data, opts, cb);
  zlib[`create${name}`] = (opts?: Options) => createStream(kind, opts);
  // `new zlib.Gzip()` works too: a constructor that returns an object yields that object.
  zlib[name] = function (opts?: Options) {
    return createStream(kind, opts);
  };
}

export default zlib;
