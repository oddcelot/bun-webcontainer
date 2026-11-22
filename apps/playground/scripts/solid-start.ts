#!/usr/bin/env bun
// Solid's start mode end to end: fixtures/solid-start (`@solidjs/vite-plugin` with `ssr`, `start: { devtools: true }`
// and `serverFunctions`, plus `@solidjs/start-devtools`) is installed from npm and run in the embed in headless Chrome.
// Checks that the preview renders on the server and hydrates, that the devtools toolbar mounts (in the dock), and that a server
// function's POST comes back with what it was sent: the preview's requests reach the in-browser Vite server with the
// Origin and Content-Length a browser sends (runtime.ts serverRequest), without which `@solidjs/web` answers 403 and the
// plugin drops the body.
//   bun scripts/solid-start.ts
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import puppeteer, { type Frame } from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5380;
const HOST_PORT = 5381;
const EDITOR = `http://localhost:${PORT}`;
const WANT = '{"currency":"EUR","rate":0.92}';

const fixture = join(app, "fixtures/solid-start");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (name === "node_modules" ? [] : statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const files: Record<string, string> = Object.fromEntries(walk(fixture).map((p) => [relative(fixture, p), readFileSync(p, "utf8")]));

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

let bad = 0;
const report = (name: string, pass: boolean, detail: string) => {
  if (!pass) bad++;
  console.log(`${pass ? "✓" : "✗"} ${name}: ${detail}`);
};

const vite = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true", VITE_CACHE_DIR: join(app, "node_modules/.vite-solid-start") },
});
// The embedding page, on another origin as a real host is.
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:1200px;height:800px" src="${EDITOR}/embed?init=1&mode=full" allow="cross-origin-isolated"></iframe>
<script>
  window.lines = []; window.events = [];
  const files = ${JSON.stringify(files).replace(/</g, "\\u003c")};
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
      { headers: { "content-type": "text/html; charset=utf-8", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" } },
    ),
});

const profile = mkdtempSync(join(tmpdir(), "solid-start-"));
try {
  for (let i = 0; ; i++) {
    if (await fetch(EDITOR).then((r) => r.ok, () => false)) break;
    if (i === 60) throw new Error("the playground's dev server didn't start");
    await Bun.sleep(1000);
  }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
  try {
    const page = await browser.newPage();
    const calls: string[] = [];
    page.on("response", (r) => {
      if (/\/_server\//.test(r.url()) && r.request().method() === "POST") calls.push(String(r.status()));
    });
    await page.goto(`http://localhost:${HOST_PORT}/`);
    await page.waitForFunction(() => (window as any).events.includes("ready"), { timeout: 60_000 });
    const install = await page.evaluate(() => (window as any).rpc("install").then(() => "ok", (e: Error) => e.message));
    report("install", install === "ok", install);
    await page.evaluate(() => (window as any).rpc("run", { entry: "index.ts" }));

    // The preview: the app's frame, once it has hydrated (its button answers) and the toolbar has mounted, in the dock's
    // Devtools tab (ui/Devtools.tsx), not over the page.
    let preview: Frame | undefined;
    for (let i = 0; i < 90 && !preview; i++) {
      const f = page.frames().find((x) => /__preview\/@[^/]+\/$/.test(x.url()));
      const editor = page.frames().find((x) => x.url().startsWith(`${EDITOR}/embed`));
      const docked = await editor?.evaluate(() => !!(document.getElementById("devtools-frame") as HTMLIFrameElement | null)?.contentDocument?.querySelector(".runbun-devtools-host:not([hidden]) [data-solid-dev-toolbar]")).catch(() => false);
      const up = f && docked && (await f.evaluate(() => !!document.querySelector("#inc") && !document.querySelector("[data-solid-dev-toolbar]")).catch(() => false));
      if (up) preview = f;
      else await Bun.sleep(1000);
    }
    const lines = () => page.evaluate(() => (window as any).lines as string[]);
    if (!preview) throw new Error(`the preview never showed the app with its toolbar:\n${(await lines()).join("\n")}`);
    report("devtools toolbar", true, "[data-solid-dev-toolbar] mounted in the dock's Devtools tab");

    await Bun.sleep(1000);
    await preview.click("#inc");
    await preview.click("#inc");
    const count = await preview.evaluate(() => document.querySelector("#inc")?.textContent ?? "");
    report("hydrated", count.includes("count 2"), JSON.stringify(count));

    await preview.click("#rate");
    await preview.waitForFunction(() => document.querySelector("#rate-out")?.textContent, { timeout: 15_000 }).catch(() => {});
    const out = await preview.evaluate(() => document.querySelector("#rate-out")?.textContent ?? "");
    report("server function", out === WANT && calls.length > 0 && calls.every((s) => s === "200"), `POST ${calls.join(", ") || "none"}, returned ${JSON.stringify(out)} (want ${WANT})`);
  } finally {
    await browser.close();
  }
} catch (e) {
  bad++;
  console.log(`✗ ${e instanceof Error ? e.message : e}`);
} finally {
  host.stop(true);
  vite.kill();
  rmSync(profile, { recursive: true, force: true });
}
console.log(bad ? `${bad} failed` : "all checks passed");
process.exit(bad ? 1 : 0);
