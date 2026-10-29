// node:zlib over fflate: gzip, zlib-wrapped and raw deflate, sync, callback and stream APIs. No brotli.
import { Buffer } from "buffer";
import * as fflate from "fflate";
import { stubModule } from "./errors";
import stream from "./stream";

type Data = string | ArrayBuffer | ArrayBufferView;
type Options = { level?: number; memLevel?: number; dictionary?: Data; info?: boolean; finishFlush?: number };
type Callback = (err: Error | null, result?: Buffer) => void;
type Engine = { ondata: fflate.FlateStreamHandler; push(chunk: Uint8Array, final?: boolean): void; flush?(): void };

const constants = {
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
  throw Object.assign(new TypeError('The "buffer" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer.'), { code: "ERR_INVALID_ARG_TYPE" });
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
  return Object.assign(err, { code: "Z_DATA_ERROR", errno: constants.Z_DATA_ERROR });
}

type Kind = "gzip" | "gunzip" | "deflate" | "inflate" | "deflateRaw" | "inflateRaw" | "unzip";

const SYNC: Record<Kind, (d: Uint8Array, o?: Options) => Uint8Array> = {
  gzip: (d, o) => fflate.gzipSync(d, deflateOpts(o)),
  gunzip: (d) => fflate.gunzipSync(d),
  deflate: (d, o) => fflate.zlibSync(d, deflateOpts(o)),
  inflate: (d, o) => fflate.unzlibSync(d, inflateOpts(o)),
  deflateRaw: (d, o) => fflate.deflateSync(d, deflateOpts(o)),
  inflateRaw: (d, o) => fflate.inflateSync(d, inflateOpts(o)),
  unzip: (d, o) => fflate.decompressSync(d, inflateOpts(o)),
};

const ENGINE: Record<Kind, (o?: Options) => Engine> = {
  gzip: (o) => new fflate.Gzip(deflateOpts(o)),
  gunzip: () => new fflate.Gunzip(),
  deflate: (o) => new fflate.Zlib(deflateOpts(o)),
  inflate: (o) => new fflate.Unzlib(inflateOpts(o)),
  deflateRaw: (o) => new fflate.Deflate(deflateOpts(o)),
  inflateRaw: (o) => new fflate.Inflate(inflateOpts(o)),
  unzip: (o) => new fflate.Decompress(inflateOpts(o)),
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
  ...stubModule("zlib", "createBrotliCompress createBrotliDecompress brotliCompress brotliDecompress brotliCompressSync brotliDecompressSync BrotliCompress BrotliDecompress"),
  constants,
  codes: { Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6 },
  crc32,
};
Object.assign(zlib, constants);
const CLASS: Record<Kind, string> = { gzip: "Gzip", gunzip: "Gunzip", deflate: "Deflate", inflate: "Inflate", deflateRaw: "DeflateRaw", inflateRaw: "InflateRaw", unzip: "Unzip" };
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
