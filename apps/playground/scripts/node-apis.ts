#!/usr/bin/env bun
// Node modules native Bun implements and the playground emulates in JavaScript (node:diagnostics_channel, node:sqlite,
// v8, constants, domain, ...), end to end: scripts/node-apis/main.ts runs in the embed in headless Chrome and under
// `bun`, and prints the same lines but for the differences listed in DIFFERENT (see compatibility/node.md).
//   bun scripts/node-apis.ts
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = Number(process.env.EDITOR_PORT ?? 5610);
const HOST_PORT = Number(process.env.HOST_PORT ?? 5611);
const EDITOR = `http://localhost:${PORT}`;

/** Lines where the playground prints something else on purpose: label -> [native Bun, playground]. */
const DIFFERENT: Record<string, [string, string]> = {};

const dir = join(import.meta.dir, "node-apis");
const files: Record<string, string> = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));

let bad = 0;
const labelOf = (line: string) => line.slice(0, line.indexOf(": "));
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

// Native Bun first: the expectations are its behavior.
const native = Bun.spawnSync(["bun", "node-apis/main.ts"], { cwd: import.meta.dir }).stdout.toString().trim().split("\n");
for (const [label, [want]] of Object.entries(DIFFERENT)) {
  const line = native.find((l) => labelOf(l) === label);
  if (line !== `${label}: ${want}`) (bad++, console.error(`✗ native bun ${label}\n  got  ${JSON.stringify(line)}\n  want ${JSON.stringify(`${label}: ${want}`)}`));
}
console.log(`✓ native bun: ${native.length} lines`);
const expected = native.filter((l) => l !== "__end__").map((l) => (DIFFERENT[labelOf(l)] ? `${labelOf(l)}: ${DIFFERENT[labelOf(l)][1]}` : l)).concat("__end__");

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
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-node-apis") },
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
const profile = mkdtempSync(join(tmpdir(), "node-apis-"));
type W = { lines: string[]; events: string[]; rpc: (m: string, p?: unknown) => Promise<unknown> };
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
    await page.waitForFunction(() => (window as unknown as W).events.includes("ready"), { timeout: 60_000 });
    await page.evaluate(() => (window as unknown as W).rpc("run", { entry: "main.ts" }));
    await page.waitForFunction(() => (window as unknown as W).lines.some((l) => l.includes("__end__") || /^error/.test(l)), { timeout: 60_000 }).catch(() => {});
    await Bun.sleep(300);
    const all = await page.evaluate(() => (window as unknown as W).lines);
    // The program's own lines (the console also shows the embed's `$ bun main.ts` and such).
    const start = all.findIndex((l) => l.startsWith("start:"));
    const got = start < 0 ? all : all.slice(start, all.indexOf("__end__", start) + 1 || undefined).filter((l) => l.trim() !== "");
    compare("playground", got, expected);
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
