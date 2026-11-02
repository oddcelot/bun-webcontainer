// The module over a small Bun project (index.ts importing util.ts, @types/bun from node_modules): diagnostics,
// hovers, completions and signature help, then 100 edits to index.ts as typing would make them, then a tsconfig change. Prints times and memory.
//   cargo build --release --target wasm32-wasip1 && node test.mjs [node_modules with @types/bun; default: the playground's]
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

const wasm = new URL("target/wasm32-wasip1/release/tsrs_ls_wasm.wasm", import.meta.url).pathname;
if (isMainThread) {
  const w = new Worker(new URL(import.meta.url), { workerData: process.argv[2] ?? new URL("../../playground/node_modules", import.meta.url).pathname, resourceLimits: { stackSizeMb: 256 } });
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
  const walk = (d, as) => {
    for (const n of readdirSync(d)) {
      const p = `${d}/${n}`;
      if (statSync(p).isDirectory()) walk(p, `${as}/${n}`);
      else if (/\.d\.[cm]?ts$|package\.json$/.test(p)) types.push(`${as}/${n}`, readFileSync(p, "utf8"));
    }
  };
  // Each package is looked up from the one that depends on it, as Node would: with isolated installs only @types/bun
  // is linked into the playground's node_modules, the rest next to their dependents in node_modules/.bun.
  const find = (name, from) => {
    for (let d = from; d !== "/"; d = dirname(d)) {
      const p = `${d}${d.endsWith("/node_modules") ? "" : "/node_modules"}/${name}`;
      if (existsSync(p)) return realpathSync(p);
    }
    throw new Error(`${name} not found from ${from}`);
  };
  let from = workerData;
  for (const pkg of ["@types/bun", "bun-types", "@types/node", "undici-types"]) {
    const dir = find(pkg, from);
    walk(dir, `/node_modules/${pkg}`);
    from = dir;
  }
  const config = '{"compilerOptions":{"strict":true,"module":"preserve","moduleResolution":"bundler","target":"esnext","types":["bun"],"skipLibCheck":true,"allowImportingTsExtensions":true,"noEmit":true}}';
  let index = 'import { greet } from "./util.ts";\nconst server = Bun.serve({ routes: { "/a/:name": (req) => Response.json(greet(req.params.name)) } });\nconst n: number = server.url;\n';
  const util = 'export function greet(name: string) {\n  return { message: `hi ${name}` };\n}\n';
  log("set files", call("ls_set_files", ["/tsconfig.json", config, "/index.ts", index, "/util.ts", util, ...types]));
  log("diagnostics (cold)", call("ls_diagnostics", ["/tsconfig.json", "/index.ts"]));
  log("hover req", call("ls_hover", ["/tsconfig.json", "/index.ts", "1", "45"]));
  log("hover greet", call("ls_hover", ["/tsconfig.json", "/index.ts", "1", "80"]));
  // After `server.` on line 2: Server's members; then the first one with its type and docs.
  const done = call("ls_completion", ["/tsconfig.json", "/index.ts", "2", "25", "."]);
  const items = JSON.parse(done.out)?.items ?? [];
  parentPort.postMessage(`completion server.: ${done.ms}ms ${items.length} items: ${items.slice(0, 8).map((i) => i.label).join(", ")}`);
  const url = items.find((i) => i.label === "url");
  if (!url) throw new Error("no `url` among server's completions");
  log("completion resolve url", call("ls_completion_resolve", ["/tsconfig.json", JSON.stringify(url)]));
  const invoked = call("ls_completion", ["/tsconfig.json", "/index.ts", "2", "18", ""]);
  const global = JSON.parse(invoked.out)?.items ?? [];
  parentPort.postMessage(`completion invoked at an expression: ${invoked.ms}ms ${global.length} items, Bun ${global.some((i) => i.label === "Bun") ? "among them" : "MISSING"}`);
  // In an import's path: the project's files. Line 0 is `import { greet } from "./util.ts";`, so after `"./`.
  const paths = JSON.parse(call("ls_completion", ["/tsconfig.json", "/index.ts", "0", "25", "/"]).out)?.items ?? [];
  parentPort.postMessage(`completion in "./: ${paths.map((i) => i.label).join(", ") || "NONE"}`);
  // Inside `greet(` on line 1: greet's signature, its one parameter active.
  const at = index.split("\n")[1].indexOf("greet(") + 6;
  log("signature help greet(", call("ls_signature_help", ["/tsconfig.json", "/index.ts", "1", String(at), "(", "0"]));
  // Auto-imports: names exported by a module (/extra.ts) and a package (tiny-pkg) that /use.ts doesn't import yet.
  call("ls_set_files", [
    "/package.json", '{"dependencies":{"tiny-pkg":"1.0.0"},"devDependencies":{"@types/bun":"1.0.0"}}',
    "/node_modules/tiny-pkg/package.json", '{"name":"tiny-pkg","version":"1.0.0","types":"index.d.ts"}',
    "/node_modules/tiny-pkg/index.d.ts", "export declare function tinyThing(): void;\n",
    "/extra.ts", 'export function farewellMessage() { return "bye"; }\n',
    "/use.ts", "farew\ntinyT\n",
  ]);
  const autoImport = (line, character, label) => {
    const r = call("ls_completion", ["/tsconfig.json", "/use.ts", String(line), String(character), ""]);
    const item = (JSON.parse(r.out)?.items ?? []).find((i) => i.label === label);
    const resolved = item && JSON.parse(call("ls_completion_resolve", ["/tsconfig.json", JSON.stringify(item)]).out);
    parentPort.postMessage(`auto-import ${label}: ${r.ms}ms ${item ? "offered" : "MISSING"}; ${JSON.stringify(resolved?.additionalTextEdits?.map((e) => e.newText) ?? null)}`);
  };
  autoImport(0, 5, "farewellMessage");
  autoImport(1, 5, "tinyThing");
  // From Bun's and Node's built-in modules, declared with `declare module` in files @types/bun pulls in.
  call("ls_set_files", ["/use.ts", "farew\ntinyT\nDatab\nreadFileS\n"]);
  autoImport(2, 5, "Database");
  autoImport(3, 9, "readFileSync");
  call("ls_set_files", ["/extra.ts", 'export function farewellMessage() { return "bye"; }\nexport const farewellCount = 2;\n']);
  autoImport(0, 5, "farewellCount");
  parentPort.postMessage(`memory after setup: ${mib()}`);

  let worst = 0, total = 0;
  for (let i = 0; i < 100; i++) {
    index += i % 10 === 9 ? "\n" : "x";
    call("ls_set_files", ["/index.ts", index]);
    const d = call("ls_diagnostics", ["/tsconfig.json", "/index.ts"]);
    const h = call("ls_hover", ["/tsconfig.json", "/index.ts", "1", "45"]);
    // At a name, so auto-imports are asked for after every edit.
    const c = call("ls_completion", ["/tsconfig.json", "/index.ts", "2", "18", ""]);
    if (!c.out.includes('"farewellMessage"')) throw new Error(`edit ${i}: no auto-import in the completions`);
    worst = Math.max(worst, d.ms + h.ms + c.ms); total += d.ms + h.ms + c.ms;
  }
  parentPort.postMessage(`100 edits: diagnostics+hover+completion avg ${Math.round(total / 100)}ms, worst ${worst}ms, memory ${mib()}`);
  log("hover after edits", call("ls_hover", ["/tsconfig.json", "/index.ts", "1", "45"]));

  // A file outside the program changing (nothing imports it) once crashed Program::update_program.
  call("ls_set_files", ["/node_modules/tiny-pkg/unused.d.ts", "export declare const unused: 1;\n"]);
  log("diagnostics after a change outside the program", call("ls_diagnostics", ["/tsconfig.json", "/index.ts"]));

  call("ls_set_files", ["/tsconfig.json", config.replace('"strict":true', '"strict":false')]);
  log("diagnostics after tsconfig change", call("ls_diagnostics", ["/tsconfig.json", "/index.ts"]));
  parentPort.postMessage(`memory at end: ${mib()}`);
}
