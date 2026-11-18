#!/usr/bin/env bun
// zstd and brotli in the browser (crates/compress-wasm, src/worker/compress.ts, node/zlib.ts), end to end: the project in
// fixtures/compress runs in the embed in headless Chrome and prints what Bun.zstd*, node:zlib's brotli and zstd and
// CompressionStream do. The expected lines are what native Bun prints for the same project. Native-compressed data
// (native.json, made here with native Bun) must decompress in the playground; what the playground compresses (the
// BLOB lines: the encoders differ, so the bytes do) must decompress in native Bun.
//   bun scripts/compress.ts [--no-native]
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import puppeteer from "puppeteer-core";
import { corpus, LEVELS, QUALITIES } from "../fixtures/compress/corpus.ts";
import { nativeEnv } from "./native-env";

const app = join(import.meta.dir, "..");
const dir = join(app, "fixtures/compress");
const PORT = 5270;
const HOST_PORT = 5271;
const EDITOR = `http://localhost:${PORT}`;

const data = corpus();
const nativeJson = JSON.stringify({
  zstd: Object.fromEntries(
    Object.entries(data).map(([name, bytes]) => [
      name,
      Object.fromEntries(LEVELS.filter((l) => l <= 9 || bytes.length <= 100_000).map((level) => [level, Buffer.from(Bun.zstdCompressSync(bytes, { level })).toString("base64")])),
    ]),
  ),
  brotli: Object.fromEntries(
    Object.entries(data).map(([name, bytes]) => [
      name,
      Object.fromEntries(QUALITIES.map((q) => [q, zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q } }).toString("base64")])),
    ]),
  ),
});
const files: Record<string, string> = { "native.json": nativeJson };
for (const f of readdirSync(dir)) files[f] = readFileSync(join(dir, f), "utf8");

let bad = 0;
const programLines = (lines: string[]) => lines.filter((l) => l.trim() !== "" && !l.startsWith("BLOB "));
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

/** What `BLOB kind name arg base64` lines say the playground compressed, decoded with native Bun. */
function checkBlobs(lines: string[]) {
  let n = 0;
  for (const line of lines.filter((l) => l.startsWith("BLOB "))) {
    const [, kind, name, arg, b64] = line.split(" ");
    const packed = Buffer.from(b64, "base64");
    const want = name === "mixed" || kind.startsWith("stream") ? data.mixed : data[name];
    try {
      const back = kind.endsWith("zstd") ? Bun.zstdDecompressSync(packed) : zlib.brotliDecompressSync(packed);
      if (Buffer.compare(back, want) !== 0) throw new Error("decompressed to different bytes");
      n++;
    } catch (e) {
      bad++;
      console.error(`✗ native Bun can't read the playground's ${kind} ${name} ${arg}: ${(e as Error).message}`);
    }
  }
  if (!n) (bad++, console.error("✗ no BLOB lines from the playground"));
  else console.log(`✓ native Bun decompresses ${n} outputs of the playground's encoders`);
}

let expected: string[] = [];
{
  const work = mkdtempSync(join(tmpdir(), "compress-"));
  try {
    for (const [p, text] of Object.entries(files)) writeFileSync(join(work, p), text);
    const r = Bun.spawnSync(["bun", "main.ts"], { cwd: work, env: nativeEnv() });
    const out = r.stdout.toString().trim().split("\n");
    if (r.exitCode !== 0 || out[out.length - 1] !== "__end__") (bad++, console.error(`✗ native bun main.ts failed:\n${r.stderr.toString()}\n${out.slice(-5).join("\n")}`));
    expected = programLines(out);
    checkBlobs(out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
if (process.argv.includes("--no-native")) process.exit(bad ? 1 : 0);

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
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-compress") },
});
// The embedding page, on another origin as a real host is.
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=console" allow="cross-origin-isolated"></iframe>
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
const profile = mkdtempSync(join(tmpdir(), "compress-chrome-"));
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
    if (process.env.DEBUG) page.on("console", (m) => console.error("console", m.text().slice(0, 300)));
    await page.goto(`http://localhost:${HOST_PORT}/`);
    await page.waitForFunction(() => (window as unknown as { events: string[] }).events.includes("ready"), { timeout: 60_000 });
    await page.evaluate((entry: string) => (window as unknown as { rpc: (m: string, p?: unknown) => Promise<unknown> }).rpc("run", { entry }), "main.ts");
    await page.waitForFunction(() => (window as unknown as { lines: string[] }).lines.some((l) => l.includes("__end__") || /^error/.test(l)), { timeout: 120_000 }).catch(() => {});
    await Bun.sleep(300);
    const all = await page.evaluate(() => (window as unknown as { lines: string[] }).lines);
    // The program's own lines (the console also shows the embed's `$ bun main.ts` and such).
    const start = all.findIndex((l) => l.startsWith("zstd native->here"));
    const mine = start < 0 ? all : all.slice(start, all.indexOf("__end__", start) + 1 || undefined);
    compare("playground", programLines(mine), expected);
    if (start >= 0) checkBlobs(mine);
    else console.error(all.join("\n").slice(0, 3000));
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
