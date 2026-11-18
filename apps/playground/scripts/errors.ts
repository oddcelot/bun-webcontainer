#!/usr/bin/env bun
// Errors as programs see and print them (src/worker/sourceMaps.ts installStackTraces, the error printer in
// src/worker/inspect.ts), end to end: each program below runs in the embed in headless Chrome and prints `error.stack`,
// `util.inspect` of errors and promises, or dies with an uncaught error; the console must read as native Bun's for the
// same files (run with `bun` in a temp folder, its absolute paths read as the project's). The programs keep clear of
// what differs by engine: messages V8 words differently (JSON.parse, property reads), JSC's tail calls.
//   bun scripts/errors.ts
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { nativeEnv } from "./native-env";

const app = join(import.meta.dir, "..");
const PORT = 5196;
const HOST_PORT = 5195;
const EDITOR = `http://localhost:${PORT}`;

const PROGRAMS: Record<string, string> = {
  // Names as JSC gives them: the function's own (not V8's `Foo.bar`), `new K`, no `async `.
  "names.ts": `class Foo { bar() { throw new Error("m"); } static baz() { new Foo().bar(); } }
const o = { meth() { Foo.baz(); } };
function named() { o.meth(); }
const assigned = function () { named(); };
async function asy() { await 0; assigned(); }
async function outer() { await asy(); }
class K { constructor() { throw new Error("k"); } }
try { new K(); } catch (e) { console.log(e.stack); }
await outer().catch((e) => console.log(e.stack));`,
  // An uncaught error from CommonJS: the source preview, <anonymous> for an assigned function and the module's body,
  // no frames of the playground's CommonJS wrapper.
  "uncaught.cjs": `module.exports.fail = function () { throw new Error("boom"); };\nmodule.exports.fail();`,
  // Columns: \`new X\` at X, and import.meta rewrites earlier on the line.
  "columns.ts": `const d = import.meta.dirname, p = import.meta.path, u = import.meta.url; const e = new Error("x"); console.log(e.stack);
const x = import.meta.dir; const y = import.meta.file; throw new Error("col");`,
  // console.trace: the caller's frames, none of the console's.
  "trace.ts": `function inner() { console.trace("here", 1); }\nfunction outer() { inner(); }\nouter();`,
  // A program's extension is its module type where its code doesn't decide (moduleKindOf `entry`): a .cjs one without
  // CommonJS features runs as CommonJS (its top-level frame <anonymous>), a .mjs one with a free require as an ES
  // module. Imported, the code and the package decide, so the same files go the other way.
  "kind.cjs": `console.log("cjs", new Error().stack.split("\\n")[1].trim());`,
  "kind.mjs": `const p = require("node:path");\nconsole.log("mjs", typeof p.join, new Error().stack.split("\\n")[1].trim());`,
  "kinds.ts": `await import("./kind.cjs");\nawait import("./kind.mjs");`,
  // Bun prints no frame for JSON.parse (a builtin) between the reviver's and the caller's.
  "builtin.ts": `JSON.parse("1", function rev() { throw new Error("in reviver"); });`,
  // Asynchronous I/O errors carry no stack; keys in Bun's order; Bun.write's promise is resolved when it returns.
  "io.ts": `import fs from "node:fs";
import { inspect } from "node:util";
const p = Bun.file("nope.txt").text();
await p.catch(() => {});
console.log(p);
console.log(inspect(p));
await new Promise((r) => fs.readFile("nope.txt", (e) => r(console.log("cb", e.stack, Object.keys(e)))));
try { fs.readFileSync("nope.txt"); } catch (e) { console.log("sync", Object.keys(e)); }
await fs.promises.readFile("nope.txt").catch((e) => console.log("promises", e.stack, Object.keys(e)));
const a = Bun.write("o1.txt", "x"), b = Bun.write("o2.txt", new Blob(["y"])), c = Bun.write("o3.txt", new Uint8Array(3));
console.log(a, b, c);
await Promise.all([a, b, c]);
console.log(a, b, c);`,
};

const lines = (text: string) =>
  text
    .split("\n")
    .filter((l) => l && !/^Bun v|^\[run\]|^\[exited with/.test(l));

/** What native Bun prints for each program, its folder's absolute path removed (the playground's project is /). */
function native(): Record<string, string[]> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "errors-")));
  try {
    for (const [name, text] of Object.entries(PROGRAMS))
      writeFileSync(join(dir, name), text);
    return Object.fromEntries(
      Object.keys(PROGRAMS).map((name) => {
        const r = Bun.spawnSync(["bun", name], {
          cwd: dir,
          env: nativeEnv({ NO_COLOR: "1", FORCE_COLOR: "0" }),
        });
        return [
          name,
          lines(
            (r.stdout.toString() + r.stderr.toString()).replaceAll(dir, ""),
          ),
        ];
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const chrome =
  process.env.CHROME ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const want = native();
const files = { ...PROGRAMS, "index.ts": "" };
const vite = Bun.spawn(
  ["bunx", "vite", "--port", String(PORT), "--strictPort"],
  {
    cwd: app,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      VITE_CACHE_DIR: join(app, "node_modules/.vite-errors"),
    },
  },
);
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=console"></iframe>
<script>
  window.lines = []; window.events = [];
  const files = ${JSON.stringify(files)};
  let id = 0; const pending = new Map();
  window.rpc = (method, params) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    f.contentWindow.postMessage({ bunPlayground: 1, id: i, method, params }, "${EDITOR}");
  });
  addEventListener("message", (e) => {
    const d = e.data;
    if (d?.bunPlayground !== 1) return;
    if (typeof d.id === "number" && !d.event) { const p = pending.get(d.id); pending.delete(d.id); d.error !== undefined ? p.reject(new Error(d.error)) : p.resolve(d.result); return; }
    window.events.push(d.event);
    if (d.event === "boot") window.rpc("init", { files });
    if (d.event === "console") window.lines.push(...d.data.text.split("\\n"));
  });
</script>`,
      { headers: { "content-type": "text/html" } },
    ),
});
type Win = {
  lines: string[];
  events: string[];
  rpc(m: string, p?: unknown): Promise<unknown>;
};
const profile = mkdtempSync(join(tmpdir(), "errors-chrome-"));
let bad = 0;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  for (let i = 0; ; i++) {
    if (
      await fetch(`${EDITOR}/`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (i > 150)
      throw new Error(
        `the dev server didn't come up:\n${await new Response(vite.stderr).text()}`,
      );
    await Bun.sleep(200);
  }
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profile,
  });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${HOST_PORT}/`);
  await page.waitForFunction(
    () => (window as unknown as Win).events.includes("ready"),
    { timeout: 60_000 },
  );
  for (const name of Object.keys(PROGRAMS)) {
    const mark = await page.evaluate(
      () => (window as unknown as Win).lines.length,
    );
    await page.evaluate(
      (entry: string) => (window as unknown as Win).rpc("run", { entry }),
      name,
    );
    await page
      .waitForFunction(
        (n: number) =>
          (window as unknown as Win).lines
            .slice(n)
            .some((l) => l.startsWith("[exited with")),
        { timeout: 30_000 },
        mark,
      )
      .catch(() => {});
    const got = lines(
      (
        await page.evaluate(
          (n: number) => (window as unknown as Win).lines.slice(n),
          mark,
        )
      )
        .join("\n")
        .replace(/\x1b\[[0-9;]*m/g, ""),
    );
    const i = got.findIndex((l, k) => l !== want[name][k]);
    if (i < 0 && got.length === want[name].length)
      console.log(`✓ ${name}: ${got.length} lines`);
    else {
      bad++;
      const k = i < 0 ? Math.min(got.length, want[name].length) : i;
      console.error(
        `✗ ${name} line ${k + 1}\n  got  ${JSON.stringify(got[k])}\n  want ${JSON.stringify(want[name][k])}`,
      );
      if (process.env.DEBUG)
        console.error(
          `--- got\n${got.join("\n")}\n--- want\n${want[name].join("\n")}`,
        );
    }
  }
} finally {
  await browser?.close();
  host.stop(true);
  vite.kill();
  rmSync(profile, { recursive: true, force: true });
}
if (bad) process.exit(1);
