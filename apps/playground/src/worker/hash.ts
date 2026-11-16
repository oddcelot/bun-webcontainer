// `Bun.hash`: ports of the non-cryptographic hashes Bun ships (bun/src/wyhash, bun/src/hash), checked against
// Bun's output. 64-bit ones use BigInt and return bigints, as Bun's do. Blob input is not supported (it cannot be read synchronously).
import zlib from "./node/zlib";

type Input = string | ArrayBuffer | ArrayBufferView;
type Seed = number | bigint;

const M64 = (1n << 64n) - 1n;
// Like Bun: bytes of a buffer or view, null/undefined throw, anything else is hashed as its string form.
const bytesOf = (d: unknown): Uint8Array => {
  if (d == null) throw new TypeError("data must be a string, ArrayBuffer, ArrayBufferView or Blob");
  if (typeof d === "string") return new TextEncoder().encode(d);
  if (d instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && d instanceof SharedArrayBuffer)) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (typeof Blob !== "undefined" && d instanceof Blob) throw new TypeError("Bun.hash of a Blob is not supported in the playground");
  return new TextEncoder().encode(String(d));
};
// Bun's seed: a BigInt wraps to 64 bits; a number truncates and wraps, except that >= 2^64 (and Infinity) saturates and
// NaN/-Infinity are 0; anything else is 0.
const seed64 = (s: unknown = 0) => {
  if (typeof s === "bigint") return BigInt.asUintN(64, s);
  if (typeof s !== "number" || !Number.isFinite(s)) return s === Infinity ? M64 : 0n;
  return s >= 18446744073709551616 ? M64 : BigInt.asUintN(64, BigInt(Math.trunc(s)));
};
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

// ---- cityHash (CityHash 1.1 as Abseil has it: bun/src/hash/cityhash.rs) ----
const rotr32 = (x: number, r: number) => ((x >>> r) | (x << (32 - r))) >>> 0;
const rotr64 = (x: bigint, r: bigint) => ((x >> r) | (x << (64n - r))) & M64;
const m64 = (x: bigint) => x & M64;
const bswap32 = (x: number) => (((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)) >>> 0;
const bswap64 = (x: bigint) => {
  let r = 0n;
  for (let i = 0; i < 8; i++) r = (r << 8n) | ((x >> BigInt(i * 8)) & 0xffn);
  return r;
};

function cityHash32(data: Input): number {
  const s = bytesOf(data);
  const len = s.length;
  const C1 = 0xcc9e2d51, C2 = 0x1b873593;
  const fmix = (h: number) => {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  };
  const step = (x: number) => (Math.imul(rotr32(x >>> 0, 19), 5) + 0xe6546b64) >>> 0;
  const mur = (a: number, h: number) => step((h ^ Math.imul(rotr32(Math.imul(a, C1), 17), C2)) >>> 0);
  if (len <= 24) {
    if (len <= 4) {
      let b = 0, c = 9;
      for (let i = 0; i < len; i++) {
        b = (Math.imul(b, C1) + ((s[i] << 24) >> 24)) >>> 0;
        c = (c ^ b) >>> 0;
      }
      return fmix(mur(b, mur(len, c)));
    }
    if (len <= 12) {
      const d = Math.imul(len, 5) >>> 0;
      const a = (len + r32(s, 0)) >>> 0, b = (d + r32(s, len - 4)) >>> 0, c = (9 + r32(s, (len >> 1) & 4)) >>> 0;
      return fmix(mur(c, mur(b, mur(a, d))));
    }
    const a = r32(s, (len >> 1) - 4), b = r32(s, 4), c = r32(s, len - 8), d = r32(s, len >> 1), e = r32(s, 0), f = r32(s, len - 4);
    return fmix(mur(f, mur(e, mur(d, mur(c, mur(b, mur(a, len)))))));
  }
  const k = (o: number) => Math.imul(rotr32(Math.imul(r32(s, o), C1), 17), C2) >>> 0;
  let h = len, g = Math.imul(C1, len) >>> 0, f = g;
  h = step(h ^ k(len - 4));
  h = step(h ^ k(len - 16));
  g = step(g ^ k(len - 8));
  g = step(g ^ k(len - 12));
  f = step(f + k(len - 20));
  for (let iters = Math.floor((len - 1) / 20), off = 0; iters > 0; iters--, off += 20) {
    const b0 = k(off), b1 = r32(s, off + 4), b2 = k(off + 8), b3 = k(off + 12), b4 = r32(s, off + 16);
    h = (Math.imul(rotr32((h ^ b0) >>> 0, 18), 5) + 0xe6546b64) >>> 0;
    f = Math.imul(rotr32((f + b1) >>> 0, 19), C1) >>> 0;
    g = (Math.imul(rotr32((g + b2) >>> 0, 18), 5) + 0xe6546b64) >>> 0;
    h = step((h ^ (b3 + b1)) >>> 0);
    g = Math.imul(bswap32((g ^ b4) >>> 0), 5) >>> 0;
    h = bswap32((h + Math.imul(b4, 5)) >>> 0);
    f = (f + b0) >>> 0;
    const t = h;
    h = f;
    f = g;
    g = t;
  }
  g = Math.imul(rotr32(Math.imul(rotr32(g, 11), C1) >>> 0, 17), C1) >>> 0;
  f = Math.imul(rotr32(Math.imul(rotr32(f, 11), C1) >>> 0, 17), C1) >>> 0;
  h = Math.imul(rotr32(step((h + g) >>> 0), 17), C1) >>> 0;
  h = step((h + f) >>> 0);
  return Math.imul(rotr32(h, 17), C1) >>> 0;
}

const K0 = 0xc3a5c85c97cb3127n, K1 = 0xb492b66fbe98f273n, K2 = 0x9ae16a3b2f90404fn;
const shiftmix = (v: bigint) => v ^ (v >> 47n);
const len16mul = (low: bigint, high: bigint, mul: bigint) => {
  let a = m64((low ^ high) * mul);
  a ^= a >> 47n;
  let b = m64((high ^ a) * mul);
  b ^= b >> 47n;
  return m64(b * mul);
};
const len16 = (u: bigint, v: bigint) => len16mul(u, v, 0x9ddfea08eb382d69n);
const weak = (s: Uint8Array, o: number, a: bigint, b: bigint): [bigint, bigint] => {
  const w = r64(s, o), x = r64(s, o + 8), y = r64(s, o + 16), z = r64(s, o + 24);
  a = m64(a + w);
  b = rotr64(m64(b + a + z), 21n);
  const c = a;
  a = m64(a + x + y);
  b = m64(b + rotr64(a, 44n));
  return [m64(a + z), m64(b + c)];
};

function city64(s: Uint8Array): bigint {
  const n = s.length, len = BigInt(n);
  if (n <= 16) {
    if (n >= 8) {
      const mul = m64(K2 + len * 2n);
      const a = m64(r64(s, 0) + K2), b = r64(s, n - 8);
      return len16mul(m64(rotr64(b, 37n) * mul + a), m64(m64(rotr64(a, 25n) + b) * mul), mul);
    }
    if (n >= 4) return len16mul(m64(len + (BigInt(r32(s, 0)) << 3n)), BigInt(r32(s, n - 4)), m64(K2 + len * 2n));
    if (n > 0) {
      const y = BigInt((s[0] + (s[n >> 1] << 8)) >>> 0), z = BigInt((n + (s[n - 1] << 2)) >>> 0);
      return m64(shiftmix(m64(y * K2) ^ m64(z * K0)) * K2);
    }
    return K2;
  }
  if (n <= 32) {
    const mul = m64(K2 + len * 2n);
    const a = m64(r64(s, 0) * K1), b = r64(s, 8), c = m64(r64(s, n - 8) * mul), d = m64(r64(s, n - 16) * K2);
    return len16mul(m64(rotr64(m64(a + b), 43n) + rotr64(c, 30n) + d), m64(a + rotr64(m64(b + K2), 18n) + c), mul);
  }
  if (n <= 64) {
    const mul = m64(K2 + len * 2n);
    const a = m64(r64(s, 0) * K2), b = r64(s, 8), c = r64(s, n - 24), d = r64(s, n - 32);
    const e = m64(r64(s, 16) * K2), f = m64(r64(s, 24) * 9n), g = r64(s, n - 8), h = m64(r64(s, n - 16) * mul);
    const u = m64(rotr64(m64(a + g), 43n) + m64(m64(rotr64(b, 30n) + c) * 9n));
    const v = m64((m64(a + g) ^ d) + f + 1n);
    const w = m64(bswap64(m64(m64(u + v) * mul)) + h);
    const x = m64(rotr64(m64(e + f), 42n) + c);
    const y = m64(m64(bswap64(m64(m64(v + w) * mul)) + g) * mul);
    const z = m64(e + f + c);
    const a1 = m64(bswap64(m64(m64(m64(x + z) * mul) + y)) + b);
    const b1 = m64(shiftmix(m64(m64(z + a1) * mul + d + h)) * mul);
    return m64(b1 + x);
  }
  let x = r64(s, n - 40);
  let y = m64(r64(s, n - 16) + r64(s, n - 56));
  let z = len16(m64(r64(s, n - 48) + len), r64(s, n - 24));
  let v = weak(s, n - 64, len, z);
  let w = weak(s, n - 32, m64(y + K1), x);
  x = m64(x * K1 + r64(s, 0));
  for (let off = 0, rem = (n - 1) & ~63; rem > 0; off += 64, rem -= 64) {
    x = m64(rotr64(m64(x + y + v[0] + r64(s, off + 8)), 37n) * K1);
    y = m64(rotr64(m64(y + v[1] + r64(s, off + 48)), 42n) * K1);
    x ^= w[1];
    y = m64(y + v[0] + r64(s, off + 40));
    z = m64(rotr64(m64(z + w[0]), 33n) * K1);
    v = weak(s, off, m64(v[1] * K1), m64(x + w[0]));
    w = weak(s, off + 32, m64(z + w[1]), m64(y + r64(s, off + 16)));
    [z, x] = [x, z];
  }
  return len16(m64(len16(v[0], w[0]) + m64(shiftmix(y) * K1) + z), m64(len16(v[1], w[1]) + x));
}

function cityHash64(data: Input, seed?: Seed): bigint {
  return len16(m64(city64(bytesOf(data)) - K2), seed64(seed));
}

// ---- xxHash3 (XXH3_64bits_withSeed: bun/src/jsc/bindings/xxhash3.cpp). Bun cuts the seed to 32 bits. ----
const XXH_SECRET = Uint8Array.from(
  (
    "b8fe6c3923a44bbe7c01812cf721ad1cded46de9839097db7240a4a4b7b3671fcb79e64eccc0e578825ad07dccff7221b8084674f743248ee03590e6813a264c" +
    "3c2852bb91c300cb88d0658b1b532ea371644897a20df94e3819ef46a9deacd8a8fa763fe39c343ff9dcbbc7c70b4f1d8a51e04bcdb45931c89f7ec9d9787364" +
    "eac5ac8334d3ebc3c581a0fffa1363eb170ddd51b7f0da49d316552629d4689e2b16be587d47a1fc8ff8b8d17ad031ce45cb3a8f95160428afd7fbcabb4b407e"
  )
    .match(/../g)!
    .map((h) => parseInt(h, 16)),
);
const XP32_1 = 0x9e3779b1n, XP32_2 = 0x85ebca77n, XP32_3 = 0xc2b2ae3dn;
const XP64_1 = 0x9e3779b185ebca87n, XP64_2 = 0xc2b2ae3d27d4eb4fn, XP64_3 = 0x165667b19e3779f9n, XP64_4 = 0x85ebca77c2b2ae63n, XP64_5 = 0x27d4eb2f165667c5n;
const MX1 = 0x165667919e3779f9n, MX2 = 0x9fb21c651e98df25n;
const fold = (a: bigint, b: bigint) => {
  const p = a * b;
  return (p & M64) ^ (p >> 64n);
};
const xxAval64 = (h: bigint) => {
  h ^= h >> 33n;
  h = m64(h * XP64_2);
  h ^= h >> 29n;
  h = m64(h * XP64_3);
  return h ^ (h >> 32n);
};
const xxAval = (h: bigint) => {
  h ^= h >> 37n;
  h = m64(h * MX1);
  return h ^ (h >> 32n);
};

function xxHash3(data: Input, seedIn?: Seed): bigint {
  const s = bytesOf(data);
  const n = s.length, len = BigInt(n);
  const sd = BigInt(seed32(seedIn));
  const sec = XXH_SECRET;
  const mix16 = (o: number, so: number) => fold(r64(s, o) ^ m64(r64(sec, so) + sd), r64(s, o + 8) ^ m64(r64(sec, so + 8) - sd));
  if (n <= 16) {
    if (n > 8) {
      const lo = r64(s, 0) ^ m64((r64(sec, 24) ^ r64(sec, 32)) + sd);
      const hi = r64(s, n - 8) ^ m64((r64(sec, 40) ^ r64(sec, 48)) - sd);
      return xxAval(m64(len + bswap64(lo) + hi + fold(lo, hi)));
    }
    if (n >= 4) {
      const seed = sd ^ (BigInt(bswap32(Number(sd))) << 32n);
      const bitflip = m64((r64(sec, 8) ^ r64(sec, 16)) - seed);
      let h = (BigInt(r32(s, n - 4)) + (BigInt(r32(s, 0)) << 32n)) ^ bitflip;
      h ^= rotl64(h, 49n) ^ rotl64(h, 24n);
      h = m64(h * MX2);
      h ^= (h >> 35n) + len;
      h = m64(h * MX2);
      return h ^ (h >> 28n);
    }
    if (n > 0) {
      const combined = BigInt(((s[0] << 16) | (s[n >> 1] << 24) | s[n - 1] | (n << 8)) >>> 0);
      return xxAval64(combined ^ m64(BigInt((r32(sec, 0) ^ r32(sec, 4)) >>> 0) + sd));
    }
    return xxAval64(sd ^ (r64(sec, 56) ^ r64(sec, 64)));
  }
  if (n <= 128) {
    let acc = m64(len * XP64_1);
    if (n > 32) {
      if (n > 64) {
        if (n > 96) acc += mix16(48, 96) + mix16(n - 64, 112);
        acc += mix16(32, 64) + mix16(n - 48, 80);
      }
      acc += mix16(16, 32) + mix16(n - 32, 48);
    }
    acc += mix16(0, 0) + mix16(n - 16, 16);
    return xxAval(m64(acc));
  }
  if (n <= 240) {
    let acc = m64(len * XP64_1);
    for (let i = 0; i < 8; i++) acc += mix16(16 * i, 16 * i);
    let end = mix16(n - 16, 136 - 17);
    acc = xxAval(m64(acc));
    for (let i = 8; i < Math.floor(n / 16); i++) end += mix16(16 * i, 16 * (i - 8) + 3);
    return xxAval(m64(acc + end));
  }
  let secret = sec;
  if (sd !== 0n) {
    secret = new Uint8Array(192);
    const dv = new DataView(secret.buffer);
    for (let i = 0; i < 12; i++) {
      dv.setBigUint64(16 * i, m64(r64(sec, 16 * i) + sd), true);
      dv.setBigUint64(16 * i + 8, m64(r64(sec, 16 * i + 8) - sd), true);
    }
  }
  const acc = [XP32_3, XP64_1, XP64_2, XP64_3, XP64_4, XP32_2, XP64_5, XP32_1];
  const accumulate = (o: number, so: number) => {
    for (let i = 0; i < 8; i++) {
      const d = r64(s, o + 8 * i);
      const dk = d ^ r64(secret, so + 8 * i);
      acc[i ^ 1] = m64(acc[i ^ 1] + d);
      acc[i] = m64(acc[i] + (dk & 0xffffffffn) * (dk >> 32n));
    }
  };
  const scramble = () => {
    for (let i = 0; i < 8; i++) {
      let a = acc[i];
      a ^= a >> 47n;
      a ^= r64(secret, 128 + 8 * i);
      acc[i] = m64(a * XP32_1);
    }
  };
  const perBlock = (192 - 64) / 8, blockLen = 64 * perBlock;
  const blocks = Math.floor((n - 1) / blockLen);
  for (let b = 0; b < blocks; b++) {
    for (let st = 0; st < perBlock; st++) accumulate(b * blockLen + st * 64, st * 8);
    scramble();
  }
  const stripes = Math.floor((n - 1 - blockLen * blocks) / 64);
  for (let st = 0; st < stripes; st++) accumulate(blocks * blockLen + st * 64, st * 8);
  accumulate(n - 64, 192 - 64 - 7);
  let r = m64(len * XP64_1);
  for (let i = 0; i < 4; i++) r += fold(acc[2 * i] ^ r64(secret, 11 + 16 * i), acc[2 * i + 1] ^ r64(secret, 11 + 16 * i + 8));
  return xxAval(m64(r));
}

// ---- rapidhash (bun/src/hash/rapidhash.rs) ----
const RS = [0x2d358dccaa6c78a5n, 0x8bb84b93962eacc9n, 0x4b33a62ed433d4a3n];

function rapidhash(data: Input, seedIn?: Seed): bigint {
  const input = bytesOf(data);
  const seed = seed64(seedIn);
  const len = input.length;
  let a = 0n, b = 0n, k = 0;
  const is = [seed, 0n, 0n];
  is[0] ^= mix(seed ^ RS[0], RS[1]) ^ BigInt(len);
  if (len <= 16) {
    if (len >= 4) {
      const d = (len & 24) >> (len >> 3), e = len - 4;
      a = (BigInt(r32(input, 0)) << 32n) | BigInt(r32(input, e));
      b = (BigInt(r32(input, d)) << 32n) | BigInt(r32(input, e - d));
    } else if (len > 0) a = (BigInt(input[0]) << 56n) | (BigInt(input[len >> 1]) << 32n) | BigInt(input[len - 1]);
  } else {
    let remain = len;
    if (len > 48) {
      is[1] = is[0];
      is[2] = is[0];
      while (remain >= 96) {
        for (let i = 0; i < 6; i++) is[i % 3] = mix(r64(input, k + 16 * i) ^ RS[i % 3], r64(input, k + 16 * i + 8) ^ is[i % 3]);
        k += 96;
        remain -= 96;
      }
      if (remain >= 48) {
        for (let i = 0; i < 3; i++) is[i] = mix(r64(input, k + 16 * i) ^ RS[i], r64(input, k + 16 * i + 8) ^ is[i]);
        k += 48;
        remain -= 48;
      }
      is[0] ^= is[1] ^ is[2];
    }
    if (remain > 16) {
      is[0] = mix(r64(input, k) ^ RS[2], r64(input, k + 8) ^ is[0] ^ RS[1]);
      if (remain > 32) is[0] = mix(r64(input, k + 16) ^ RS[2], r64(input, k + 24) ^ is[0]);
    }
    a = r64(input, len - 16);
    b = r64(input, len - 8);
  }
  a ^= RS[1];
  b ^= is[0];
  [a, b] = mum(a, b);
  return mix(a ^ RS[0] ^ BigInt(len), b ^ RS[1]);
}

export const hash = Object.assign((data: Input, seed?: Seed) => wyhash(data, seed), {
  wyhash,
  adler32,
  crc32: (data: Input, seed?: Seed) => (zlib.crc32 as (d: Input, v?: number) => number)(bytesOf(data), seed32(seed)),
  cityHash32,
  cityHash64,
  xxHash32,
  xxHash64,
  xxHash3,
  murmur32v2,
  murmur32v3,
  murmur64v2,
  rapidhash,
});
