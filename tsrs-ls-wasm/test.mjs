// Probe check: hovers through the module, then memory and time over 200 calls (each builds and leaks a Program).
// cargo build --release --target wasm32-wasip1 && node test.mjs
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
if (isMainThread) {
  const w = new Worker(new URL(import.meta.url), { workerData: process.argv[2] ?? new URL("target/wasm32-wasip1/release/tsrs_ls_wasm.wasm", import.meta.url).pathname, resourceLimits: { stackSizeMb: 256 } });
  w.on("message", (m) => console.log(m)); w.on("error", (e) => console.error("worker error", e));
} else {
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({ version: "preview1", args: [], env: {}, returnOnExit: true });
  const mod = await WebAssembly.compile(readFileSync(workerData));
  const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  wasi.initialize(inst);
  const ex = inst.exports, enc = new TextEncoder(), dec = new TextDecoder();
  const src = `interface Point { x: number; y: number }\nconst p: Point = { x: 1, y: 2 };\nconst total = [p.x, p.y].map((n) => n * 2);\n`;
  const files = { "/tsconfig.json": '{"compilerOptions":{"strict":true},"files":["index.ts"]}', "/index.ts": src };
  const hover = (line, character) => {
    const parts = ["/index.ts", String(line), String(character)];
    for (const [k, v] of Object.entries(files)) parts.push(k, v);
    const bytes = enc.encode(parts.join("\0"));
    const ptr = ex.ls_input(bytes.length);
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    const t = performance.now();
    ex.ls_hover();
    const out = dec.decode(new Uint8Array(ex.memory.buffer, ex.ls_output(), ex.ls_output_len()));
    return `${Math.round(performance.now() - t)}ms ${out}`;
  };
  parentPort.postMessage(hover(2, 30));  // n
  for (let i = 1; i <= 200; i++) { hover(2, 6); if (i % 50 === 0) parentPort.postMessage(`after ${i}: ${ex.memory.buffer.byteLength >> 20} MiB, last ${hover(2, 6).split(" ")[0]}`); }
}
