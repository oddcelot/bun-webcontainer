// Runs the wasm64 build of `bun check` over small projects in a VFS and compares with native `bun check` in a temp
// directory with the same files (node >= 24).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VFS } from "../../packages/vfs/vfs.ts";
import { createSysImports } from "../../packages/vfs/sysHost.ts";

const wasm = readFileSync(new URL("../../target/wasm64-unknown-unknown/release/bun_check_wasm.wasm", import.meta.url));
const t0 = performance.now();
let vfs = new VFS();
type Wasm = { memory: WebAssembly.Memory; [fn: string]: any };
const module = await WebAssembly.compile(wasm);
const enc = new TextEncoder(), dec = new TextDecoder();
console.log(`compile ${(performance.now() - t0).toFixed(1)} ms, ${(wasm.length / 1e6).toFixed(1)} MB, bun ${execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()}`);

/** A fresh instance per project, as the playground makes one per check. */
async function check(files: Record<string, string>, args: string[]) {
  vfs = new VFS();
  for (const [path, text] of Object.entries(files)) vfs.write(path, text);
  let w!: Wasm;
  const instance = await WebAssembly.instantiate(module, createSysImports(vfs, () => w.memory, () => new Uint8Array(0)) as any);
  w = instance.exports as Wasm;
  const bytes = enc.encode(args.join("\0")), n = BigInt(bytes.length), p = w.alloc(n);
  new Uint8Array(w.memory.buffer, Number(p), bytes.length).set(bytes);
  const t = performance.now();
  const out = w.run_c(p, n, 0);
  const ms = performance.now() - t;
  const view = new DataView(w.memory.buffer);
  const at = (i: number) => view.getBigUint64(Number(out) + 8 * i, true);
  const str = (ptr: bigint, len: bigint) => dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  const result = { exitCode: Number(at(0)), stdout: str(at(1), at(2)), stderr: str(at(3), at(4)), ms };
  w.run_output_free(out);
  return result;
}

function native(files: Record<string, string>, args: string[]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "check-wasm-")));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const r = spawnSync("bun", ["check", "--no-pretty", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", CLAUDECODE: "", AGENT: "" } });
    return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The summary's timing ("[14.00ms]") differs between runs.
const norm = (s: string) => s.replace(/\s*\[[\d.]+m?s\]/g, "");

const tsconfig = JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "preserve", noEmit: true, lib: ["es2022", "dom"] } });
const cases: { name: string; files: Record<string, string>; args?: string[] }[] = [
  { name: "clean", files: { "tsconfig.json": tsconfig, "index.ts": "export const n: number = 1;\nconsole.log([1, 2].map((x) => x * n));\n" } },
  {
    name: "errors",
    files: {
      "tsconfig.json": tsconfig,
      "index.ts": 'import { add } from "./math";\nconst s: string = add(1, 2);\nconsole.log(s.toFixed(2), missing);\n',
      "math.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
    },
  },
  { name: "no tsconfig, one file", files: { "a.ts": "let x: number = 'one';\n" }, args: ["a.ts"] },
  { name: "compiler flag", files: { "a.ts": "function f(x) { return x; }\nf(1);\n" }, args: ["--noImplicitAny", "a.ts"] },
  { name: "unknown flag", files: { "a.ts": "" }, args: ["--nope"] },
];

let failed = 0;
for (const c of cases) {
  const args = ["--no-pretty", ...(c.args ?? [])];
  const got = await check(c.files, args);
  const want = native(c.files, c.args ?? []);
  const same = got.exitCode === want.exitCode && norm(got.stdout) === norm(want.stdout) && norm(got.stderr).trim() === norm(want.stderr).trim();
  console.log(`${same ? "ok  " : "FAIL"} ${c.name} (${got.ms.toFixed(0)} ms, exit ${got.exitCode})`);
  if (!same) {
    failed++;
    console.log("  wasm:", JSON.stringify(got), "\n  bun: ", JSON.stringify(want));
  }
}
if (failed) {
  console.log(`${failed} of ${cases.length} differ`);
  process.exit(1);
}
