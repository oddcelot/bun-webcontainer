// The module over a small Bun project (index.ts importing util.ts, @types/bun from node_modules): diagnostics and
// hovers, then 100 edits to index.ts as typing would make them, then a tsconfig change. Prints times and memory.
//   cargo build --release --target wasm32-wasip1 && node test.mjs [path/to/node_modules with @types/bun]
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync, readdirSync, statSync } from "node:fs";

const wasm = new URL("target/wasm32-wasip1/release/tsrs_ls_wasm.wasm", import.meta.url).pathname;
if (isMainThread) {
  const w = new Worker(new URL(import.meta.url), { workerData: process.argv[2] ?? "/tmp/tsrs-test/nm/node_modules", resourceLimits: { stackSizeMb: 256 } });
  w.on("message", (m) => console.log(m));
  w.on("error", (e) => { console.error(e); process.exitCode = 1; });
} else {
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({ version: "preview1", args: [], env: {}, returnOnExit: true });
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasm)), { wasi_snapshot_preview1: wasi.wasiImport });
  wasi.initialize(inst);
  const ex = inst.exports, enc = new TextEncoder(), dec = new TextDecoder();
  const call = (fn, parts) => {
    const bytes = enc.encode(parts.join("\0"));
    // ls_input may grow memory, which detaches the old buffer: take the pointer first.
    const ptr = ex.ls_input(bytes.length);
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    const t = performance.now();
    ex[fn]();
    const out = dec.decode(new Uint8Array(ex.memory.buffer, ex.ls_output(), ex.ls_output_len()));
    return { ms: Math.round(performance.now() - t), out };
  };
  const log = (label, r) => parentPort.postMessage(`${label}: ${r.ms}ms ${r.out.slice(0, 160)}`);
  const mib = () => `${ex.memory.buffer.byteLength >> 20} MiB`;

  const types = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = `${d}/${n}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.d\.[cm]?ts$|package\.json$/.test(p)) types.push(p.replace(workerData, "/node_modules"), readFileSync(p, "utf8"));
    }
  })(workerData);
  const config = '{"compilerOptions":{"strict":true,"module":"preserve","moduleResolution":"bundler","target":"esnext","types":["bun"],"skipLibCheck":true,"allowImportingTsExtensions":true,"noEmit":true}}';
  let index = 'import { greet } from "./util.ts";\nconst server = Bun.serve({ routes: { "/a/:name": (req) => Response.json(greet(req.params.name)) } });\nconst n: number = server.url;\n';
  const util = 'export function greet(name: string) {\n  return { message: `hi ${name}` };\n}\n';
  log("set files", call("ls_set_files", ["/tsconfig.json", config, "/index.ts", index, "/util.ts", util, ...types]));
  log("diagnostics (cold)", call("ls_diagnostics", ["/tsconfig.json", "/index.ts"]));
  log("hover req", call("ls_hover", ["/tsconfig.json", "/index.ts", "1", "45"]));
  log("hover greet", call("ls_hover", ["/tsconfig.json", "/index.ts", "1", "80"]));
  parentPort.postMessage(`memory after setup: ${mib()}`);

  let worst = 0, total = 0;
  for (let i = 0; i < 100; i++) {
    index += i % 10 === 9 ? "\n" : "x";
    call("ls_set_files", ["/index.ts", index]);
    const d = call("ls_diagnostics", ["/tsconfig.json", "/index.ts"]);
    const h = call("ls_hover", ["/tsconfig.json", "/index.ts", "1", "45"]);
    worst = Math.max(worst, d.ms + h.ms); total += d.ms + h.ms;
  }
  parentPort.postMessage(`100 edits: diagnostics+hover avg ${Math.round(total / 100)}ms, worst ${worst}ms, memory ${mib()}`);
  log("hover after edits", call("ls_hover", ["/tsconfig.json", "/index.ts", "1", "45"]));

  call("ls_set_files", ["/tsconfig.json", config.replace('"strict":true', '"strict":false')]);
  log("diagnostics after tsconfig change", call("ls_diagnostics", ["/tsconfig.json", "/index.ts"]));
  parentPort.postMessage(`memory at end: ${mib()}`);
}
