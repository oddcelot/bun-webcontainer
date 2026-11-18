#!/usr/bin/env bun
// Bun.serve end to end, against native Bun: scripts/serve/server.ts runs in the embed in headless Chrome and its lines
// (loopback fetches of failing handlers, the `error` handler) must be native Bun's; then its preview page runs
// serve/client.ts (default error pages, streams that fail before or after their first chunk, WebSockets: messages both
// ways, pub/sub, close codes) and must see what native Bun's clients see. serve/node.ts does the same for a node:http
// server's "upgrade" accepted with `ws` (not installed: Bun's own).
//   bun scripts/serve.ts
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Frame } from "puppeteer-core";
import { client, nodeClient } from "./serve/client.ts";
import { nativeEnv } from "./native-env";

const app = join(import.meta.dir, "..");
const PORT = Number(process.env.EDITOR_PORT ?? 5460);
const HOST_PORT = Number(process.env.HOST_PORT ?? 5461);
const NATIVE_PORT = Number(process.env.NATIVE_PORT ?? 5462);
const EDITOR = `http://localhost:${PORT}`;
const files = Object.fromEntries(["server.ts", "node.ts"].map((f) => [f, readFileSync(join(import.meta.dir, "serve", f), "utf8")]));

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

/** Runs `entry` with native Bun until it listens: its lines so far, and what `run` (its client) sees. */
async function native(entry: string, run: () => Promise<string[]>): Promise<[string[], string[]]> {
  const dir = mkdtempSync(join(tmpdir(), "serve-"));
  writeFileSync(join(dir, entry), files[entry]);
  const p = Bun.spawn(["bun", entry], { cwd: dir, env: nativeEnv({ SERVE_PORT: String(NATIVE_PORT) }), stdout: "pipe", stderr: "pipe" });
  try {
    let out = "";
    const dec = new TextDecoder();
    for await (const chunk of p.stdout) {
      out += dec.decode(chunk);
      if (out.includes("listening\n")) break;
    }
    if (!out.includes("listening")) throw new Error(`native ${entry} didn't listen:\n${out}\n${await new Response(p.stderr).text()}`);
    return [out.trim().split("\n"), await run()];
  } finally {
    p.kill();
    await p.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}
const nativeHttp = `http://localhost:${NATIVE_PORT}`;
const nativeWs = `ws://localhost:${NATIVE_PORT}`;
const [wantServer, wantClient] = await native("server.ts", () => client(nativeHttp, nativeWs));
const [wantNodeLines, wantNode] = await native("node.ts", () => nodeClient(nativeWs));

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const vite = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "ignore",
  stderr: "pipe",
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-serve") },
});
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=preview"></iframe>
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
    if (d.event === "console" && d.data.level !== "log") console.log("program " + d.data.level + ": " + d.data.text);
    if (d.event === "console" && d.data.level === "log") window.lines.push(...d.data.text.split("\\n"));
  });
</script>`,
      { headers: { "content-type": "text/html" } },
    ),
});
type W = { lines: string[]; events: string[]; rpc: (m: string, p?: unknown) => Promise<unknown> };
const profile = mkdtempSync(join(tmpdir(), "serve-chrome-"));
try {
  for (let i = 0; ; i++) {
    if (await fetch(`${EDITOR}/`).then((r) => r.ok, () => false)) break;
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
    await page.waitForFunction(() => (window as unknown as W).events.includes("ready"), { timeout: 60_000 });

    /**
     * Runs `entry` until it listens (its `listening` line number `n`) and the preview shows its page (titled `title`):
     * its lines, the preview frame and its base.
     */
    const run = async (entry: string, n: number, title: string): Promise<[string[], Frame, string]> => {
      const before = await page.evaluate(() => (window as unknown as W).lines.length);
      await page.evaluate((entry: string) => (window as unknown as W).rpc("run", { entry }), entry);
      await page.waitForFunction((n: number) => (window as unknown as W).lines.filter((l) => l === "listening").length >= n, { timeout: 60_000 }, n);
      const lines = (await page.evaluate(() => (window as unknown as W).lines)).slice(before);
      for (let i = 0; i < 150; i++) {
        const pf = page.frames().find((f) => f.url().startsWith(`${EDITOR}/`) && f.url().includes("/__preview/@") && !f.url().includes("__runbun_cookies__"));
        if (pf && (await pf.evaluate(() => document.title).catch(() => "")) === title) return [lines, pf, new URL(pf.url()).pathname.match(/^.*?\/__preview\/@[^/]+/)![0]];
        await Bun.sleep(100);
      }
      throw new Error(`no preview frame showing ${title}`);
    };
    /** The client's lines, or those it got to if it hangs. */
    const within = (pf: Frame, done: Promise<string[]>) =>
      Promise.race([
        done,
        Bun.sleep(30_000).then(async () => [...(await pf.evaluate(() => (globalThis as { clientLines?: string[] }).clientLines ?? [])), "(timed out)"]),
      ]);
    const [lines, pf, base] = await run("server.ts", 1, "serve");
    compare("server.ts (loopback fetch)", lines, wantServer);
    if (process.env.DEBUG) console.error(await pf.evaluate(() => [location.href, document.title, String(WebSocket).slice(0, 80)]));
    compare("server.ts (preview page)", await within(pf, pf.evaluate(client, base, `ws://localhost:${PORT}${base}`)), wantClient);
    const [nodeLines, pf2, base2] = await run("node.ts", 2, "node");
    compare("node.ts (output)", nodeLines, wantNodeLines);
    compare("node.ts (preview page)", await within(pf2, pf2.evaluate(nodeClient, `ws://localhost:${PORT}${base2}`)), wantNode);
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
