// Runs the wasm build of lol-html under the playground's host (apps/playground/src/worker/htmlRewriter.ts) through
// cases.ts and compares with expected.json, which gen-expected.ts made with native Bun.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { makeHTMLRewriter } from "../../apps/playground/src/worker/htmlRewriter.ts";
import { runCases } from "./cases.ts";

const bytes = readFileSync(new URL("../../target/wasm64-unknown-unknown/release/bun_htmlrewriter_wasm.wasm", import.meta.url));
const module = new WebAssembly.Module(bytes);
console.log("imports:", WebAssembly.Module.imports(module));

const HTMLRewriter = makeHTMLRewriter(() => module);
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8")) as Record<string, unknown>;
const got = await runCases(HTMLRewriter as never);

// Where the browser's Response differs from Bun's in wording, not in behavior.
const known: Record<string, string> = {};

let failed = 0;
for (const name of new Set([...Object.keys(expected), ...Object.keys(got)])) {
  try {
    assert.deepEqual(got[name], expected[name]);
  } catch {
    if (known[name]) {
      console.log(`known difference: ${name} (${known[name]})`);
      continue;
    }
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected[name])}\n  got      ${JSON.stringify(got[name])}`);
  }
}
if (failed) {
  console.error(`${failed} of ${Object.keys(expected).length} cases differ from native Bun`);
  process.exit(1);
}
console.log(`${Object.keys(expected).length} cases match native Bun`);
