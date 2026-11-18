#!/usr/bin/env bun
// `require` in an ES module (Bun's implicit one, and `import.meta.require`) end to end: `require.resolve` (a project file,
// a package, a built-in, a missing one), `.paths`, `.cache` and `.main`, as native Bun prints them. A project runs in the
// embed in headless Chrome; the expected lines are native Bun's (unless --no-native, which prints what the playground did).
//   bun scripts/esm-require.ts [--no-native]   (ports: EDITOR_PORT, HOST_PORT)
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";
import { nativeEnv } from "./native-env";

const app = join(import.meta.dir, "..");
const PORT = 5330;
const HOST_PORT = 5331;
const EDITOR = `http://localhost:${PORT}`;

const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "esm-require" }),
  "x.js": `module.exports = 1;`,
  "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", main: "lib.js" }),
  "node_modules/pkg/lib.js": `module.exports = "pkg";`,
  // Paths print relative to the project folder: native Bun's cwd is a temp dir, the playground's is "/".
  "main.ts": `import "./other.ts";
const root = process.cwd().replace(/\\/$/, "");
const rel = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length) : p);
const tryResolve = (r: NodeJS.Require, s: string) => {
  try { return rel(r.resolve(s)); } catch (e) { return (e as { code?: string }).code ?? String(e); }
};
// @ts-ignore
const imr: NodeJS.Require = import.meta.require;
console.log("resolve:", [tryResolve(require, "./x"), tryResolve(require, "./x.js"), tryResolve(require, "pkg"), tryResolve(require, "node:fs"), tryResolve(require, "fs"), tryResolve(require, "./nope"), tryResolve(require, "nopkg")].join(" "));
console.log("meta:", [tryResolve(imr, "./x"), typeof imr.resolve, typeof imr.resolve.paths, typeof imr.cache].join(" "));
console.log("paths:", [typeof require.resolve.paths, require.resolve.paths("fs"), require.resolve.paths("./x")?.length, require.resolve.paths("pkg")!.length > 0].join(" "));
console.log("cache:", [typeof require.cache, (require("./x"), Object.keys(require.cache).some((k) => k.endsWith("/x.js")))].join(" "));
console.log("main:", [typeof require.main, typeof require.extensions].join(" "));
// Strict mode follows the file's top-level "use strict" (a literal require, and one the worker runs itself).
const strictFiles = ["./strict/s.cjs", "./strict/comment.cjs", "./strict/sloppy.cjs", "./strict/sloppy.ts", "./strict/s.ts", "./strict/s.js"];
console.log("strict literal:", [require("./strict/s.cjs"), require("./strict/comment.cjs"), require("./strict/sloppy.cjs"), require("./strict/sloppy.ts"), require("./strict/s.ts"), require("./strict/s.js")].join(" | "));
for (const f of strictFiles) delete require.cache[require.resolve(f)];
console.log("strict computed:", strictFiles.map((f) => require(f)).join(" | "));
console.log("strict where:", require("./strict/where.ts"), (delete require.cache[require.resolve("./strict/where.ts")], require(["./strict", "where.ts"].join("/"))));
console.log("__end__");
`,
  "other.ts": `console.log("other loaded");`,
  ...strictCases(),
};

/**
 * CommonJS files that report whether they run in strict mode. (Bun also drops a function's "use strict" in a sloppy
 * file, which then runs sloppy; the playground runs plain JavaScript as written, so that one stays strict.)
 */
function strictCases(): Record<string, string> {
  const probe = `const r = [];
try { undeclared = 1; delete globalThis.undeclared; r.push("assign"); } catch (e) { r.push(e.constructor.name); }
r.push((function () { return this === undefined ? "undefined" : this === globalThis ? "global" : typeof this; })());
try { const o = Object.freeze({ a: 1 }); o.a = 2; r.push("frozen"); } catch (e) { r.push(e.constructor.name); }
try { (function () { return arguments.callee; })(); r.push("callee"); } catch (e) { r.push(e.constructor.name); }
module.exports = r.join(",");
`;
  return {
    "strict/s.cjs": `"use strict";\n${probe}`,
    "strict/comment.cjs": `// a comment\n/* and another */\n'use strict';\n${probe}`,
    "strict/sloppy.cjs": probe,
    "strict/sloppy.ts": `// Not "use strict": a comment.\n/* nor "use strict" */\n"use client";\n${probe.replace("const r = []", "const r: string[] = []")}`,
    "strict/s.ts": `"use strict";\n${probe.replace("const r = []", "const r: string[] = []")}`,
    "strict/s.js": `"use strict";\n${probe}`,
    // Its line in a stack trace stays the file's.
    "strict/where.ts": `"use strict";\nconst at: number = 1;\nmodule.exports = String(new Error("here").stack).split("\\n")[1].replace(/^.*\\//, "");\n`,
  };
}

let bad = 0;
const compare = (label: string, got: string[], want: string[]) => {
  let wrong = 0;
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] === want[i]) continue;
    wrong++;
    console.error(`✗ ${label} line ${i + 1}\n  got  ${JSON.stringify(got[i])}\n  want ${JSON.stringify(want[i])}`);
  }
  bad += wrong;
  if (!wrong) console.log(`✓ ${label}: ${got.length} lines`);
};
let expected: string[] = [];
if (!process.argv.includes("--no-native")) {
  const dir = mkdtempSync(join(tmpdir(), "esmreq-"));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    const r = Bun.spawnSync(["bun", "main.ts"], { cwd: dir, env: nativeEnv() });
    expected = r.stdout.toString().trim().split("\n");
    if (r.exitCode) console.error(r.stderr.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const chrome = process.env.CHROME ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}
const vite = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-esm-require") },
});
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
const profile = mkdtempSync(join(tmpdir(), "esmreq-chrome-"));
type W = { events: string[]; lines: string[]; rpc: (m: string, p?: unknown) => Promise<unknown> };
try {
  for (let i = 0; ; i++) {
    if (await fetch(`${EDITOR}/`).then((r) => r.ok, () => false)) break;
    if (i > 150) throw new Error(`the dev server didn't come up:\n${await new Response(vite.stderr).text()}`);
    await Bun.sleep(200);
  }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
  try {
    const page = await browser.newPage();
    if (process.env.DEBUG) page.on("console", (m) => console.error("console", m.text()));
    await page.goto(`http://localhost:${HOST_PORT}/`);
    await page.waitForFunction(() => (window as unknown as W).events.includes("ready"), { timeout: 60_000 });
    await page.evaluate(() => (window as unknown as W).rpc("run", { entry: "main.ts" }));
    await page.waitForFunction(() => (window as unknown as W).lines.some((l) => l.includes("__end__") || /error/i.test(l)), { timeout: 60_000 }).catch(() => {});
    await Bun.sleep(300);
    const all = await page.evaluate(() => (window as unknown as W).lines);
    const start = all.findIndex((l) => l.startsWith("other loaded"));
    const got = (start < 0 ? all : all.slice(start, all.indexOf("__end__", start) + 1 || undefined)).filter((l) => l.trim() !== "");
    if (!expected.length) console.log(got.join("\n"));
    else compare("playground", got, expected);
    if (start < 0) console.error(all.join("\n"));
  } finally {
    await browser.close();
  }
} finally {
  host.stop(true);
  vite.kill();
  await vite.exited;
  rmSync(profile, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
