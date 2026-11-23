#!/usr/bin/env bun
// The source pass that keeps AsyncLocalStorage across `await` (src/asyncAwait.ts), without a browser: the shapes it
// handles come out as valid code that does what the original does, and run with the worker's real AsyncLocalStorage
// (src/worker/node/asyncHooks.ts) each `await` resumes in its caller's store, through `try`, `for await`, generators
// and concurrent calls.
import { restoreContext, restoreContextMapped, withoutContext } from "../src/asyncAwait.ts";
import { decodeMappings, insertColumns, originalPosition } from "../src/sourceMap.ts";
import { async_hooks, installAsyncContext } from "../src/worker/node/asyncHooks.ts";

const transpiler = new Bun.Transpiler({ loader: "ts" });
let bad = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) return console.log(`✓ ${label}`);
  bad++;
  console.error(`✗ ${label}${detail === undefined ? "" : `\n  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

/** Shapes of `await` and what follows it: the pass must wrap exactly the awaited unary expression. */
const SHAPES: [string, string][] = [
  ["await x;", "__alsRestore(__alsSave(),await x);"],
  ["const a = await f(1)(2).b[c]?.d;", "const a = __alsRestore(__alsSave(),await f(1)(2).b[c]?.d);"],
  ["const a = await x + await y;", "const a = __alsRestore(__alsSave(),await x) + __alsRestore(__alsSave(),await y);"],
  ["const a = await x ? 1 : 2;", "const a = __alsRestore(__alsSave(),await x) ? 1 : 2;"],
  ["f(await g(await h()), 1);", "f(__alsRestore(__alsSave(),await g(__alsRestore(__alsSave(),await h()))), 1);"],
  ["const a = await new Foo(1).bar();", "const a = __alsRestore(__alsSave(),await new Foo(1).bar());"],
  ["const a = await `t${await x}`;", "const a = __alsRestore(__alsSave(),await `t${__alsRestore(__alsSave(),await x)}`);"],
  ["const a = await (async () => 1)();", "const a = __alsRestore(__alsSave(),await (async () => 1)());"],
  ["const a = await import('x');", 'const a = __alsRestore(__alsSave(),await import("x"));'],
  ["const a = { await: 1 }.await;", "const a = { await: 1 }.await;"],
  ["const a = /}/.test(await x);", "const a = /}/.test(__alsRestore(__alsSave(),await x));"],
  ["const s = '}await x';", 'const s = "}await x";'],
];

const wrap = (s: string) => `async function f() {\n${s}\n}`;
/** The pass's output without the comments around each insert (the shapes above leave them out). */
const unmarked = (s: string) => s.replaceAll("/*als*/", "");
for (const [src, want] of SHAPES) {
  const printed = transpiler.transformSync(wrap(src)).trim();
  const marked = restoreContext(printed);
  const out = unmarked(marked);
  check(`source without the inserts: ${src}`, withoutContext(marked) === printed, marked);
  const body = out.slice(out.indexOf("\n") + 1, out.lastIndexOf("\n}"));
  check(`shape: ${src}`, body.trim() === want || body.includes(want), { printed, out });
  try {
    transpiler.transformSync(out);
  } catch (e) {
    check(`parses: ${src}`, false, String(e));
  }
}

// try and for await get a saved context to restore (a rejection or a loop resumes without returning through the await)
{
  const out = unmarked(restoreContext(
    transpiler.transformSync(`async function f(it) {\n try { await a; } catch (e) { b(); } finally { c(); }\n for await (const x of it) d(x);\n for await (const x of it) { await e; break; }\n}`),
  ));
  check("try: catch and finally restore", /try \{[^]*\} catch \(e\) \{__alsRestore\(__t\d+\);/.test(out) && /finally \{__alsRestore\(__t\d+\);/.test(out), out);
  check("for await: braceless body restored each iteration", /of it\)\s*\{__alsRestore\(__f\d+\);d\(x\);\}\}finally/.test(out), out);
  check("for await: braced body restored", /of it\) \{__alsRestore\(__f\d+\);/.test(out), out);
  check("a try without await is left alone", !restoreContext(transpiler.transformSync("async function f() { try { x(); } catch { y(); } await z; }")).includes("__t"));
}
check("no await: unchanged", restoreContext("const a = 1;") === "const a = 1;");

// The worker's AsyncLocalStorage with the pass: what each await, catch and loop resumes in.
installAsyncContext();
const { AsyncLocalStorage } = async_hooks;
const als = new AsyncLocalStorage<string>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const program = `
function build(als, sleep) {
async function* gen() { await sleep(1); yield 1; await sleep(1); yield 2; }
async function helper() { await sleep(1); await null; return als.getStore(); }
return async function run() {
  const seen = [];
  const at = (l) => seen.push(l + "=" + als.getStore());
  await sleep(1); at("await");
  try { await Promise.reject(new Error("x")); } catch { at("catch"); } finally { at("finally"); }
  for await (const v of gen()) at("for-await");
  at("after-loop");
  for await (const v of gen()) break;
  at("after-break");
  seen.push("helper=" + (await helper()));
  seen.push("all=" + (await Promise.all([helper(), (async () => (await sleep(2), als.getStore()))()])).join());
  return seen;
};
}`;
const build = new Function(`${restoreContext(transpiler.transformSync(program))}\nreturn build;`)() as (a: unknown, s: unknown) => () => Promise<string[]>;
const run = build(als, sleep);
check("a function's source leaves the pass out", !run.toString().includes("__als") && run.toString().includes("await sleep(1)"), run.toString());
const results = await Promise.all(["r1", "r2"].map((id) => als.run(id, async () => (await run()).join(" "))));
for (const [i, id] of ["r1", "r2"].entries()) {
  const want = `await=${id} catch=${id} finally=${id} for-await=${id} for-await=${id} after-loop=${id} after-break=${id} helper=${id} all=${id},${id}`;
  check(`concurrent requests keep their store (${id})`, results[i] === want, results[i]);
}
check("outside any run: no store", als.getStore() === undefined);

// Timers and then-callbacks of the runtime: the callback runs where it was registered, and nothing leaks after.
const seen: string[] = [];
await als.run("m", () => new Promise<void>((done) => queueMicrotask(() => (seen.push("microtask=" + als.getStore()), Promise.resolve().then(() => (seen.push("then=" + als.getStore()), done()))))));
check("queueMicrotask and then carry the store", seen.join() === "microtask=m,then=m", seen);
check("nothing leaks to the next macrotask", await new Promise((r) => setTimeout(() => r(als.getStore() === undefined), 0)));

// The source map follows the inserts: a position after an `await` on a line still maps to its original column.
{
  const src = "const a = await f(), b = await g(); h();\n";
  const { code, inserts } = restoreContextMapped(src);
  const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // One segment per token start (generated column = original column), as small VLQs.
  const cols = [...src.matchAll(/\w+/g)].map((m) => m.index!);
  const vlq = (n: number) => b64[n << 1];
  const mappings = cols.map((c, i) => vlq(c - (cols[i - 1] ?? 0)) + "A" + "A" + vlq(c - (cols[i - 1] ?? 0))).join(",");
  const mapped = decodeMappings(insertColumns(mappings, inserts));
  for (const word of ["await", "g", "h"]) {
    const from = src.lastIndexOf(word);
    const got = originalPosition(mapped, 0, code.lastIndexOf(word))?.[1];
    check(`source map: ${word} after inserts maps to its column`, got === from, { got, want: from });
  }
}

process.exit(bad ? 1 : 0);
