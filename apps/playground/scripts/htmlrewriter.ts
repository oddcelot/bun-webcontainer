#!/usr/bin/env bun
// `HTMLRewriter` in the playground (src/worker/htmlRewriter.ts over crates/htmlrewriter-wasm), end to end: a project
// runs crates/htmlrewriter-wasm/cases.ts in the embed in headless Chrome, and each case's result must be what native
// Bun gave (crates/htmlrewriter-wasm/expected.json, from gen-expected.ts).
//   bun scripts/htmlrewriter.ts
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const crate = join(app, "../../crates/htmlrewriter-wasm");
const PORT = Number(process.env.EDITOR_PORT ?? 5198);
const HOST_PORT = Number(process.env.HOST_PORT ?? 5197);
const EDITOR = `http://localhost:${PORT}`;

const expected = JSON.parse(readFileSync(join(crate, "expected.json"), "utf8")) as Record<string, unknown>;
const files = {
  "cases.ts": readFileSync(join(crate, "cases.ts"), "utf8"),
  "main.ts": process.env.MAIN_FILE ? readFileSync(process.env.MAIN_FILE, "utf8") : `import { runCases } from "./cases.ts";
void (async () => {
  const results = await runCases(HTMLRewriter as never);
  for (const [name, result] of Object.entries(results)) console.log("R\\t" + name + "\\t" + JSON.stringify(result));
  console.log("__end__");
})();`,
};

// Cases where Chrome's Response, not the rewriter, words an error or orders things differently from Bun's.
const known: Record<string, string> = {};

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const vite = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-htmlrewriter") },
});
// The embedding page, on another origin as a real host is.
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
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ),
});
const profile = mkdtempSync(join(tmpdir(), "htmlrewriter-"));
let bad = 0;
try {
  for (let i = 0; ; i++) {
    if (await fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false)) break;
    if (i > 150) throw new Error(`the dev server didn't come up:\n${await new Response(vite.stderr).text()}`);
    await Bun.sleep(200);
  }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
  try {
    const page = await browser.newPage();
    const crashes: string[] = [];
    page.on("pageerror", (e) => crashes.push(e instanceof Error ? e.message : String(e)));
    if (process.env.DEBUG) page.on("console", (m) => console.error("console", m.text()));
    await page.goto(`http://localhost:${HOST_PORT}/`);
    await page.waitForFunction(() => (window as unknown as { events: string[] }).events.includes("ready"), { timeout: 60_000 });
    await page.evaluate((entry: string) => (window as unknown as { rpc: (m: string, p?: unknown) => Promise<unknown> }).rpc("run", { entry }), "main.ts");
    await page.waitForFunction(() => (window as unknown as { lines: string[] }).lines.some((l) => l.includes("__end__") || /^error/.test(l)), { timeout: 90_000 }).catch(() => {});
    await Bun.sleep(200);
    const lines = await page.evaluate(() => (window as unknown as { lines: string[] }).lines);
    const got: Record<string, unknown> = {};
    for (const line of lines) {
      const [tag, name, json] = line.split("\t");
      if (tag === "R") got[name] = JSON.parse(json);
      else if (process.env.MAIN_FILE) console.log(line);
    }
    if (!lines.includes("__end__")) {
      bad++;
      console.error(`the program did not finish:\n${lines.join("\n")}`);
    }
    for (const name of Object.keys(expected)) {
      try {
        assert.deepEqual(got[name], expected[name]);
      } catch {
        if (known[name]) console.log(`known difference: ${name} (${known[name]})`);
        else (bad++, console.error(`✗ ${name}\n  want ${JSON.stringify(expected[name])}\n  got  ${JSON.stringify(got[name])}`));
      }
    }
    for (const c of crashes) (bad++, console.error(`✗ page error: ${c}`));
    if (!bad) console.log(`✓ ${Object.keys(expected).length} HTMLRewriter cases match native Bun in the playground`);
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
