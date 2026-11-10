// Bun's own shell tests (bun/test/js/bun/shell: the builtins' commands/*.test.ts, bunshell.test.ts, ...) against the
// playground's shell under node: Bun.$ is src/shell/dollar.ts over real temp dirs (nodeFs.ts), and bun:test,
// harness and friends are the shims next to this file. Tests that spawn a native Bun or need its internals are
// skipped. Usage: node src/shell/conformance/run.ts [test file names...] [-v]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import * as bunTest from "./bun-test.ts";

const here = new URL("./", import.meta.url);
const repo = new URL("../../../../../", import.meta.url).pathname;
const shellTests = join(repo, "bun/test/js/bun/shell");
const shims: Record<string, string> = {
  bun: "bun.ts",
  "bun:test": "bun-test.ts",
  harness: "harness.ts",
  "bun:ffi": "skip.ts",
  "bun:internal-for-testing": "skip.ts",
};
registerHooks({
  resolve(specifier, context, next) {
    const shim = shims[specifier];
    if (shim) return { url: new URL(shim, here).href, shortCircuit: true };
    // The playground's own imports leave out `.ts` (Vite resolves them).
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return next(specifier + ".ts", context);
      } catch {}
    }
    return next(specifier, context);
  },
  // Bun's import.meta.path is node's import.meta.filename.
  load(url, context, next) {
    const r = next(url, context);
    if (url.includes("/bun/test/") && r.source) r.source = String(r.source).replaceAll("import.meta.path", "import.meta.filename");
    return r;
  },
});

// After the hook: the playground's modules import without `.ts`.
const { createDollar } = await import("../dollar.ts");
const { shellWasm } = await import("../parse.ts");
const { builtins } = await import("../builtins/index.ts");
const { DISCARD } = await import("../interp.ts");
const { nodeFs } = await import("./nodeFs.ts");

const wasm = shellWasm(new WebAssembly.Module(readFileSync(join(repo, "target/wasm64-unknown-unknown/release/bun_shell_wasm.wasm"))));
(globalThis as any).__shellWasm = wasm;
const skip = () => {
  throw new bunTest.SkipError("spawns a native process");
};
const $ = createDollar({
  fs: nodeFs,
  wasm,
  builtins,
  // Native programs the tests call: the browser has no processes, so those tests are skipped.
  commands: Object.fromEntries(
    // test_builder.ts's own bunExe() is process.execPath (node here).
    ["/__native_bun__", process.execPath, "bun", "bash", "sh", "grep", "sed", "awk", "head", "tail", "wc", "sort", "uniq", "tr", "env", "printf", "node", "sleep", "onlyintool", "test", "["].map((name) => [
      name,
      async () => {
        throw new bunTest.SkipError(`runs the native ${name}`);
      },
    ]),
  ),
  stdout: DISCARD,
  stderr: DISCARD,
  cwd: () => process.cwd(),
  env: () => process.env,
  buffer: (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  home: process.env.HOME,
});
(globalThis as any).Bun = {
  $,
  jest: () => bunTest,
  file: (p: string) => ({
    name: p,
    text: async () => readFileSync(p, "utf8"),
    arrayBuffer: async () => new Uint8Array(readFileSync(p)).buffer,
    exists: async () => nodeFs.stat(p) !== undefined,
    writer: () => {
      const chunks: (string | Uint8Array)[] = [];
      return {
        write: (c: string | Uint8Array) => void chunks.push(c),
        flush: () => {},
        end: () => writeFileSync(p, Buffer.concat(chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c)))),
      };
    },
  }),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  spawn: skip,
  spawnSync: skip,
  which: skip,
  serve: skip,
  stdout: { writer: skip },
  stdin: { stream: skip },
  Glob: class {
    constructor() {
      skip();
    }
  },
};
Object.assign(globalThis, { describe: bunTest.describe, test: bunTest.test, it: bunTest.it, expect: bunTest.expect, beforeAll: bunTest.beforeAll, afterAll: bunTest.afterAll });

// A test that starts a `$` without awaiting it: its failure isn't the run's.
process.on("unhandledRejection", () => {});

const args = process.argv.slice(2);
const verbose = args.includes("-v");
const wanted = args.filter((a) => !a.startsWith("-"));
const all = ["bunshell.test.ts", ...readdirSync(join(shellTests, "commands")).filter((f) => f.endsWith(".test.ts")).map((f) => `commands/${f}`)];
// `ls` means commands/ls.test.ts (not false.test.ts).
const files = wanted.length ? all.filter((f) => wanted.some((w) => f.split("/").pop()!.startsWith(w + "."))) : all;

const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms))]);
let total = { passed: 0, failed: 0, skipped: 0 };
for (const file of files) {
  bunTest.cases.length = 0;
  for (const k of Object.keys(bunTest.hooks) as (keyof typeof bunTest.hooks)[]) bunTest.hooks[k].length = 0;
  bunTest.setFile(file);
  try {
    await import(join(shellTests, file));
  } catch (e) {
    console.log(`${file}: failed to load: ${(e as Error).message}`);
    total.failed++;
    continue;
  }
  const r = { passed: 0, failed: 0, skipped: 0 };
  const fails: string[] = [];
  let setup: unknown;
  try {
    for (const h of bunTest.hooks.beforeAll) await timeout(Promise.resolve().then(h), 30_000);
  } catch (e) {
    setup = e;
  }
  for (const c of bunTest.cases) {
    if (setup && !c.skip) {
      r.failed++;
      fails.push(`  FAIL ${c.name}\n    beforeAll failed: ${String((setup as Error)?.message ?? setup).split("\n")[0]}`);
      continue;
    }
    if (c.skip) {
      r.skipped++;
      continue;
    }
    try {
      for (const h of bunTest.hooks.beforeEach) await h();
      await timeout(Promise.resolve().then(c.fn), 10_000);
      for (const h of bunTest.hooks.afterEach) await h();
      r.passed++;
    } catch (e) {
      if (e instanceof bunTest.SkipError || /spawns a native|runs the native|native Bun/.test(String((e as Error)?.message))) r.skipped++;
      else {
        r.failed++;
        fails.push(`  FAIL ${c.name}\n    ${String((e as Error)?.message ?? e).split("\n").slice(0, 6).join("\n    ")}`);
      }
    }
  }
  for (const h of bunTest.hooks.afterAll) await Promise.resolve().then(h).catch(() => {});
  console.log(`${file}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped`);
  if (verbose) for (const f of fails) console.log(f);
  total = { passed: total.passed + r.passed, failed: total.failed + r.failed, skipped: total.skipped + r.skipped };
}
console.log(`total: ${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped`);
// A test can leave a timer or a pending `$` behind; the run is over.
process.exit(0);
