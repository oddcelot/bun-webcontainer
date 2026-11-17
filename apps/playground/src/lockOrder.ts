// The order native Bun writes bun.lock's "trustedDependencies" and "patchedDependencies" in.
// Bun collects them in a Zig-style hash map keyed by u64 and writes its values in slot order
// (install/lockfile/bun.lock.rs:140-160 WrittenOrderContext, :285-300 and :480-535), so the
// order is a function of the keys, the reserved count and the insertion order. Ported here:
// the wyhash variants (wyhash/lib.rs) and std.HashMapUnmanaged (collections/zig_hash_map.rs).

const M = (1n << 64n) - 1n;
const P = [0xa0761d6478bd642fn, 0xe7037ed1a0b428dbn, 0x8ebc6af09c88c6e3n, 0x589965cc75374cc3n, 0x1d8e4e27c47d124fn];

// 64x64 -> 128 multiply folded: (r >> 64) ^ r (wyhash/lib.rs:66 mum)
const mum = (a: bigint, b: bigint): bigint => {
  const r = (a & M) * (b & M);
  return ((r >> 64n) ^ r) & M;
};

// Wyhash11 with seed 0, which is `semver::string::Builder::string_hash` (semver/lib.rs:840);
// wyhash/lib.rs:100-315 and :321-370. Bun's hash of a package name, or of "name@version".
export function stringHash(s: string): bigint {
  const b = new TextEncoder().encode(s);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const r8 = (o: number) => dv.getBigUint64(o, true);
  const r4 = (o: number) => BigInt(dv.getUint32(o, true));
  const r2 = (o: number) => BigInt(dv.getUint16(o, true));
  const r1 = (o: number) => BigInt(b[o]);
  const r8s = (o: number) => (r4(o) << 32n) | r4(o + 4); // read_8bytes_swapped
  const mix0 = (a: bigint, c: bigint, s: bigint) => mum(a ^ s ^ P[0], c ^ s ^ P[1]);
  const mix1 = (a: bigint, c: bigint, s: bigint) => mum(a ^ s ^ P[2], c ^ s ^ P[3]);
  // k (1..8) bytes at t, packed the way the reference's length switch does
  const pk = (t: number, k: number): bigint =>
    k === 1
      ? r1(t)
      : k === 2
        ? r2(t)
        : k === 3
          ? (r2(t) << 8n) | r1(t + 2)
          : k === 4
            ? r4(t)
            : k === 5
              ? (r4(t) << 8n) | r1(t + 4)
              : k === 6
                ? (r4(t) << 16n) | r2(t + 4)
                : k === 7
                  ? (r4(t) << 24n) | (r2(t + 4) << 8n) | r1(t + 6)
                  : r8s(t);
  // the two operands for a 1..16 byte remainder at t
  const pair = (t: number, k: number): [bigint, bigint] => (k <= 8 ? [pk(t, k), P[4]] : [r8s(t), pk(t + 8, k - 8)]);

  const aligned = b.length - (b.length % 32);
  let seed = 0n;
  for (let o = 0; o < aligned; o += 32) {
    seed = mix0(r8(o), r8(o + 8), seed) ^ mix1(r8(o + 16), r8(o + 24), seed);
  }
  const n = b.length - aligned;
  if (n > 16) {
    // final_long: head ^ tail
    seed = mix0(r8s(aligned), r8s(aligned + 8), seed) ^ mix1(...pair(aligned + 16, n - 16), seed);
  } else if (n > 0) {
    seed = mix0(...pair(aligned, n), seed);
  }
  return mum(seed ^ BigInt(b.length), P[4]);
}

// The "final4" Wyhash (seed 0) of the 8 little-endian bytes of a u64: `bun_wyhash::hash(&key.to_le_bytes())`,
// only its 8-byte `small_key` path (wyhash/lib.rs:398-720).
function slotHash(key: bigint): bigint {
  const lo = key & 0xffffffffn;
  const hi = (key >> 32n) & 0xffffffffn;
  const s0 = mum(P[0], P[1]); // seed ^ mix(seed ^ SECRET[0], SECRET[1]), seed 0
  const a = (lo << 32n) | hi; // read4(0) << 32 | read4(4)
  const b = (hi << 32n) | lo; // read4(4) << 32 | read4(0)
  // final2: a ^= SECRET[1]; b ^= state[0]; mum_; mix(a ^ SECRET[0] ^ len, b ^ SECRET[1])
  const x = (a ^ P[1]) * (b ^ s0);
  return mum((x & M) ^ P[0] ^ 8n, (x >> 64n) ^ P[1]);
}

// A port of collections/zig_hash_map.rs, only what decides iteration order: capacity (`reserve`,
// growth at 80% load, power of two, min 8), slot index (low hash bits), linear probing, and the
// rehash in old-slot order on growth.
class SlotMap<T> {
  keys: (bigint | null)[] = [];
  vals: T[] = [];
  size = 0;
  available = 0;

  // zig_hash_map.rs:54 capacity_for_size
  private static capFor(n: number): number {
    const c = Math.floor((n * 100) / 80) + 1;
    let p = 1;
    while (p < c) p *= 2;
    return p;
  }
  private load() {
    return Math.floor((this.keys.length * 80) / 100) - this.available;
  }
  private growIfNeeded(n: number) {
    if (n > this.available) this.grow(Math.max(SlotMap.capFor(this.load() + n), 8));
  }
  private grow(cap: number) {
    const { keys, vals } = this;
    this.keys = new Array(cap).fill(null);
    this.vals = new Array(cap);
    this.available = Math.floor((cap * 80) / 100);
    this.size = 0;
    for (let i = 0; i < keys.length; i++) if (keys[i] !== null) this.place(keys[i]!, vals[i]);
  }
  private place(k: bigint, v: T) {
    const mask = this.keys.length - 1;
    let i = Number(slotHash(k) & BigInt(mask));
    while (this.keys[i] !== null) i = (i + 1) & mask;
    this.keys[i] = k;
    this.vals[i] = v;
    this.available--;
    this.size++;
  }
  // `reserve(n)` on a map that is still empty
  reserve(n: number) {
    if (n > this.size) this.growIfNeeded(n - this.size);
  }
  // `insert`: an existing key keeps its slot and takes the new value (zig_hash_map.rs:437)
  insert(k: bigint, v: T) {
    this.growIfNeeded(1);
    const mask = this.keys.length - 1;
    let i = Number(slotHash(k) & BigInt(mask));
    while (this.keys[i] !== null) {
      if (this.keys[i] === k) {
        this.vals[i] = v;
        return;
      }
      i = (i + 1) & mask;
    }
    this.place(k, v);
  }
  values(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] !== null) out.push(this.vals[i]);
    return out;
  }
}

// `items` in the order Bun inserts them (key: the string it string_hashes), `reserved` the entry count of
// package.json's trustedDependencies / the patchedDependencies (can exceed the items found); returns the
// values in the order Bun writes them. A repeated key keeps its first slot and takes the later value.
export function writtenOrder<T>(items: { key: string; value: T }[], reserved: number): T[] {
  const m = new SlotMap<T>();
  m.reserve(reserved);
  for (const it of items) m.insert(stringHash(it.key), it.value);
  return m.values();
}
