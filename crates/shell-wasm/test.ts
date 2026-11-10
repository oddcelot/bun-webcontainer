// Bun's own parser tests (bun/test/js/bun/shell/parse.test.ts) against the wasm build, under node: `bun:test`,
// `bun:internal-for-testing`, `harness` and `./util` are the shims in shims/. Tests that need a native Bun are skipped.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { shellParser } from "../../apps/playground/src/shell/parse.ts";

const here = new URL("./", import.meta.url);
const shims: Record<string, string> = {
  "bun:test": "shims/bun-test.ts",
  "bun:internal-for-testing": "shims/internal-for-testing.ts",
  harness: "shims/harness.ts",
  "./util": "shims/util.ts",
};
registerHooks({
  resolve(specifier, context, next) {
    const shim = shims[specifier];
    return shim ? { url: new URL(shim, here).href, shortCircuit: true } : next(specifier, context);
  },
});

const wasm = new URL("../../target/wasm64-unknown-unknown/release/bun_shell_wasm.wasm", import.meta.url);
(globalThis as any).__shellParse = shellParser(new WebAssembly.Module(readFileSync(wasm)));

const { SkipError } = await import("./shims/harness.ts");
const bunTest = await import("./shims/bun-test.ts");
const { cases } = bunTest;
// bun test's globals.
Object.assign(globalThis, { describe: bunTest.describe, test: bunTest.test, it: bunTest.it, expect: bunTest.expect });
// A test that spawns a native Bun (`Bun.spawn`) is skipped.
(globalThis as any).Bun = new Proxy({}, { get: () => { throw new SkipError("needs a native Bun"); } });
await import("../../bun/test/js/bun/shell/parse.test.ts");

let passed = 0, skipped = 0;
const failed: string[] = [];
for (const c of cases) {
  if (c.todo) {
    skipped++;
    continue;
  }
  try {
    await c.fn();
    passed++;
  } catch (e) {
    if (e instanceof SkipError) skipped++;
    else failed.push(`${c.name}\n  ${String((e as Error).message).split("\n").slice(0, 12).join("\n  ")}`);
  }
}
// The one spawning test's script, in-process: deep nesting is an error, not a stack overflow.
const depth = 20000;
try {
  (globalThis as any).__shellParse("if true; then ".repeat(depth) + "echo x" + "; fi".repeat(depth));
  failed.push("nesting depth: parsed");
} catch (e) {
  if ((e as Error).message === "Nesting depth exceeded") passed++;
  else failed.push(`nesting depth: ${(e as Error).message}`);
}

for (const f of failed) console.log(`FAIL ${f}`);
console.log(`parse.test.ts: ${passed} passed, ${failed.length} failed, ${skipped} skipped (need a native Bun, or todo)`);
if (failed.length) process.exit(1);
