import { BASE } from "./base";

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  semver_order(ap: bigint, al: bigint, bp: bigint, bl: bigint): number;
  semver_satisfies(vp: bigint, vl: bigint, rp: bigint, rl: bigint): number;
};

export type Semver = {
  order(a: string, b: string): -1 | 0 | 1;
  satisfies(version: string, range: string): boolean;
};

export async function loadSemver(): Promise<Semver> {
  const module = await WebAssembly.compileStreaming(fetch(new URL(`${BASE}bun_semver_wasm.wasm`, location.href)));
  // Instantiated on first use: each instance is a wasm64 memory, of which a tab gets only about 60 (see resolver.ts).
  let instance: Exports | undefined;
  const enc = new TextEncoder();

  function withStr<T>(s: string, f: (ptr: bigint, len: bigint) => T): T {
    const w = (instance ??= new WebAssembly.Instance(module, {}).exports as unknown as Exports);
    const b = enc.encode(s);
    const len = BigInt(b.length);
    const ptr = w.alloc(len);
    new Uint8Array(w.memory.buffer, Number(ptr), b.length).set(b);
    try {
      return f(ptr, len);
    } finally {
      w.dealloc(ptr, len);
    }
  }

  return {
    order(a, b) {
      const r = withStr(a, (pa, la) => withStr(b, (pb, lb) => instance!.semver_order(pa, la, pb, lb)));
      if (r === 2) throw new TypeError(`invalid semver: ${a} / ${b}`);
      return r as -1 | 0 | 1;
    },
    satisfies(v, range) {
      const r = withStr(v, (pv, lv) => withStr(range, (pr, lr) => instance!.semver_satisfies(pv, lv, pr, lr)));
      if (r < 0) throw new Error("semver wasm allocation failure");
      return r === 1;
    },
  };
}
