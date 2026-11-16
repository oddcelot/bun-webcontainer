#!/usr/bin/env bun
// AsyncLocalStorage across await, timers, promise callbacks and Bun.serve (src/worker/node/asyncHooks.ts, the source
// pass in src/asyncAwait.ts), end to end: scripts/als/main.ts runs in the embed in headless Chrome and prints where
// each callback saw which store; the lines must equal what native Bun prints for the same project.
//   bun scripts/als.ts [--no-native]
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5320;
const HOST_PORT = 5321;
const EDITOR = `http://localhost:${PORT}`;
const dirOf = join(import.meta.dir, "als");
const files: Record<string, string> = Object.fromEntries(readdirSync(dirOf).map((f) => [f, readFileSync(join(dirOf, f), "utf8")]));

let bad = 0;
const compare = (label: string, got: string[], want: string[]) => {
  let wrong = 0;
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] === want[i]) continue;
    wrong++;
    console.error(`✗ ${label} line ${i + 1}\n  got  ${JSON.stringify(got[i]?.slice(0, 300))}\n  want ${JSON.stringify(want[i])}`);
  }
  bad += wrong;
  if (!wrong) console.log(`✓ ${label}: ${got.length} lines`);
};

// Native Bun: the expectations are its behavior.
const dir = mkdtempSync(join(tmpdir(), "als-"));
const expected: Record<string, string[]> = {};
try {
  for (const [p, text] of Object.entries(files)) writeFileSync(join(dir, p), text);
  const install = Bun.spawnSync(["bun", "install"], { cwd: dir });
  if (install.exitCode) throw new Error(`bun install failed:\n${install.stderr.toString()}`);
  for (const entry of ["main.ts", "serve.ts", "hono.ts"]) {
    const r = Bun.spawnSync(["bun", entry], { cwd: dir });
    expected[entry] = r.stdout.toString().trim().split("\n");
    if (!expected[entry].includes("__end__")) throw new Error(`native bun failed:\n${r.stderr.toString()}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

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
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-als") },
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
      { headers: { "content-type": "text/html" } },
    ),
});
const profile = mkdtempSync(join(tmpdir(), "als-chrome-"));
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
    type W = { rpc: (m: string, p?: unknown) => Promise<unknown>; lines: string[] };
    /** Runs `entry`, after `ready` ran, and returns the lines it printed (up to __end__). */
    const run = async (entry: string, ready?: () => Promise<void>) => {
      const before = await page.evaluate(() => (window as unknown as W).lines.length);
      await page.evaluate((entry: string) => (window as unknown as W).rpc("run", { entry }), entry);
      await ready?.();
      await page
        .waitForFunction((n: number) => (window as unknown as W).lines.slice(n).some((l) => l.includes("__end__") || /^error/.test(l)), { timeout: 60_000 }, before)
        .catch(() => {});
      await Bun.sleep(300);
      const all = (await page.evaluate(() => (window as unknown as W).lines)).slice(before);
      // The program's own lines (the console also shows the embed's `$ bun main.ts` and such).
      const start = all.findIndex((l) => /^[\w.-]+=/.test(l));
      if (start < 0 && !all.includes("__end__")) console.error(all.join("\n"));
      return start < 0 ? all : all.slice(start, all.indexOf("__end__", start) + 1 || undefined).filter((l) => l.trim() !== "");
    };
    compare("main.ts", await run("main.ts"), expected["main.ts"]);
    // A program can't fetch its own server here: the page does, as preview requests, from a frame of the origin
    // whose service worker serves previews. Native Bun's program prints the bodies it fetched among its lines.
    const bodies: string[] = [];
    const served = await run("serve.ts", async () => {
      const frame = page.frames().find((f) => f.url().startsWith(EDITOR + "/") && !f.url().includes("/__preview"))!;
      const get = (p: string) => frame.evaluate((p) => fetch("/__preview" + p).then((r) => r.text()), p);
      for (let i = 0; i < 100 && (await get("/ping").catch(() => "")) !== "pong"; i++) await Bun.sleep(200);
      bodies.push(await get("/ctx"));
      bodies.push(...(await Promise.all(["/x", "/y", "/z"].map(get))));
      await get("/done");
    });
    const lines = [...served.filter((l) => l !== "__end__"), `bodies=${bodies.join(",")}`].sort();
    compare("serve.ts", [...lines, "__end__"], expected["serve.ts"]);
    // Hono's context storage, from the registry (the run installs it first).
    const honoBodies: string[] = [];
    const hono = await run("hono.ts", async () => {
      const frame = page.frames().find((f) => f.url().startsWith(EDITOR + "/") && !f.url().includes("/__preview"))!;
      const get = (p: string) => frame.evaluate((p) => fetch("/__preview" + p).then(async (r) => `${await r.text()} [${r.headers.get("x-after")}]`), p);
      for (let i = 0; i < 300 && !(await get("/ping").catch(() => "")).startsWith("pong"); i++) await Bun.sleep(200);
      honoBodies.push(...(await Promise.all(["/a", "/b", "/c"].map(get))));
      await get("/done");
    });
    compare("hono.ts", [`bodies=${honoBodies.join(" | ")}`, ...hono.filter((l) => l === "__end__")], expected["hono.ts"]);
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
