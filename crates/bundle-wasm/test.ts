// Runs the bundle-wasm module against a playground-VFS fixture through the `bun_sys` host imports and,
// if `bun` is on PATH, compares the output with native `bun build` over the same fixture on disk.
// Run with node >= 24 (Memory64 + native .ts type stripping; bun lacks Memory64):  node test.ts
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import assert from "node:assert/strict";
import { VFS } from "../../packages/vfs/vfs.ts";
import { createSysImports } from "../../packages/vfs/sysHost.ts";

// No plugins here: `Bun.build`'s plugins are tested in the playground (apps/playground/scripts/build-plugins.ts).
const noPlugins = { any_matches: () => 0, resolve: () => 0n, load: () => 0n, take: () => {} };
const here = (p: string) => new URL(p, import.meta.url);
const mod = new WebAssembly.Module(readFileSync(here("../../target/wasm64-unknown-unknown/release/bun_bundle_wasm.wasm")));

const files = {
  "package.json": JSON.stringify({ name: "app" }),
  "src/index.ts": `import { greet, type Greeting } from "./greet";
import { sum } from "mathlib";
import def, { named } from "mathlib/extra";
const g: Greeting = greet("world");
console.log(g, sum(1, 2), def(3), named);
export const lazy = () => import("./lazy");
`,
  "src/greet.ts": `export interface Greeting { text: string }
export function greet(name: string): Greeting { return { text: "hello " + name }; }
export const unused = 42;
`,
  "src/lazy.ts": `import { greet } from "./greet";
export default greet("lazy").text;
`,
  "src/other.ts": `import { greet } from "./greet";
console.log("other", greet("o"));
`,
  "src/styles.css": "@import './base.css';\n.a { color: red; & .b { margin: 0 } }\n",
  "src/base.css": ".base { background: url(./pixel.png) }\n",
  "src/pixel.png": "PNGDATA",
  "src/data.json": '{"x":1,"y":[1,2]}',
  "src/note.txt": "hello",
  "src/assets.ts": "import d from './data.json'; import './styles.css'; import txt from './note.txt' with { type: 'text' }; console.log(d, txt);",
  "src/index.html": '<html><head><link rel="stylesheet" href="./styles.css"></head><body><script type="module" src="./greet-main.ts"></script></body></html>',
  "src/greet-main.ts": "import { greet } from './greet'; console.log(greet('html'));",
  ".env": "FROM_DOTENV=dot\n",
  "src/env.ts": "console.log(process.env.PUBLIC_A, process.env.PUBLIC_B, process.env.SECRET_C, process.env.MISSING, process.env.FROM_DOTENV);\n",
  "src/drop.ts": "debugger;\nconsole.log('a');\nconsole.error('b');\nconst r = console.warn('c');\nfunction f() { debugger; return Math.random(); }\nexport { r, f };\nassert.strictEqual(1, 1);\n",
  "src/loader.ts": "import a from './note.custom'; import b from './data.weird'; import c from './pic.bin'; import d from './more.cfg';\nconsole.log(a, b, c, d);\n",
  "src/note.custom": "hello custom\n",
  "src/data.weird": '{"a": [1, 2]}',
  "src/pic.bin": "BINARY",
  "src/more.cfg": 'k = "v"\n',
  "src/pkgs.ts": "import { sum } from 'mathlib';\nimport { greet } from './greet';\nconsole.log(sum(1, 2), greet('p'));\n",
  "src/a/x.ts": "import { greet } from '../greet';\nconsole.log('x', greet('x'));\n",
  "src/b/y.ts": "console.log('y');\n",
  "node_modules/mathlib/package.json": JSON.stringify({
    name: "mathlib",
    version: "1.0.0",
    exports: { ".": { browser: "./browser.js", import: "./esm.js", default: "./cjs.js" }, "./extra": "./extra.js" },
  }),
  "node_modules/mathlib/browser.js": `export function sum(a, b) { return a + b; }\nexport function unusedExport() { return "dead"; }\n`,
  "node_modules/mathlib/esm.js": `export function sum() { return "wrong: esm"; }\n`,
  "node_modules/mathlib/cjs.js": `exports.sum = () => "wrong: cjs";\n`,
  "node_modules/mathlib/extra.js": `export default function twice(x) { return x * 2; }\nexport const named = "n";\n`,
};
const vfs = new VFS();
for (const [p, c] of Object.entries(files)) vfs.write(p, c);

// A panic aborts (the instance is unusable afterwards), so every bundle gets a fresh instance.
type Wasm = { memory: WebAssembly.Memory; [fn: string]: any };
let w: Wasm;
function fresh() {
  let memory: WebAssembly.Memory;
  w = new WebAssembly.Instance(mod, { ...createSysImports(vfs, () => memory), bun_plugin: noPlugins }).exports as Wasm;
  memory = w.memory;
}
const enc = new TextEncoder();
const dec = new TextDecoder();

function wasmBundle(config: Record<string, unknown>) {
  fresh();
  const b = enc.encode(JSON.stringify({ cwd: "/", ...config }));
  const p = w.alloc(BigInt(b.length));
  new Uint8Array(w.memory.buffer, Number(p), b.length).set(b);
  let out;
  try {
    out = w.bundle_c(p, BigInt(b.length));
  } catch (e) {
    const m = w.panic_message_c();
    const [, mp, ml] = new BigUint64Array(w.memory.buffer, Number(m), 3);
    throw new Error(`bundle_c trapped (${(e as Error).message}): ${dec.decode(new Uint8Array(w.memory.buffer, Number(mp), Number(ml)))}`, { cause: e });
  }
  w.dealloc(p, BigInt(b.length));
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out);
  assert.equal(status, 0n, text);
  return JSON.parse(text);
}

let failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); console.log("ok  ", name); } catch (e) { failed++; console.log("FAIL", name, "\n", (e as Error).stack ?? e); }
};

// --- native comparison -------------------------------------------------------------------------
const hasBun = spawnSync("bun", ["--version"]).status === 0;
let disk = "";
if (hasBun) {
  disk = mkdtempSync(join(tmpdir(), "bundle-wasm-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(disk, p)), { recursive: true });
    writeFileSync(join(disk, p), c);
  }
}
function native(args: string[]) {
  const r = spawnSync("bun", ["build", ...args], { cwd: disk, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();

test("single entry, esm, browser: output runs through wasm bundler", () => {
  const r = wasmBundle({ entryPoints: ["src/index.ts"], target: "browser", format: "esm" });
  assert.ok(r.success, JSON.stringify(r.logs));
  assert.equal(r.outputs.length, 1);
  const out = r.outputs[0].contents;
  assert.match(out, /hello /);
  assert.match(out, /function sum\(/);
  assert.doesNotMatch(out, /wrong/); // package.json "exports" browser condition picked
  assert.doesNotMatch(out, /dead/); // tree-shaken
  assert.doesNotMatch(out, /interface Greeting/);
});

if (hasBun) {
  for (const [name, config, flags] of [
    ["esm browser", {}, []],
    ["minify", { minify: true }, ["--minify"]],
    ["minify whitespace only", { minify: { whitespace: true } }, ["--minify-whitespace"]],
    ["iife", { format: "iife" }, ["--format=iife"]],
    ["cjs", { format: "cjs" }, ["--format=cjs"]],
    ["external", { external: ["mathlib"] }, ["--external=mathlib"]],
  ] as [string, Record<string, unknown>, string[]][]) {
    test(`vs native bun build: ${name}`, () => {
      const r = wasmBundle({ entryPoints: ["src/index.ts"], target: "browser", format: "esm", ...config });
      assert.ok(r.success, JSON.stringify(r.logs));
      const n = native(["src/index.ts", "--target=browser", ...(flags.some((f) => f.startsWith("--format")) ? [] : ["--format=esm"]), ...flags]);
      assert.equal(norm(r.outputs[0].contents), norm(n));
    });
  }
}

test("multiple entry points + code splitting", () => {
  const r = wasmBundle({ entryPoints: ["src/index.ts", "src/other.ts"], outdir: "out", splitting: true, format: "esm" });
  assert.ok(r.success, JSON.stringify(r.logs));
  const paths = r.outputs.map((o: { path: string }) => o.path).sort();
  console.log("     outputs:", paths.join(" "));
  assert.ok(r.outputs.length >= 3, "entries + shared chunk(s)");
  if (hasBun) {
    const outdir = join(disk, "out");
    const n = spawnSync("bun", ["build", "src/index.ts", "src/other.ts", "--outdir=out", "--splitting", "--target=browser", "--format=esm"], { cwd: disk, encoding: "utf8" });
    assert.equal(n.status, 0, n.stderr);
    for (const o of r.outputs) {
      const native = readFileSync(join(outdir, o.path), "utf8");
      assert.equal(norm(o.contents), norm(native), o.path);
    }
  }
});

// Same bundle through native `bun build --outdir`, compared file by file (hashes in names are content hashes).
function compareOutdir(name: string, entries: string[], config: Record<string, unknown>, flags: string[] = []) {
  test(`${name}: wasm == native bun build`, () => {
    const r = wasmBundle({ entryPoints: entries, outdir: "out", format: "esm", target: "browser", ...config });
    assert.ok(r.success, JSON.stringify(r.logs));
    if (!hasBun) return;
    rmSync(join(disk, "out"), { recursive: true, force: true });
    const n = spawnSync("bun", ["build", ...entries, "--outdir=out", "--target=browser", "--format=esm", ...flags], { cwd: disk, encoding: "utf8" });
    assert.equal(n.status, 0, n.stderr);
    for (const o of r.outputs) assert.equal(norm(o.contents), norm(readFileSync(join(disk, "out", o.path), "utf8")), o.path);
    console.log("     outputs:", r.outputs.map((o: { path: string }) => o.path).join(" "));
  });
}
compareOutdir("css entry", ["src/styles.css"], {});
compareOutdir("json/text/css imports from ts", ["src/assets.ts"], {});
compareOutdir("html entry", ["src/index.html"], {});
compareOutdir("html entry, minified", ["src/index.html"], { minify: true }, ["--minify"]);

// Options beyond the basics: each against native `bun build` over the same files (env: native sees the same variables).
const ENV = { PUBLIC_A: "pa", PUBLIC_B: "p\"b'\\", SECRET_C: "shh" };
function compareOptions(name: string, entries: string[], config: Record<string, unknown>, flags: string[], env: Record<string, string> = {}) {
  test(`${name}: wasm == native bun build`, () => {
    const r = wasmBundle({ entryPoints: entries, outdir: "out", format: "esm", target: "browser", envVars: env, ...config });
    assert.ok(r.success, JSON.stringify(r.logs));
    if (!hasBun) return;
    rmSync(join(disk, "out"), { recursive: true, force: true });
    const n = spawnSync("bun", ["build", ...entries, "--outdir=out", "--target=browser", "--format=esm", ...flags], { cwd: disk, encoding: "utf8", env: { PATH: process.env.PATH!, ...env } });
    assert.equal(n.status, 0, n.stderr);
    assert.equal(r.outputs.length, readdirSync(join(disk, "out"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length, "output count");
    for (const o of r.outputs) assert.equal(norm(o.contents), norm(readFileSync(join(disk, "out", o.path), "utf8")), o.path);
  });
}
compareOptions("env unset (nothing inlined)", ["src/env.ts"], {}, [], ENV);
compareOptions("env inline", ["src/env.ts"], { env: "inline" }, ["--env=inline"], ENV);
compareOptions("env PUBLIC_*", ["src/env.ts"], { env: "PUBLIC_*" }, ["--env=PUBLIC_*"], ENV);
compareOptions("env disable (CLI: loaded, not inlined)", ["src/env.ts"], { env: "load-only" }, ["--env=disable"], ENV);
compareOptions("drop console + debugger", ["src/drop.ts"], { drop: ["console", "debugger"] }, ["--drop=console", "--drop=debugger"]);
compareOptions("drop console, minified", ["src/drop.ts"], { drop: ["console"], minify: true }, ["--drop=console", "--minify"]);
compareOptions("drop assert", ["src/drop.ts"], { drop: ["assert"] }, ["--drop=assert"]);
compareOptions("loader", ["src/loader.ts"], { loader: { ".custom": "text", ".weird": "json", ".bin": "file", ".cfg": "toml" } }, ["--loader=.custom:text", "--loader=.weird:json", "--loader=.bin:file", "--loader=.cfg:toml"]);
compareOptions("loader: dataurl and base64", ["src/loader.ts"], { loader: { ".custom": "dataurl", ".weird": "text", ".bin": "base64", ".cfg": "text" } }, ["--loader=.custom:dataurl", "--loader=.weird:text", "--loader=.bin:base64", "--loader=.cfg:text"]);
compareOptions("packages: bundle (default)", ["src/pkgs.ts"], {}, []);
compareOptions("packages: external", ["src/pkgs.ts"], { packages: "external" }, ["--packages=external"]);
compareOptions("root: default (common dir)", ["src/a/x.ts", "src/b/y.ts"], {}, []);
compareOptions("root: src", ["src/a/x.ts", "src/b/y.ts"], { rootDir: "/src" }, ["--root=src"]);
compareOptions("root: project root", ["src/a/x.ts", "src/b/y.ts"], { rootDir: "/" }, ["--root=."]);

test("write: true writes into the VFS and returns no contents", () => {
  const r = wasmBundle({ entryPoints: ["src/greet.ts"], outdir: "/wrote", write: true });
  assert.ok(r.success, JSON.stringify(r.logs));
  assert.equal(r.outputs[0].value, "saved");
  assert.match(vfs.readText("wrote/greet.js")!, /hello /);
});

test("missing import reports a log error", () => {
  vfs.write("src/bad.ts", `import "./nope";\n`);
  const r = wasmBundle({ entryPoints: ["src/bad.ts"] });
  assert.equal(r.success, false);
  assert.ok(r.logs.some((l: { level: string; message: string }) => l.level === "error" && /nope/.test(l.message)), JSON.stringify(r.logs));
});

test("inline sourcemap", () => {
  const r = wasmBundle({ entryPoints: ["src/greet.ts"], sourcemap: "inline" });
  assert.ok(r.success, JSON.stringify(r.logs));
  assert.match(r.outputs[0].contents, /sourceMappingURL=data:application\/json;base64,/);
});

test("binary assets come back as base64 bytes", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28]);
  vfs.write("src/logo.png", png);
  vfs.write("src/img.ts", `import logo from "./logo.png";\nconsole.log(logo);\n`);
  const r = wasmBundle({ entryPoints: ["src/img.ts"], outdir: "/out" });
  assert.ok(r.success, JSON.stringify(r.logs));
  const asset = r.outputs.find((o: { path: string }) => o.path.endsWith(".png"));
  assert.ok(asset, JSON.stringify(r.outputs.map((o: { path: string }) => o.path)));
  assert.equal(asset.encoding, "base64");
  assert.deepEqual(new Uint8Array(Buffer.from(asset.contents, "base64")), png);
  assert.equal(r.outputs.find((o: { path: string }) => o.path.endsWith(".js")).encoding, undefined);
});

if (disk) rmSync(disk, { recursive: true, force: true });
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("all passed");
