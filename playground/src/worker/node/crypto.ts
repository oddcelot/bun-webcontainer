import { blake2b, blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { md5, ripemd160, sha1 } from "@noble/hashes/legacy.js";
import { pbkdf2 as nobleP, pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { scrypt as nobleS, scryptAsync } from "@noble/hashes/scrypt.js";
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from "@noble/hashes/sha2.js";
import { sha3_224, sha3_256, sha3_384, sha3_512 } from "@noble/hashes/sha3.js";
import { Buffer } from "buffer";
import { codeError } from "./errors";

type Algo = any;
const HASHES: Record<string, Algo> = {
  md5,
  ripemd160,
  sha1,
  sha224,
  sha256,
  sha384,
  sha512,
  "sha512-224": sha512_224,
  "sha512-256": sha512_256,
  "sha3-224": sha3_224,
  "sha3-256": sha3_256,
  "sha3-384": sha3_384,
  "sha3-512": sha3_512,
  blake2b256: { ...blake2b, outputLen: 32, create: () => blake2b.create({ dkLen: 32 }) },
  blake2b512: blake2b,
  blake2s256: blake2s,
};
const ALGOS: Record<string, Algo> = { ...HASHES, "rmd160": ripemd160, "sha-1": sha1, "sha-256": sha256, "sha-384": sha384, "sha-512": sha512 };

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

type Callback = (err: Error | null, key?: Buffer) => void;
type ScryptOptions = { N?: number; cost?: number; r?: number; blockSize?: number; p?: number; parallelization?: number; maxmem?: number };
const scryptOpts = (keylen: number, o: ScryptOptions = {}) => ({ N: o.N ?? o.cost ?? 16384, r: o.r ?? o.blockSize ?? 8, p: o.p ?? o.parallelization ?? 1, dkLen: keylen, maxmem: o.maxmem ?? 2 ** 32 });
const settle = (p: Promise<Uint8Array>, cb: Callback) => p.then((k) => cb(null, Buffer.from(k)), (e) => cb(e));

export default {
  createHash,
  createHmac,
  hash: (alg: string, data: Data, enc: string = "hex") => encode(algo(alg).create().update(bytes(data)).digest(), enc),
  getHashes: () => Object.keys(HASHES),
  pbkdf2Sync: (password: Data, salt: Data, iterations: number, keylen: number, digest: string) => Buffer.from(nobleP(algo(digest), bytes(password), bytes(salt), { c: iterations, dkLen: keylen })),
  pbkdf2(password: Data, salt: Data, iterations: number, keylen: number, digest: string, cb: Callback) {
    settle(pbkdf2Async(algo(digest), bytes(password), bytes(salt), { c: iterations, dkLen: keylen }), cb);
  },
  scryptSync: (password: Data, salt: Data, keylen: number, opts?: ScryptOptions) => Buffer.from(nobleS(bytes(password), bytes(salt), scryptOpts(keylen, opts))),
  scrypt(password: Data, salt: Data, keylen: number, opts: ScryptOptions | Callback, cb?: Callback) {
    if (typeof opts === "function") [opts, cb] = [{}, opts];
    settle(scryptAsync(bytes(password), bytes(salt), scryptOpts(keylen, opts)), cb!);
  },
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
