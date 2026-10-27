import { hmac } from "@noble/hashes/hmac.js";
import { md5, sha1 } from "@noble/hashes/legacy.js";
import { sha224, sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { Buffer } from "buffer";
import { codeError } from "./errors";

type Algo = any;
const ALGOS: Record<string, Algo> = { md5, sha1, sha224, sha256, sha384, sha512, "sha-1": sha1, "sha-256": sha256, "sha-384": sha384, "sha-512": sha512 };

function algo(name: string): Algo {
  const a = ALGOS[name.toLowerCase()];
  if (!a) throw Object.assign(new Error("Digest method not supported"), { code: "ERR_OSSL_EVP_UNSUPPORTED" });
  return a;
}

type Data = string | ArrayBufferView | ArrayBuffer;

function bytes(data: Data, enc?: string): Uint8Array {
  if (typeof data === "string") return Uint8Array.from(Buffer.from(data, (enc as BufferEncoding) ?? "utf8"));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
}

function encode(out: Uint8Array, enc?: string): string | Buffer {
  const b = Buffer.from(out);
  if (!enc || enc === "buffer") return b;
  if (enc === "base64url") return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b.toString(enc as BufferEncoding);
}

type Hasher = { update(d: Uint8Array): unknown; digest(): Uint8Array; clone(): Hasher };

class Hash {
  private done = false;
  constructor(private h: Hasher) {}
  update(data: Data, enc?: string) {
    if (this.done) throw codeError(Error, "ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    this.h.update(bytes(data, enc));
    return this;
  }
  digest(enc?: string) {
    if (this.done) throw codeError(Error, "ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    this.done = true;
    return encode(this.h.digest(), enc);
  }
  copy() {
    return new Hash(this.h.clone());
  }
}

const createHash = (alg: string) => new Hash(algo(alg).create() as Hasher);
const createHmac = (alg: string, key: Data) => new Hash(hmac.create(algo(alg), bytes(key)) as Hasher);

function getRandomValues<T extends ArrayBufferView>(a: T): T {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < u.length; i += 65536) crypto.getRandomValues(u.subarray(i, i + 65536) as Uint8Array<ArrayBuffer>);
  return a;
}

function randomBytes(n: number, cb?: (err: Error | null, b: Buffer) => void) {
  const b = getRandomValues(Buffer.alloc(n));
  if (cb) queueMicrotask(() => cb(null, b));
  else return b;
}

export default {
  createHash,
  createHmac,
  hash: (alg: string, data: Data, enc: string = "hex") => encode(algo(alg).create().update(bytes(data)).digest(), enc),
  getHashes: () => ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"],
  randomBytes,
  randomFillSync: <T extends ArrayBufferView>(b: T) => getRandomValues(b),
  randomUUID: () => crypto.randomUUID(),
  randomInt(min: number, max?: number, cb?: (err: Error | null, n: number) => void) {
    if (max === undefined || typeof max === "function") [min, max, cb] = [0, min, max as unknown as typeof cb];
    const n = min + Math.floor((getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (max - min));
    if (cb) queueMicrotask(() => cb!(null, n));
    else return n;
  },
  getRandomValues,
  webcrypto: crypto,
  subtle: crypto.subtle,
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView) {
    const x = bytes(a);
    const y = bytes(b);
    if (x.length !== y.length) throw codeError(RangeError, "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "Input buffers must have the same byte length");
    let r = 0;
    for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
    return r === 0;
  },
};
