// transpile_resolve_c: import specifiers come from Bun's import records and are rewritten via `env.resolve_specifier`.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const wasm = readFileSync(new URL("../target/wasm64-unknown-unknown/release/bun_transpile_wasm.wasm", import.meta.url));
let resolver = () => null;
const calls = [];
let w;
const enc = new TextEncoder(), dec = new TextDecoder();
const { instance } = await WebAssembly.instantiate(wasm, {
  env: {
    resolve_specifier(ptr, len, kind) {
      const spec = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
      calls.push([spec, kind]);
      const r = resolver(spec, kind);
      if (r == null) return 0n;
      const b = enc.encode(r), p = w.alloc(BigInt(8 + b.length));
      new DataView(w.memory.buffer).setBigUint64(Number(p), BigInt(b.length), true);
      new Uint8Array(w.memory.buffer, Number(p) + 8, b.length).set(b);
      return p;
    },
  },
});
w = instance.exports;
const LOADERS = { js: 0, jsx: 1, ts: 2, tsx: 3 };

function run(path, source, fn) {
  resolver = fn; calls.length = 0;
  const put = (s) => { const b = enc.encode(s), p = w.alloc(BigInt(b.length)); new Uint8Array(w.memory.buffer, Number(p), b.length).set(b); return [p, BigInt(b.length)]; };
  const [pp, pl] = put(path), [sp, sl] = put(source);
  const out = w.transpile_resolve_c(pp, pl, sp, sl, LOADERS[path.split(".").pop()], 0);
  const v = new DataView(w.memory.buffer);
  const status = v.getBigUint64(Number(out), true), ptr = v.getBigUint64(Number(out) + 8, true), len = v.getBigUint64(Number(out) + 16, true);
  const text = dec.decode(new Uint8Array(w.memory.buffer, Number(ptr), Number(len)));
  w.output_free(out); w.dealloc(pp, pl); w.dealloc(sp, sl);
  assert.equal(status, 0n, text);
  return text;
}
const pre = (s) => (s === "keep" ? null : `/v/${s}`);

// static import, side-effect import, export-from, dynamic import with a literal
let out = run("a.js", `import a from "x"; import "y"; export { b } from 'z'; export * from "w"; const m = import("d"); use(a, b, m);`, pre);
for (const s of ["x", "y", "z", "w", "d"]) assert.ok(out.includes(`"/v/${s}"`), `${s} not rewritten: ${out}`);
assert.deepEqual(calls.map((c) => c[1]).sort(), [2, 2, 2, 2, 4]);

// text that only looks like an import (string, template, comment, regex) is untouched and never asked about (the printer drops comments)
out = run("b.js", "const s = \"import x from 'y'\";\nconst t = `import z from 'q'; ${1}`;\n// import c from 'cmt'\n/* import('blk') */\nconst r = /import\\s*\\(\"re\"\\)/;\nimport real from 'ok';\nconsole.log(s, t, r, real);", pre);
assert.deepEqual(calls.map((c) => c[0]), ["ok"]);
assert.ok(out.includes(`"import x from 'y'"`) && out.includes("import z from 'q'"), out);

// computed dynamic import and require() are not rewritten
out = run("c.js", `const v = "m"; import(v); import("lit" + v); const r = require("req");`, pre);
assert.ok(!calls.some(([s]) => s === "req" || s === "m"), JSON.stringify(calls));
assert.ok(out.includes('require("req")') && out.includes("import(v)"), out);

// null keeps the specifier; TS type-only imports are dropped, not resolved
out = run("d.ts", `import type { T } from "types-only"; import { v } from "keep"; import { u } from "other"; export const x: T = v + u;`, pre);
assert.ok(out.includes('"keep"') && out.includes('"/v/other"') && !out.includes("types-only"), out);
assert.ok(!calls.some(([s]) => s === "types-only"), JSON.stringify(calls));

// the printer escapes whatever the host returns
out = run("e.js", `import x from "a";use(x)`, () => `/v/it's é`);
assert.ok(out.includes(`"/v/it's é"`) || out.includes("it's \\u00E9"), out);
console.log("resolve-test: ok");
