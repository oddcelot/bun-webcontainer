#!/usr/bin/env bun
// Bun.sql / SQL in the playground (src/worker/sql.ts, on PGlite) against native Bun with a real Postgres, end to end:
// scripts/sql/main.ts runs in the embed in headless Chrome, where the Postgres URL names a database in the tab, and
// prints one line per case. The expected lines are scripts/sql/expected.txt, which is what native Bun prints for the same
// program against Postgres 16 in Docker (`--native` runs it there and checks the file; `--update` rewrites it); the
// lines in DIFFERENT are the ones the playground prints differently on purpose. scripts/sql/persist.ts then runs three
// times in the same project: each run must see the rows of the runs before it (the database is kept in the VFS, and
// written back as the worker ends, by itself or by process.exit).
//   bun scripts/sql.ts [--native] [--update]
// EDITOR_PORT and HOST_PORT pick the dev server's and the embedding page's ports (5410 and 5411); PG_PORT the Docker
// Postgres's (5439), or PG_URL names a Postgres to use instead. Chrome: CHROME=<path to the binary>, else the usual
// install on macOS or Linux.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { nativeEnv } from "./native-env";

const app = join(import.meta.dir, "..");
const PORT = Number(process.env.EDITOR_PORT ?? 5410);
const HOST_PORT = Number(process.env.HOST_PORT ?? 5411);
const EDITOR = `http://localhost:${PORT}`;
const EXPECTED_FILE = join(import.meta.dir, "sql/expected.txt");
const main = readFileSync(join(import.meta.dir, "sql/main.ts"), "utf8");
const persist = readFileSync(join(import.meta.dir, "sql/persist.ts"), "utf8");
const browserOnly = readFileSync(join(import.meta.dir, "sql/browser.ts"), "utf8");
/** Any host works in the playground: a postgres:// URL names a database in the tab. */
const BROWSER_DB = "postgres://postgres:pw@localhost:5432/app";

/** Lines the playground prints differently on purpose: label -> [native Bun, playground]. */
const DIFFERENT: Record<string, [string, string]> = {
  // The playground's connection is one: transactions started together queue (native Bun's pool runs them at once, in any order).
};

let bad = 0;
const labelOf = (line: string) => line.slice(0, line.indexOf(": "));
const compare = (label: string, got: string[], want: string[]) => {
  let wrong = 0;
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] === want[i]) continue;
    wrong++;
    console.error(`✗ ${label} line ${i + 1}\n  got  ${JSON.stringify(got[i]?.slice(0, 400))}\n  want ${JSON.stringify(want[i])}`);
  }
  bad += wrong;
  if (!wrong) console.log(`✓ ${label}: ${got.length} lines`);
};

/** What native Bun prints for the program against a Postgres (PG_URL, or a throwaway Docker container). */
async function native(): Promise<{ main: string[]; persist: string[] }> {
  const pgPort = Number(process.env.PG_PORT ?? 5439);
  const name = `runbun-sql-test-${pgPort}`;
  let url = process.env.PG_URL;
  if (!url) {
    const run = Bun.spawnSync(["docker", "run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=pw", "-e", "POSTGRES_DB=app", "-p", `127.0.0.1:${pgPort}:5432`, "postgres:16"]);
    if (run.exitCode) throw new Error(`docker run failed:\n${run.stderr}`);
    url = `postgres://postgres:pw@127.0.0.1:${pgPort}/app`;
  }
  const dir = mkdtempSync(join(tmpdir(), "sql-"));
  try {
    for (let i = 0; ; i++) {
      const ready = Bun.spawnSync(["bun", "-e", `const { SQL } = require("bun"); const db = new SQL(process.env.CASE_DB); try { await db\`select 1\`; } catch { process.exit(1); } await db.close();`], { env: nativeEnv({ CASE_DB: url }) });
      if (!ready.exitCode) break;
      if (i > 60) throw new Error("Postgres didn't come up");
      await Bun.sleep(500);
    }
    writeFileSync(join(dir, "main.ts"), main);
    writeFileSync(join(dir, "persist.ts"), persist);
    const env = nativeEnv({ CASE_DB: url, DATABASE_URL: url });
    const r = Bun.spawnSync(["bun", "main.ts"], { cwd: dir, env });
    const lines = r.stdout.toString().trim().split("\n");
    if (lines.at(-1) !== "__end__") throw new Error(`native Bun failed:\n${r.stdout}\n${r.stderr}`);
    Bun.spawnSync(["bun", "-e", `const { SQL } = require("bun"); const db = new SQL(process.env.CASE_DB); await db\`drop table if exists persist_kv\`; await db.close();`], { env });
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = Bun.spawnSync(["bun", "persist.ts"], { cwd: dir, env });
      runs.push(...p.stdout.toString().trim().split("\n"));
    }
    return { main: lines, persist: runs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (!process.env.PG_URL) Bun.spawnSync(["docker", "rm", "-f", name]);
  }
}

/** What scripts/sql/browser.ts prints: the playground's own URLs and errors, which native Bun has no equivalent of. */
const BROWSER = [
  'mysql: ["MySQLError",true,"ERR_MYSQL_UNSUPPORTED","mysql:// isn\'t supported in the browser:"]',
  'same database: [{"v":1}]',
  'options: ["elsewhere.example",1234,"scratch","u"]',
  'shared until the last close: [{"v":1}]',
  'memory: {"r":null}',
  'env: ["envdb","x",true]',
  'options object: ["my db/1","bigint"]',
  'slow: 1',
];

const PERSIST = ["persist run 1 [1]", "persist run 2 [1,2]", "persist run 3 [1,2,3]"];

if (process.argv.includes("--native") || process.argv.includes("--update")) {
  const n = await native();
  compare("native persist", n.persist, PERSIST);
  if (process.argv.includes("--update")) {
    writeFileSync(EXPECTED_FILE, n.main.join("\n") + "\n");
    console.log(`wrote ${EXPECTED_FILE}: ${n.main.length} lines`);
  } else compare("native bun vs expected.txt", n.main, readFileSync(EXPECTED_FILE, "utf8").trim().split("\n"));
}
const native_ = readFileSync(EXPECTED_FILE, "utf8").trim().split("\n");
for (const [label, [want]] of Object.entries(DIFFERENT)) {
  const line = native_.find((l) => labelOf(l) === label);
  if (line !== `${label}: ${want}`) (bad++, console.error(`✗ native bun ${label}\n  got  ${JSON.stringify(line)}\n  want ${JSON.stringify(`${label}: ${want}`)}`));
}
const expected = native_.map((l) => (DIFFERENT[labelOf(l)] ? `${labelOf(l)}: ${DIFFERENT[labelOf(l)][1]}` : l));

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const files: Record<string, string> = {
  "main.ts": main,
  "persist.ts": persist,
  "browser.ts": browserOnly,
  "runbun.json": JSON.stringify({ env: { CASE_DB: BROWSER_DB, DATABASE_URL: BROWSER_DB } }),
};

// PREVIEW=<dir>: serve a production build of the app (`vite build --outDir <dir>`) instead of the dev server.
const vite = Bun.spawn(["bunx", "vite", ...(process.env.PREVIEW ? ["preview", "--outDir", process.env.PREVIEW] : []), "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-sql") },
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
const profile = mkdtempSync(join(tmpdir(), "sql-chrome-"));
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
    const lines = () => page.evaluate(() => (window as unknown as W).lines);
    const run = async (entry: string, done: (l: string) => boolean) => {
      const before = (await lines()).length;
      await page.evaluate((e: string) => (window as unknown as W).rpc("run", { entry: e }), entry);
      await page.waitForFunction((n: number, d: string) => (window as unknown as W).lines.slice(n).some((l) => new Function("l", `return (${d})(l)`)(l) || /^error/.test(l)), { timeout: 120_000 }, before, done.toString()).catch(() => {});
      await Bun.sleep(500);
      return (await lines()).slice(before);
    };

    const started = Date.now();
    const out = await run("main.ts", (l) => l === "__end__");
    // The program's own lines (the console also shows the embed's `$ bun main.ts` and such).
    const start = out.findIndex((l) => l.startsWith("create: "));
    const got = start < 0 ? out : out.slice(start, out.indexOf("__end__", start) + 1 || undefined).filter((l) => l.trim() !== "");
    compare("playground vs native Bun", got, expected);
    if (start < 0) console.error(out.join("\n"));
    console.log(`  (${((Date.now() - started) / 1000).toFixed(1)} s, first query included)`);

    const persisted: string[] = [];
    for (let i = 0; i < 3; i++) persisted.push(...(await run("persist.ts", (l) => l.startsWith("persist run "))).filter((l) => l.startsWith("persist run ") || /^error/.test(l)));
    compare("a database kept across runs", persisted, PERSIST);

    const only = await run("browser.ts", (l) => l.startsWith("slow: "));
    const first = only.findIndex((l) => l.startsWith("mysql: "));
    compare("playground-only URLs and errors", first < 0 ? only : only.slice(first).filter((l) => l.trim() !== "" && l !== "__end__"), BROWSER);

    // Not at boot: only a query fetches PGlite. A fresh page that has booted, and run nothing, has not asked for it.
    const idle = await browser.newPage();
    const fetched: string[] = [];
    // (In dev a `?url` import is a small module that exports the URL: not the file.)
    idle.on("request", (r) => /pglite|initdb/.test(r.url()) && !r.url().includes("?import") && fetched.push(r.url()));
    await idle.goto(`http://localhost:${HOST_PORT}/`);
    await idle.waitForFunction(() => (window as unknown as W).events.includes("ready"), { timeout: 60_000 });
    await Bun.sleep(1500);
    await idle.close();
    if (fetched.length) (bad++, console.error(`✗ PGlite fetched at boot: ${fetched.join(", ")}`));
    else console.log("✓ nothing of PGlite is fetched at boot");
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
