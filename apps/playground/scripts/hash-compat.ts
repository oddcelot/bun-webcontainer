// The playground's `Bun.hash` (src/worker/hash.ts) against native Bun's, over a corpus of inputs, seeds and input kinds.
// Run with bun: `bun scripts/hash-compat.ts`.
import { hash as shim } from "../src/worker/hash";

const native = Bun.hash as unknown as Record<string, (d: unknown, seed?: unknown) => number | bigint>;
const mine = shim as unknown as typeof native;
const names = Object.keys(native).filter((k) => typeof native[k] === "function");

const bytes = (n: number, mul = 31) => Uint8Array.from({ length: n }, (_, i) => (i * mul + (i >> 3) + 7) & 255);
const inputs: [string, unknown][] = [["empty string", ""], ["empty bytes", new Uint8Array(0)]];
for (let n = 1; n <= 300; n++) inputs.push([`${n} bytes`, bytes(n)]);
for (const n of [511, 512, 1000, 1024, 2047, 2048, 2049, 4096, 10007, 65536]) inputs.push([`${n} bytes`, bytes(n, 13)]);
inputs.push(
  ["ascii", "bun"],
  ["non-ascii", "héllo wörld, 日本語, 😀 ".repeat(7)],
  ["lone surrogate", "a\ud800b"],
  ["ArrayBuffer", bytes(77).buffer],
  ["SharedArrayBuffer", new Uint8Array(new SharedArrayBuffer(50)).fill(9).buffer],
  ["Uint16Array", new Uint16Array([1, 2, 3, 40000])],
  ["Float64Array", new Float64Array([1.5, -2])],
  ["DataView", new DataView(bytes(90).buffer, 5, 60)],
  ["subarray", bytes(100).subarray(3, 70)],
  ["number", 1234],
  ["object", {}],
);
const seeds: unknown[] = [
  undefined, 0, 1, 42, 1.5, -1, -5, -1.5, 0xffffffff, 4294967295.9, 2 ** 32, 2 ** 33 + 5, 2 ** 53, 2 ** 63, 2 ** 64, 1e20,
  NaN, Infinity, -Infinity, "x", null, 0n, 7n, -1n, 2n ** 32n + 9n, 2n ** 63n, 2n ** 64n - 1n, 2n ** 70n + 7n, -(2n ** 63n),
];
const show = (v: unknown) => (typeof v === "bigint" ? `${v}n` : String(v));
// Seeds are checked on a few sizes per size class; every length runs with the default seed and one seeded run.
const seedSizes = new Set([0, 1, 3, 4, 8, 9, 16, 17, 32, 33, 64, 65, 96, 97, 128, 129, 200, 240, 241, 300, 1024, 2049, 10007]);

let checks = 0;
const fails: string[] = [];
const same = (name: string, label: string, data: unknown, seed?: unknown, withSeed = false) => {
  checks++;
  const run = (f: typeof native) => {
    try {
      const v = withSeed ? f[name](data, seed) : f[name](data);
      return `${typeof v}:${v}`;
    } catch (e) {
      return `throw:${(e as Error).message}`;
    }
  };
  const want = run(native);
  const got = run(mine);
  if (want !== got && fails.length < 40) fails.push(`${name}(${label}${withSeed ? `, ${show(seed)}` : ""}): want ${want}, got ${got}`);
};

for (const name of names) {
  for (const [label, data] of inputs) {
    same(name, label, data);
    same(name, label, data, 0x9e3779b97f4a7c15n, true);
  }
  for (const [label, data] of inputs) {
    const len = (data as { length?: number; byteLength?: number }).byteLength ?? (data as { length?: number }).length;
    if (typeof data === "string" || typeof data === "object" ? seedSizes.has(len ?? -1) || typeof data === "string" : false) {
      for (const seed of seeds) same(name, label, data, seed, true);
    }
  }
  for (const bad of [undefined, null]) same(name, String(bad), bad);
}

console.log(`${names.length} functions (${names.join(", ")}), ${checks} comparisons`);
if (fails.length) {
  console.error(fails.join("\n"));
  process.exit(1);
}
console.log("Bun.hash matches native Bun");
