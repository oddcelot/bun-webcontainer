#!/usr/bin/env bun
// node:http and node:https clients (src/worker/node/http.ts) end to end: scripts/http-request/main.ts runs in the embed
// in headless Chrome against its own Bun.serve, and its lines must be those native Bun prints for it. With --net it
// also makes a request to a real CORS-enabled host (api.github.com).
// --axios runs http-request/axios.ts instead: axios's node adapter over the same shim (installs axios from npm).
//   bun scripts/http-request.ts [--net] [--axios]
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = Number(process.env.EDITOR_PORT ?? 5210);
const HOST_PORT = Number(process.env.HOST_PORT ?? 5211);
const EDITOR = `http://localhost:${PORT}`;
const NET = process.argv.includes("--net");
const AXIOS = process.argv.includes("--axios");
const entry = AXIOS ? "axios.ts" : "main.ts";
const main = readFileSync(join(import.meta.dir, "http-request", entry), "utf8");

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

const AXIOS_PACKAGE = JSON.stringify({ name: "ax", dependencies: { axios: "1.7.9" } });
const dir = mkdtempSync(join(tmpdir(), "http-request-"));
if (AXIOS) {
  writeFileSync(join(dir, "package.json"), AXIOS_PACKAGE);
  Bun.spawnSync(["bun", "install"], { cwd: dir });
}
const native = (writeFileSync(join(dir, entry), main), Bun.spawnSync(["bun", entry], { cwd: dir, env: { ...process.env, NET: NET ? "1" : "" } }));
rmSync(dir, { recursive: true, force: true });
const want = native.stdout.toString().trim().split("\n");
if (!want.includes("__end__")) (console.error(native.stderr.toString()), process.exit(1));

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
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-http-request") },
});
const files: Record<string, string> = { [entry]: NET ? main.replace("Bun.env.NET", "true") : main };
if (AXIOS) files["package.json"] = AXIOS_PACKAGE;
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
const profile = mkdtempSync(join(tmpdir(), "http-request-chrome-"));
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
    type W = { lines: string[]; events: string[]; rpc: (m: string, p?: unknown) => Promise<unknown> };
    await page.waitForFunction(() => (window as unknown as W).events.includes("ready"), { timeout: 60_000 });
    await page.evaluate((entry: string) => (window as unknown as W).rpc("run", { entry }), entry);
    await page.waitForFunction(() => (window as unknown as W).lines.some((l) => l.includes("__end__") || /^error/.test(l)), { timeout: 60_000 }).catch(() => {});
    await Bun.sleep(300);
    const all = await page.evaluate(() => (window as unknown as W).lines);
    const start = all.indexOf("start");
    const got = (start < 0 ? all : all.slice(start, all.indexOf("__end__", start) + 1 || undefined)).filter((l) => l.trim() !== "");
    compare("playground", got, want);
    if (bad && start < 0) console.error(all.join("\n"));
    for (const c of crashes) (bad++, console.error(`✗ page error: ${c}`));
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
