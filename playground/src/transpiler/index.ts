// Bun's own transpiler (bun_js_parser + bun_js_printer) compiled to wasm64; see ../../../transpile-wasm.
// Output matches `bun build --no-bundle --target=browser`.

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  transpile_c(pathPtr: bigint, pathLen: bigint, srcPtr: bigint, srcLen: bigint, loader: number): bigint;
  output_free(out: bigint): void;
};

const LOADERS: Record<string, number> = { js: 0, mjs: 0, jsx: 1, ts: 2, mts: 2, tsx: 3 };

let ready: Promise<Exports> | undefined;

async function load(): Promise<Exports> {
  const res = await fetch("/bun_transpile_wasm.wasm");
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
  return instance.exports as unknown as Exports;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function transpile(source: string, path: string): Promise<string> {
  const w = await (ready ??= load());
  const put = (s: string): [bigint, bigint] => {
    const b = enc.encode(s);
    const len = BigInt(b.length);
    const ptr = w.alloc(len);
    new Uint8Array(w.memory.buffer, Number(ptr), b.length).set(b);
    return [ptr, len];
  };
  const [pp, pl] = put(path);
  const [sp, sl] = put(source);
  const out = w.transpile_c(pp, pl, sp, sl, LOADERS[path.slice(path.lastIndexOf(".") + 1)] ?? 0);
  try {
    const view = new DataView(w.memory.buffer);
    const at = Number(out);
    const status = view.getBigUint64(at, true);
    const ptr = Number(view.getBigUint64(at + 8, true));
    const len = Number(view.getBigUint64(at + 16, true));
    const text = dec.decode(new Uint8Array(w.memory.buffer, ptr, len));
    if (status !== 0n) throw new Error(text.trim() || "transpile failed");
    return text;
  } finally {
    w.output_free(out);
    w.dealloc(pp, pl);
    w.dealloc(sp, sl);
  }
}
