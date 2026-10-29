// `Bun.hash`: ports of the non-cryptographic hashes Bun ships (bun/src/wyhash, bun/src/hash), checked against
// Bun's output. 64-bit ones use BigInt and return bigints, as Bun's do. cityHash, xxHash3 and rapidhash are missing.
import zlib from "./node/zlib";

type Input = string | ArrayBuffer | ArrayBufferView;
type Seed = number | bigint;

const M64 = (1n << 64n) - 1n;
const bytesOf = (d: Input) =>
  typeof d === "string" ? new TextEncoder().encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
const seed64 = (s: Seed = 0) => BigInt.asUintN(64, BigInt(typeof s === "number" ? Math.trunc(s) : s));
const seed32 = (s: Seed = 0) => Number(seed64(s) & 0xffffffffn);
const r32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const r64 = (b: Uint8Array, i: number) => BigInt(r32(b, i)) | (BigInt(r32(b, i + 4)) << 32n);
const rotl32 = (x: number, r: number) => ((x << r) | (x >>> (32 - r))) >>> 0;
const rotl64 = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & M64;

// ---- wyhash (final4, as bun_wyhash::Wyhash) ----
const SECRET = [0xa0761d6478bd642fn, 0xe7037ed1a0b428dbn, 0x8ebc6af09c88c6e3n, 0x589965cc75374cc3n];
const mum = (a: bigint, b: bigint): [bigint, bigint] => {
  const x = a * b;
  return [x & M64, (x >> 64n) & M64];
};
const mix = (a: bigint, b: bigint) => {
  const [lo, hi] = mum(a, b);
  return lo ^ hi;
};

function wyhash(data: Input, seed?: Seed): bigint {
  const input = bytesOf(data);
  const len = input.length;
  const s = seed64(seed);
  let s0 = s ^ mix(s ^ SECRET[0], SECRET[1]);
  let a: bigint, b: bigint;
  if (len <= 16) {
    if (len >= 4) {
      const end = len - 4;
      const quarter = (len >> 3) << 2;
      a = (BigInt(r32(input, 0)) << 32n) | BigInt(r32(input, quarter));
      b = (BigInt(r32(input, end)) << 32n) | BigInt(r32(input, end - quarter));
    } else if (len > 0) {
      a = BigInt((input[0] << 16) | (input[len >> 1] << 8) | input[len - 1]);
      b = 0n;
    } else a = b = 0n;
  } else {
    let i = 0;
    if (len >= 48) {
      let s1 = s0, s2 = s0;
      for (; i < len - 48; i += 48) {
        s0 = mix(r64(input, i) ^ SECRET[1], r64(input, i + 8) ^ s0);
        s1 = mix(r64(input, i + 16) ^ SECRET[2], r64(input, i + 24) ^ s1);
        s2 = mix(r64(input, i + 32) ^ SECRET[3], r64(input, i + 40) ^ s2);
      }
      s0 ^= s1 ^ s2;
    }
    for (let j = i; j + 16 < len; j += 16) s0 = mix(r64(input, j) ^ SECRET[1], r64(input, j + 8) ^ s0);
    a = r64(input, len - 16);
    b = r64(input, len - 8);
  }
  [a, b] = mum(a ^ SECRET[1], b ^ s0);
  return mix(a ^ SECRET[0] ^ BigInt(len), b ^ SECRET[1]);
}

function adler32(data: Input): number {
  let s1 = 1, s2 = 0;
  for (const c of bytesOf(data)) {
    s1 = (s1 + c) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

function murmur32v2(data: Input, seed?: Seed): number {
  const s = bytesOf(data);
  const M = 0x5bd1e995;
  let h = (seed32(seed) ^ s.length) >>> 0;
  const blocks = s.length >> 2;
  for (let i = 0; i < blocks; i++) {
    let k = Math.imul(r32(s, i * 4), M);
    k ^= k >>> 24;
    k = Math.imul(k, M);
    h = Math.imul(h, M) ^ k;
  }
  const o = blocks * 4;
  const rest = s.length & 3;
  if (rest >= 3) h ^= s[o + 2] << 16;
  if (rest >= 2) h ^= s[o + 1] << 8;
  if (rest >= 1) h = Math.imul(h ^ s[o], M);
  h ^= h >>> 13;
  h = Math.imul(h, M);
  return (h ^ (h >>> 15)) >>> 0;
}

function murmur32v3(data: Input, seed?: Seed): number {
  const s = bytesOf(data);
  const C1 = 0xcc9e2d51, C2 = 0x1b873593;
  let h = seed32(seed);
  const blocks = s.length >> 2;
  for (let i = 0; i < blocks; i++) {
    const k = Math.imul(rotl32(Math.imul(r32(s, i * 4), C1), 15), C2);
    h = (Math.imul(rotl32((h ^ k) >>> 0, 13), 5) + 0xe6546b64) >>> 0;
  }
  const o = blocks * 4;
  const rest = s.length & 3;
  let k = 0;
  if (rest === 3) k ^= s[o + 2] << 16;
  if (rest >= 2) k ^= s[o + 1] << 8;
  if (rest >= 1) h ^= Math.imul(rotl32(Math.imul(k ^ s[o], C1), 15), C2);
  h ^= s.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function murmur64v2(data: Input, seed?: Seed): bigint {
  const s = bytesOf(data);
  const M = 0xc6a4a7935bd1e995n;
  let h = seed64(seed) ^ ((BigInt(s.length) * M) & M64);
  const blocks = s.length >> 3;
  for (let i = 0; i < blocks; i++) {
    let k = (r64(s, i * 8) * M) & M64;
    k ^= k >> 47n;
    k = (k * M) & M64;
    h = ((h ^ k) * M) & M64;
  }
  const rest = s.length & 7;
  if (rest) {
    let k = 0n;
    for (let j = rest - 1; j >= 0; j--) k = (k << 8n) | BigInt(s[blocks * 8 + j]);
    h = ((h ^ k) * M) & M64;
  }
  h ^= h >> 47n;
  h = (h * M) & M64;
  return h ^ (h >> 47n);
}

function xxHash32(data: Input, seed?: Seed): number {
  const s = bytesOf(data);
  const P1 = 0x9e3779b1, P2 = 0x85ebca77, P3 = 0xc2b2ae3d, P4 = 0x27d4eb2f, P5 = 0x165667b1;
  const sd = seed32(seed);
  const round = (acc: number, lane: number) => Math.imul(rotl32((acc + Math.imul(lane, P2)) >>> 0, 13), P1);
  let i = 0;
  let h: number;
  if (s.length >= 16) {
    let v1 = (sd + P1 + P2) >>> 0, v2 = (sd + P2) >>> 0, v3 = sd, v4 = (sd - P1) >>> 0;
    for (; i + 16 <= s.length; i += 16) {
      v1 = round(v1, r32(s, i));
      v2 = round(v2, r32(s, i + 4));
      v3 = round(v3, r32(s, i + 8));
      v4 = round(v4, r32(s, i + 12));
    }
    h = (rotl32(v1 >>> 0, 1) + rotl32(v2 >>> 0, 7) + rotl32(v3 >>> 0, 12) + rotl32(v4 >>> 0, 18)) >>> 0;
  } else h = (sd + P5) >>> 0;
  h = (h + s.length) >>> 0;
  for (; i + 4 <= s.length; i += 4) h = Math.imul(rotl32((h + Math.imul(r32(s, i), P3)) >>> 0, 17), P4);
  for (; i < s.length; i++) h = Math.imul(rotl32((h + Math.imul(s[i], P5)) >>> 0, 11), P1);
  h ^= h >>> 15;
  h = Math.imul(h, P2);
  h ^= h >>> 13;
  h = Math.imul(h, P3);
  return (h ^ (h >>> 16)) >>> 0;
}

function xxHash64(data: Input, seed?: Seed): bigint {
  const s = bytesOf(data);
  const P1 = 0x9e3779b185ebca87n, P2 = 0xc2b2ae3d27d4eb4fn, P3 = 0x165667b19e3779f9n, P4 = 0x85ebca77c2b2ae63n, P5 = 0x27d4eb2f165667c5n;
  const sd = seed64(seed);
  const round = (acc: bigint, lane: bigint) => (rotl64((acc + lane * P2) & M64, 31n) * P1) & M64;
  const merge = (h: bigint, v: bigint) => (((h ^ round(0n, v)) * P1 + P4) & M64);
  let i = 0;
  let h: bigint;
  if (s.length >= 32) {
    let v1 = (sd + P1 + P2) & M64, v2 = (sd + P2) & M64, v3 = sd, v4 = (sd - P1) & M64;
    for (; i + 32 <= s.length; i += 32) {
      v1 = round(v1, r64(s, i));
      v2 = round(v2, r64(s, i + 8));
      v3 = round(v3, r64(s, i + 16));
      v4 = round(v4, r64(s, i + 24));
    }
    h = (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & M64;
    h = merge(merge(merge(merge(h, v1), v2), v3), v4);
  } else h = (sd + P5) & M64;
  h = (h + BigInt(s.length)) & M64;
  for (; i + 8 <= s.length; i += 8) h = (rotl64(h ^ round(0n, r64(s, i)), 27n) * P1 + P4) & M64;
  if (i + 4 <= s.length) {
    h = (rotl64(h ^ ((BigInt(r32(s, i)) * P1) & M64), 23n) * P2 + P3) & M64;
    i += 4;
  }
  for (; i < s.length; i++) h = (rotl64(h ^ ((BigInt(s[i]) * P5) & M64), 11n) * P1) & M64;
  h ^= h >> 33n;
  h = (h * P2) & M64;
  h ^= h >> 29n;
  h = (h * P3) & M64;
  return h ^ (h >> 32n);
}

const missing = (name: string) => () => {
  throw new Error(`Bun.hash.${name} is not supported in the playground`);
};

export const hash = Object.assign((data: Input, seed?: Seed) => wyhash(data, seed), {
  wyhash,
  adler32,
  crc32: (data: Input, seed?: Seed) => (zlib.crc32 as (d: Input, v?: number) => number)(data, seed32(seed)),
  cityHash32: missing("cityHash32"),
  cityHash64: missing("cityHash64"),
  xxHash32,
  xxHash64,
  xxHash3: missing("xxHash3"),
  murmur32v2,
  murmur32v3,
  murmur64v2,
  rapidhash: missing("rapidhash"),
});
