// Runs the resolve-wasm module (what the playground's module server resolves with) against a
// playground-VFS fixture through the `bun_sys` host imports, and compares with real Bun
// (`Bun.resolveSync` over the same fixture written to disk) if `bun` is on PATH.
// Run with node >= 24 (Memory64 + native .ts type stripping; bun lacks Memory64):  node test.ts
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname as pdirname } from "node:path";
import assert from "node:assert/strict";
import { VFS } from "../../packages/vfs/vfs.ts";
import { createSysImports } from "../../packages/vfs/sysHost.ts";

const here = (p: string) => new URL(p, import.meta.url);
const mod = new WebAssembly.Module(readFileSync(here("../../target/wasm64-unknown-unknown/release/bun_resolve_wasm.wasm")));

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

let memory: WebAssembly.Memory;
type Wasm = { memory: WebAssembly.Memory; [fn: string]: any };
const w = new WebAssembly.Instance(mod, createSysImports(vfs, () => memory)).exports as Wasm;
memory = w.memory;
const enc = new TextEncoder();
const dec = new TextDecoder();
function put(s: string): [bigint, bigint] {
  const b = enc.encode(s);
  const p = w.alloc(BigInt(b.length));
  new Uint8Array(w.memory.buffer, Number(p), b.length).set(b);
  return [p, BigInt(b.length)];
}
const KIND: Record<string, number> = { import: 2, require: 3, dynamic: 4 };
const TARGET: Record<string, number> = { browser: 0, bun: 1, node: 2 };
type Res = { ok?: string; err?: string };
/** -> {ok: "/abs/path"} | {err: "text"} */
function wasmResolve(spec: string, dir: string, { kind = "import", target = "browser", conds = "" } = {}) {
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

const tmp = mkdtempSync(join(tmpdir(), "resolve-wasm-"));
// Real Bun over the same fixture on disk.
const disk = join(tmp, "fx");
for (const [p, c] of Object.entries(files)) {
  mkdirSync(pdirname(join(disk, p)), { recursive: true });
  writeFileSync(join(disk, p), c);
}
const hasBun = spawnSync("bun", ["--version"]).status === 0;
function bunResolve(spec: string, dir: string): Res {
  const r = spawnSync("bun", ["-e", `try{console.log(Bun.resolveSync(process.argv[1],process.argv[2]))}catch(e){console.log("ERR "+e.message)}`, spec, join(disk, dir)], { encoding: "utf8" });
  const o = r.stdout.trim();
  // macOS tmp is a symlink; Bun reports the real path.
  return o.startsWith("ERR") ? { err: o } : { ok: o.slice(o.indexOf("/fx/") + 3) };
}

// [spec, dir, wasm options, expected path (null = not found), (unused), compare with Bun?]
const cases: [string, string, Record<string, string>, string | null, number, number][] = [
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
const show = (r: Res) => ("ok" in r ? r.ok : `(${r.err!.split("\n")[0].slice(0, 60)})`);
for (const [spec, dir, opts, expected, , vsBun] of cases) {
  const label = `${spec} from ${dir} ${JSON.stringify(opts)}`;
  const got = wasmResolve(spec, dir, opts);
  const want = expected === null ? { err: "" } : { ok: expected };
  const pass = expected === null ? "err" in got && /ModuleNotFound/.test(got.err!) : got.ok === expected;
  if (!pass) {
    failed++;
    console.log(`FAIL  ${label}\n      wasm=${show(got)} expected=${expected}`);
    continue;
  }
  const notes = [];
  if (vsBun && hasBun) {
    const b = bunResolve(spec, dir.replace(/^\//, ""));
    const same = expected === null ? "err" in b : b.ok === expected;
    if (!same) mismatches.push(`bun: ${label}: bun=${show(b)} wasm=${show(got)}`);
  }
  console.log(`ok    ${label} -> ${expected}`);
}
// Error text
const nf = wasmResolve("nopkg", "/src");
assert.match(nf.err!, /ModuleNotFound: nopkg from \/src/);
// The caches survive between calls (as in Bun); a VFS change is invisible until reset.
assert.ok("err" in wasmResolve("./late", "/src"));
vfs.write("src/late.ts", "");
const stale = wasmResolve("./late", "/src");
assert.ok("err" in stale, "caches are process-wide until invalidated");
const inval = (dir: string) => withStrBytes(dir, (p, l) => w.invalidate_c(p, l));
function withStrBytes<T>(s: string, f: (p: bigint, l: bigint) => T): T {
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

// Bun.Glob: glob_match_c and glob_scan_c (over the VFS) vs Bun's Glob#match and Glob#scanSync over the fixture on disk.
vfs.write("src/.hidden/h.ts", "");
mkdirSync(join(disk, "src/.hidden"), { recursive: true });
writeFileSync(join(disk, "src/.hidden/h.ts"), "");
writeFileSync(join(disk, "src/late.ts"), ""); // written to the VFS above
const GLOB = { dot: 1, absolute: 2, onlyFiles: 4 } as const;
function globScan(pattern: string, cwd: string, opts: { dot?: boolean; onlyFiles?: boolean } = {}): string[] | string {
  const flags = (opts.dot ? GLOB.dot : 0) | (opts.onlyFiles === false ? 0 : GLOB.onlyFiles);
  const a = put(pattern), b = put(cwd);
  const out = w.glob_scan_c(a[0], a[1], b[0], b[1], flags);
  for (const [p, l] of [a, b]) w.dealloc(p, l);
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out);
  return status === 0n ? text.split("\0").slice(0, -1).sort() : `ERR ${text.split("\0").join(" ")}`;
}
const globMatch = (pattern: string, path: string) => withStrBytes(pattern, (pp, pl) => withStrBytes(path, (sp, sl) => w.glob_match_c(pp, pl, sp, sl))) === 1;
const globScans: [string, string, { dot?: boolean; onlyFiles?: boolean }][] = [
  ["**/*.ts", "/src", {}],
  ["**/*.ts", "/src", { dot: true }],
  ["src/**/*.{ts,tsx}", "/", {}],
  ["*", "/src", { onlyFiles: false }],
  ["**", "/node_modules/@scope", { onlyFiles: false }],
  ["node_modules/*/package.json", "/", {}],
  ["src/[a-c].*", "/", {}],
  ["src/?.ts", "/", {}],
  ["src/sub/deep/x.ts", "/", {}],
  ["src/dir", "/", { onlyFiles: false }],
];
const globMatches: [string, string][] = [
  ["!*.ts", "a.js"], ["!*.ts", "a.ts"], ["[a-c]?.md", "bz.md"], ["[!a]*", "b"], ["[^a]*", "a"], ["a/**", "a"], ["a/**", "a/b/c"],
  ["**", "a/.b"], ["*", "a/b"], ["**/*.ts", "b.ts"], ["{a,b/{c,d}}/x", "b/d/x"], ["\\*a", "*a"], ["*", ".a"], ["x/**/y", "x/y"], ["a?", "a/"],
];
for (const [pattern, cwd, opts] of globScans) {
  const got = globScan(pattern, cwd, opts);
  if (typeof got === "string") { failed++; console.log(`FAIL  glob ${pattern} in ${cwd}: ${got}`); continue; }
  if (hasBun) {
    const r = spawnSync("bun", ["-e", "console.log(JSON.stringify([...new Bun.Glob(process.argv[1]).scanSync({ cwd: process.argv[2], ...JSON.parse(process.argv[3]) })].sort()))", pattern, join(disk, cwd), JSON.stringify(opts)], { encoding: "utf8" });
    const want = JSON.parse(r.stdout) as string[];
    if (JSON.stringify(want) !== JSON.stringify(got)) mismatches.push(`bun: glob ${pattern} in ${cwd} ${JSON.stringify(opts)}: bun=${JSON.stringify(want)} wasm=${JSON.stringify(got)}`);
  }
  console.log(`ok    glob ${pattern} in ${cwd} ${JSON.stringify(opts)} -> ${got.length} paths`);
}
assert.match(String(globScan("*", "/nonexistent")), /^ERR ENOENT open/);
if (hasBun) {
  const r = spawnSync("bun", ["-e", "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(([p, s]) => new Bun.Glob(p).match(s))))", JSON.stringify(globMatches)], { encoding: "utf8" });
  const want = JSON.parse(r.stdout) as boolean[];
  const got = globMatches.map(([p, s]) => globMatch(p, s));
  globMatches.forEach(([p, s], i) => want[i] !== got[i] && mismatches.push(`bun: glob match ${p} ${s}: bun=${want[i]} wasm=${got[i]}`));
  console.log(`ok    ${globMatches.length} glob matches compared`);
}

// Bun.YAML.parse / Bun.TOML.parse: data_parse_c's tree, rebuilt as the playground does, vs native Bun's values.
const dataCases: ["yaml" | "toml", string][] = [
  ["yaml", "a: 1\nb: [x, 'y', \"z\\n\"]\nc: {d: null, e: ~, f: true}\n"],
  ["yaml", "- .inf\n- -.Inf\n- .nan\n- -0\n- 0o17\n- 0x1F\n- 1e3\n- 2001-12-14\n- 12345678901234567890\n"],
  ["yaml", "base: &b {x: 1}\nderived:\n  <<: *b\n  y: 2\nsame: *b\n"],
  ["yaml", "a: &a [1, *a]\n"],
  ["yaml", "--- 1\n--- two\n...\n"],
  ["yaml", ""],
  ["yaml", "text: |\n  line 1\n  line 2\nfolded: >\n  a\n  b\nuni: \"\\u00e9\\U0001F600 日本\"\n"],
  ["yaml", "? [a, b]\n: 1\n__proto__: 2\n"],
  ["yaml", "a: [1"],
  ["yaml", "a: 1\n a: 2"],
  ["toml", "title = \"x\"\n[owner]\nname = 'Tom'\ndob = 1979-05-27T07:32:00-08:00\n[db]\nports = [8000, 8001]\nenabled = true\ntemp = { cpu = 79.5, case = 72.0 }\n"],
  ["toml", "a = inf\nb = -inf\nc = nan\nd = 0x10\ne = 0o17\nf = 0b11\ng = 1_000\nh = -0.0\ni = 1e400\n"],
  ["toml", "ldt = 1979-05-27T07:32:00\nld = 1979-05-27\nlt = 07:32:00.999999\n"],
  ["toml", "[[fruit]]\nname = \"apple\"\n[[fruit.variety]]\nname = \"red\"\n[[fruit]]\nname = \"banana\"\n\"quoted key\" = \"\\u00e9\\t\"\nml = \"\"\"\nhi\nthere\"\"\"\n"],
  ["toml", "a = "],
  ["toml", "a = 1\na = 2"],
];
const canonSrc = `(v) => { const seen = new Map(); const c = (v) => {
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (seen.has(v)) return "#" + seen.get(v);
  seen.set(v, seen.size);
  if (v.constructor && /^(Instant|Plain)/.test(v.constructor.name)) return v.constructor.name + "(" + v.toString() + ")";
  if (Array.isArray(v)) return "[" + v.map(c).join(",") + "]";
  return "{" + Object.keys(v).map((k) => JSON.stringify(k) + ":" + c(v[k])).join(",") + "}";
}; return c(v); }`;
const canon = eval(canonSrc) as (v: unknown) => string;
const { fromDataTree } = await import("../../apps/playground/src/dataTree.ts");
function wasmData(text: string, format: "yaml" | "toml"): string {
  const a = put(text);
  const out = w.data_parse_c(a[0], a[1], format === "toml" ? 1 : 0);
  w.dealloc(a[0], a[1]);
  const [status, ptr, len] = new BigUint64Array(w.memory.buffer, Number(out), 3);
  const json = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out);
  return status === 0n ? canon(fromDataTree(json)) : `SyntaxError: ${json}`;
}
const dataGot = dataCases.map(([f, t]) => wasmData(t, f));
if (hasBun) {
  const r = spawnSync("bun", ["-e", `const canon = ${canonSrc}; console.log(JSON.stringify(JSON.parse(process.argv[1]).map(([f, t]) => { try { return canon(Bun[f.toUpperCase()].parse(t)); } catch (e) { return e.name + ": " + e.message; } })))`, JSON.stringify(dataCases)], { encoding: "utf8" });
  const want = JSON.parse(r.stdout) as string[];
  dataCases.forEach(([f, t], i) => want[i] !== dataGot[i] && mismatches.push(`bun: ${f} ${JSON.stringify(t)}: bun=${want[i]} wasm=${dataGot[i]}`));
}
console.log(`ok    ${dataCases.length} YAML/TOML documents parsed`);
if (process.env.SHOW_DATA) for (const g of dataGot) console.log("  " + g);
rmSync(tmp, { recursive: true, force: true });

console.log(hasBun ? "" : "(bun not on PATH: skipped native comparison)");
for (const m of mismatches) console.log("MISMATCH " + m);
console.log(`${cases.length - failed}/${cases.length} cases pass, ${mismatches.length} mismatches vs bun`);
process.exit(failed ? 1 : 0);
