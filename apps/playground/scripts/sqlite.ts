#!/usr/bin/env bun
// bun:sqlite in the browser (src/worker/node/sqlite.ts, on SQLite's wasm build) against native Bun: scripts/sqlite/main.ts runs in
// the embed in headless Chrome and prints one line per probe (SQLiteError fields, safeIntegers, Statement.as,
// serialize/deserialize, strict, columnNames, paramsCount, finalize, toString, inTransaction, ...). The expected lines are
// what native Bun prints for the same program (run with `bun` in a temp folder).
//   bun scripts/sqlite.ts [--no-native]
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5250;
const HOST_PORT = 5251;
const EDITOR = `http://localhost:${PORT}`;
const main = readFileSync(join(import.meta.dir, "sqlite/main.ts"), "utf8");
const files: Record<string, string> = { "main.ts": main };

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

const dir = mkdtempSync(join(tmpdir(), "sqlite-"));
let want: string[];
try {
  writeFileSync(join(dir, "main.ts"), main);
  const r = Bun.spawnSync(["bun", "main.ts"], { cwd: dir });
  want = r.stdout.toString().trim().split("\n");
  if (want.at(-1) !== "__end__") throw new Error(`native Bun failed:\n${r.stderr.toString()}`);
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
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-sqlite") },
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
    window.events.push(d.event); if (d.event === "status" || d.event === "error") window.events.push(JSON.stringify(d).slice(0, 300));
    if (d.event === "boot") window.rpc("init", { files });
    if (d.event === "console") window.lines.push(...d.data.text.split("\\n"));
  });
</script>`,
      { headers: { "content-type": "text/html" } },
    ),
});
const profile = mkdtempSync(join(tmpdir(), "sqlite-chrome-"));
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
    type W = { lines: string[]; events: string[]; rpc: (m: string, p?: unknown) => Promise<unknown> };
    await page.waitForFunction(() => (window as unknown as W).events.includes("ready"), { timeout: 60_000 }).catch(async (e) => {
      console.error("events:", await page.evaluate(() => (window as unknown as W).events));
      throw e;
    });
    await page.evaluate((entry: string) => (window as unknown as W).rpc("run", { entry }), "main.ts");
    await page.waitForFunction(() => (window as unknown as W).lines.some((l) => l === "__end__" || /^error/.test(l)), { timeout: 60_000 }).catch(() => {});
    await Bun.sleep(300);
    const all = await page.evaluate(() => (window as unknown as W).lines);
    // The program's own lines (the console also shows the embed's `$ bun main.ts` and such).
    const start = all.findIndex((l) => l.startsWith("unique "));
    const got = start < 0 ? all : all.slice(start, all.indexOf("__end__", start) + 1 || undefined).filter((l) => l.trim() !== "");
    compare("playground vs native Bun", got, want);
    if (start < 0) console.error(all.join("\n"));
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
