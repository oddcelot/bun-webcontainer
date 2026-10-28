// Runs the resolve-wasm module against a playground-VFS fixture through the `bun_sys` host imports,
// and compares with the playground's JS resolver (moduleServer.ts) and, if `bun` is on PATH, with
// real Bun (`Bun.resolveSync` over the same fixture written to disk).
// Run with node >= 24 (Memory64 + native .ts type stripping; bun lacks Memory64):  node test.mjs
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname as pdirname } from "node:path";
import assert from "node:assert/strict";
import { VFS } from "../playground/src/vfs.ts";
import { createSysImports } from "../playground/src/worker/sysHost.ts";

const here = (p) => new URL(p, import.meta.url);
const mod = new WebAssembly.Module(readFileSync(here("./target/wasm64-unknown-unknown/release/bun_resolve_wasm.wasm")));

const files = {
  "package.json": JSON.stringify({ name: "app", imports: { "#internal": "./src/internal.ts", "#utils/*": "./src/utils/*.ts", "#dep": "pkgmain" } }),
  "tsconfig.json": `{
    // comments are fine
    "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"], "~lib": ["src/lib/index.ts"] }, },
  }`,
  "src/a.ts": "export const a = 1",
  "src/b.js": "",
  "src/c.tsx": "",
  "src/c.js": "",
  "src/internal.ts": "",
  "src/utils/fmt.ts": "",
  "src/lib/index.ts": "",
  "src/dir/index.ts": "",
  "src/sub/deep/x.ts": "",
  "node_modules/pkgmain/package.json": JSON.stringify({ name: "pkgmain", main: "lib/entry.js" }),
  "node_modules/pkgmain/lib/entry.js": "",
  "node_modules/pkgmod/package.json": JSON.stringify({ name: "pkgmod", main: "main.js", module: "esm.js" }),
  "node_modules/pkgmod/main.js": "",
  "node_modules/pkgmod/esm.js": "",
  "node_modules/pkgcond/package.json": JSON.stringify({
    name: "pkgcond",
    exports: {
      ".": { browser: "./b.js", import: "./i.mjs", require: "./r.cjs", default: "./d.js" },
      "./sub": "./sub.js",
      "./feat/*": "./features/*.js",
      "./package.json": "./package.json",
    },
  }),
  "node_modules/pkgcond/b.js": "",
  "node_modules/pkgcond/i.mjs": "",
  "node_modules/pkgcond/r.cjs": "",
  "node_modules/pkgcond/d.js": "",
  "node_modules/pkgcond/sub.js": "",
  "node_modules/pkgcond/features/one.js": "",
  "node_modules/pkgcond/hidden.js": "",
  "node_modules/pkgdual/package.json": JSON.stringify({ name: "pkgdual", exports: { ".": { import: "./i.mjs", require: "./r.cjs" } } }),
  "node_modules/pkgdual/i.mjs": "",
  "node_modules/pkgdual/r.cjs": "",
  "node_modules/pkgcustom/package.json": JSON.stringify({ name: "pkgcustom", exports: { ".": { custom: "./custom.js", default: "./d.js" } } }),
  "node_modules/pkgcustom/custom.js": "",
  "node_modules/pkgcustom/d.js": "",
  "node_modules/@scope/pkg/package.json": JSON.stringify({ name: "@scope/pkg", main: "main.js" }),
  "node_modules/@scope/pkg/main.js": "",
  "node_modules/@scope/ex/package.json": JSON.stringify({ name: "@scope/ex", exports: { ".": "./index.js", "./util": "./util/u.js" } }),
  "node_modules/@scope/ex/index.js": "",
  "node_modules/@scope/ex/util/u.js": "",
  "node_modules/noindex/index.js": "",
  "node_modules/noindex/package.json": JSON.stringify({ name: "noindex" }),
  "src/sub/node_modules/nested/package.json": JSON.stringify({ name: "nested", main: "n.js" }),
  "src/sub/node_modules/nested/n.js": "",
};
const vfs = new VFS();
for (const [p, c] of Object.entries(files)) vfs.write(p, c);

let memory;
const w = new WebAssembly.Instance(mod, createSysImports(vfs, () => memory)).exports;
memory = w.memory;
const enc = new TextEncoder();
const dec = new TextDecoder();
function put(s) {
  const b = enc.encode(s);
  const p = w.alloc(BigInt(b.length));
  new Uint8Array(w.memory.buffer, Number(p), b.length).set(b);
  return [p, BigInt(b.length)];
}
const KIND = { import: 2, require: 3, dynamic: 4 };
const TARGET = { browser: 0, bun: 1, node: 2 };
/** -> {ok: "/abs/path"} | {err: "text"} */
function wasmResolve(spec, dir, { kind = "import", target = "browser", conds = "" } = {}) {
  const a = put(spec), b = put(dir), c = put(conds);
  let out;
  try {
    out = w.resolve_c(a[0], a[1], b[0], b[1], KIND[kind], TARGET[target], c[0], c[1]);
  } catch (e) {
    // panic=abort traps; the module keeps the panic message for the host.
    const m = w.panic_message_c();
    const [, mp, ml] = new BigUint64Array(w.memory.buffer, Number(m), 3);
    throw new Error(`resolve_c(${spec}, ${dir}) trapped: ${dec.decode(new Uint8Array(w.memory.buffer, Number(mp), Number(ml)))}`, { cause: e });
  }
  for (const [p, l] of [a, b, c]) w.dealloc(p, l);
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out);
  return status === 0n ? { ok: text } : { err: text };
}

// The playground's JS resolver, sliced out of moduleServer.ts (it has Vite-only imports, so it can't be imported).
const src = readFileSync(here("../playground/src/moduleServer.ts"), "utf8");
const slice = src.slice(src.indexOf("const EXTS"), src.indexOf("let warned"));
const js = stripTypeScriptTypes(
  `import { dirname, norm } from ${JSON.stringify(here("../playground/src/vfs.ts").href)};
${slice}
export const setConditions = (c) => { CONDITIONS = TARGET_CONDITIONS[c]; };
export function resolve(vfs, spec, dir) {
  if (spec.startsWith(".")) return resolveFile(vfs, norm(\`\${dir}/\${spec}\`));
  if (spec.startsWith("/")) return resolveFile(vfs, norm(spec));
  if (spec.startsWith("#")) return resolveImports(vfs, spec, dir);
  return resolveBare(vfs, spec, dir);
}`,
);
const tmp = mkdtempSync(join(tmpdir(), "resolve-wasm-"));
const jsPath = join(tmp, "js-resolver.mjs");
writeFileSync(jsPath, js);
const jsr = await import(jsPath);
function jsResolve(spec, dir, target) {
  jsr.setConditions(target === "bun" ? "bun" : "browser");
  const r = jsr.resolve(vfs, spec, dir.replace(/^\//, ""));
  return r === null ? { err: "null" } : { ok: "/" + r };
}

// Real Bun over the same fixture on disk.
const disk = join(tmp, "fx");
for (const [p, c] of Object.entries(files)) {
  mkdirSync(pdirname(join(disk, p)), { recursive: true });
  writeFileSync(join(disk, p), c);
}
const hasBun = spawnSync("bun", ["--version"]).status === 0;
function bunResolve(spec, dir) {
  const r = spawnSync("bun", ["-e", `try{console.log(Bun.resolveSync(process.argv[1],process.argv[2]))}catch(e){console.log("ERR "+e.message)}`, spec, join(disk, dir)], { encoding: "utf8" });
  const o = r.stdout.trim();
  // macOS tmp is a symlink; Bun reports the real path.
  return o.startsWith("ERR") ? { err: o } : { ok: o.slice(o.indexOf("/fx/") + 3) };
}

// [spec, dir, wasm options, expected path (null = not found), compare with JS resolver?, compare with Bun?]
const cases = [
  ["./a", "/src", {}, "/src/a.ts", 1, 1],
  ["./a.ts", "/src", {}, "/src/a.ts", 1, 1],
  ["./b", "/src", {}, "/src/b.js", 1, 1],
  ["./c", "/src", {}, "/src/c.tsx", 1, 1], // .tsx before .js in Bun's order; the JS resolver tries .ts, .tsx, .js
  ["./dir", "/src", {}, "/src/dir/index.ts", 1, 1],
  ["../a", "/src/dir", {}, "/src/a.ts", 1, 1],
  ["/src/a", "/anywhere", {}, "/src/a.ts", 1, 0], // absolute: the Bun comparison would need the fixture at /
  ["pkgmain", "/src", {}, "/node_modules/pkgmain/lib/entry.js", 1, 1],
  ["pkgmod", "/src", { target: "browser" }, "/node_modules/pkgmod/esm.js", 1, 0], // browser target prefers "module"
  ["pkgmod", "/src", { target: "node" }, "/node_modules/pkgmod/main.js", 0, 0],
  ["noindex", "/src", {}, "/node_modules/noindex/index.js", 1, 1],
  ["pkgcond", "/src", { target: "browser" }, "/node_modules/pkgcond/b.js", 1, 0],
  ["pkgcond", "/src", { target: "bun" }, "/node_modules/pkgcond/i.mjs", 1, 1],
  ["pkgcond", "/src", { target: "bun", kind: "require" }, "/node_modules/pkgcond/r.cjs", 0, 0],
  ["pkgcond", "/src", { target: "browser", kind: "require" }, "/node_modules/pkgcond/b.js", 0, 0],
  ["pkgdual", "/src", { target: "bun" }, "/node_modules/pkgdual/i.mjs", 1, 1],
  ["pkgdual", "/src", { target: "bun", kind: "require" }, "/node_modules/pkgdual/r.cjs", 0, 0],
  ["pkgdual", "/src", { target: "node", kind: "dynamic" }, "/node_modules/pkgdual/i.mjs", 0, 0],
  ["pkgcond/sub", "/src", {}, "/node_modules/pkgcond/sub.js", 1, 1],
  ["pkgcond/feat/one", "/src", {}, "/node_modules/pkgcond/features/one.js", 1, 1],
  ["pkgcond/hidden", "/src", {}, null, 1, 1], // not exported
  ["pkgcond/package.json", "/src", {}, "/node_modules/pkgcond/package.json", 1, 1],
  ["pkgcustom", "/src", {}, "/node_modules/pkgcustom/d.js", 0, 0],
  ["pkgcustom", "/src", { conds: "custom" }, "/node_modules/pkgcustom/custom.js", 0, 0],
  ["@scope/pkg", "/src", {}, "/node_modules/@scope/pkg/main.js", 1, 1],
  ["@scope/ex", "/src", {}, "/node_modules/@scope/ex/index.js", 1, 1],
  ["@scope/ex/util", "/src", {}, "/node_modules/@scope/ex/util/u.js", 1, 1],
  ["nested", "/src/sub/deep", {}, "/src/sub/node_modules/nested/n.js", 1, 1],
  ["nested", "/src", {}, null, 1, 1],
  ["#internal", "/src/dir", {}, "/src/internal.ts", 1, 1],
  ["#utils/fmt", "/src", {}, "/src/utils/fmt.ts", 1, 1],
  ["#dep", "/src", {}, "/node_modules/pkgmain/lib/entry.js", 1, 1],
  ["#nope", "/src", {}, null, 1, 1],
  ["@app/a", "/src/dir", {}, "/src/a.ts", 0, 1], // tsconfig paths
  ["@app/utils/fmt", "/src/sub/deep", {}, "/src/utils/fmt.ts", 0, 1],
  ["~lib", "/src/dir", {}, "/src/lib/index.ts", 0, 1],
  ["./missing", "/src", {}, null, 1, 1],
  ["nopkg", "/src", {}, null, 1, 1],
];

let failed = 0;
const mismatches = [];
const show = (r) => ("ok" in r ? r.ok : `(${r.err.split("\n")[0].slice(0, 60)})`);
for (const [spec, dir, opts, expected, vsJs, vsBun] of cases) {
  const label = `${spec} from ${dir} ${JSON.stringify(opts)}`;
  const got = wasmResolve(spec, dir, opts);
  const want = expected === null ? { err: "" } : { ok: expected };
  const pass = expected === null ? "err" in got && /ModuleNotFound/.test(got.err) : got.ok === expected;
  if (!pass) {
    failed++;
    console.log(`FAIL  ${label}\n      wasm=${show(got)} expected=${expected}`);
    continue;
  }
  const notes = [];
  if (vsJs) {
    const j = jsResolve(spec, dir, opts.target);
    if (show(j) !== (expected ?? show(j)) && (expected !== null || "ok" in j)) mismatches.push(`JS resolver: ${label}: js=${show(j)} wasm=${show(got)}`);
  }
  if (vsBun && hasBun) {
    const b = bunResolve(spec, dir.replace(/^\//, ""));
    const same = expected === null ? "err" in b : b.ok === expected;
    if (!same) mismatches.push(`bun: ${label}: bun=${show(b)} wasm=${show(got)}`);
  }
  console.log(`ok    ${label} -> ${expected}`);
}
// Error text
const nf = wasmResolve("nopkg", "/src");
assert.match(nf.err, /ModuleNotFound: nopkg from \/src/);
// The caches survive between calls (as in Bun); a VFS change is invisible until reset.
assert.ok("err" in wasmResolve("./late", "/src"));
vfs.write("src/late.ts", "");
const stale = wasmResolve("./late", "/src");
assert.ok("err" in stale, "caches are process-wide until invalidated");
const inval = (dir) => withStrBytes(dir, (p, l) => w.invalidate_c(p, l));
function withStrBytes(s, f) {
  const [p, l] = put(s);
  try { return f(p, l); } finally { w.dealloc(p, l); }
}
inval("/src");
assert.deepEqual(wasmResolve("./late", "/src"), { ok: "/src/late.ts" });
// A changed package.json is picked up after invalidating its directory.
assert.deepEqual(wasmResolve("pkgmain", "/src"), { ok: "/node_modules/pkgmain/lib/entry.js" });
vfs.write("node_modules/pkgmain/package.json", JSON.stringify({ name: "pkgmain", main: "other.js" }));
vfs.write("node_modules/pkgmain/other.js", "");
inval("/node_modules/pkgmain");
assert.deepEqual(wasmResolve("pkgmain", "/src"), { ok: "/node_modules/pkgmain/other.js" });
// Warm calls give the same answer.
assert.deepEqual(wasmResolve("./a", "/src"), { ok: "/src/a.ts" });
rmSync(tmp, { recursive: true, force: true });

console.log(hasBun ? "" : "(bun not on PATH: skipped native comparison)");
for (const m of mismatches) console.log("MISMATCH " + m);
console.log(`${cases.length - failed}/${cases.length} cases pass, ${mismatches.length} mismatches vs JS resolver/bun`);
process.exit(failed ? 1 : 0);
