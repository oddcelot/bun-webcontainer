#!/usr/bin/env bun
// Opens every project of the examples submodule (examples/) in the playground in headless Chrome, as a reader would
// (`?example=<name>`), and waits for it to settle: it installs, then runs (a server keeps running, a program exits 0).
// Fails on an error status or a crash. The examples repo's CI only runs them with native Bun; run this before moving
// the submodule to a new commit, and after a Bun upgrade.
//   bun scripts/check-examples.ts                 all of them
//   bun scripts/check-examples.ts starter-react   only these
//   bun scripts/check-examples.ts --preview ...   against a production build (dist-check/, vite preview): what
//                                                 runbun.dev serves, with Vite's worker chunks and inlined assets
//   bun scripts/check-examples.ts --split ...     project code on its own origin (run.runbun.localhost), as on
//                                                 run.runbun.dev: what crosses from the editor's origin to it
//   bun scripts/check-examples.ts --preview --split ...  both: a build for any host, pointed at the two origins by
//                                                 hosting/configure.ts, as a self-hosted copy is
//   bun scripts/check-examples.ts --archive [file.tar.gz] [--split] ...  the self-hosting release archive
//                                                 (playground:release-archive): unpacked elsewhere, configured
//                                                 with its own configure.ts under node, then served
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5199;
/** How long a project may take to install and start (a first install fetches from npm). */
const SETTLE_WITHIN = 90_000;
/** How long the status must hold still to count as settled (installs and runs follow each other). */
const STEADY_FOR = 2_000;

const archiveAt = process.argv.indexOf("--archive");
const archiveArg = process.argv[archiveAt + 1]?.endsWith(".tar.gz") ? process.argv[archiveAt + 1] : undefined;
// Without a path: this version's, as playground:release-archive writes it.
const archive =
  archiveAt < 0 ? undefined : (archiveArg ?? join(app, `dist-release/runbun-playground-${(await Bun.file(join(app, "../../package.json")).json()).version}.tar.gz`));
if (archive && !existsSync(archive)) {
  console.error(`no ${archive}: moon run playground:release-archive`);
  process.exit(1);
}
const preview = process.argv.includes("--preview") || !!archive;
const split = process.argv.includes("--split");
const only = process.argv.slice(2).filter((a) => a !== "--preview" && a !== "--split" && a !== "--archive" && a !== archiveArg);
const names = readdirSync(join(app, "examples"))
  .filter((d) => existsSync(join(app, "examples", d, "package.json")))
  .filter((d) => !only.length || only.includes(d))
  .sort();
if (!names.length) {
  console.error(only.length ? `no such project: ${only.join(", ")}` : "examples/ is empty: git submodule update --init apps/playground/examples");
  process.exit(1);
}

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

// A production build with the default hosting (hosting/load.ts), without runbun.dev's content origin (project code runs
// on this one, as in dev).
let served = join(app, "dist-check");
let unpacked: string | undefined;
if (archive) {
  const dir = (unpacked = mkdtempSync(join(tmpdir(), "check-archive-")));
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", dir], { stdout: "inherit", stderr: "inherit" });
  if (tar.exitCode) process.exit(tar.exitCode);
  const root = join(dir, readdirSync(dir)[0]);
  const file = join(dir, "hosting.json");
  const editor = split ? `http://runbun.localhost:${PORT}` : `http://localhost:${PORT}`;
  await Bun.write(file, JSON.stringify({ ...(split && { contentOrigin: `http://run.runbun.localhost:${PORT}` }), editorOrigins: [editor] }));
  // From the unpacked folder, as its README says: nothing of this repo's.
  const r = Bun.spawnSync(["node", "configure.ts", "dist", file], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode) {
    rmSync(dir, { recursive: true, force: true });
    process.exit(r.exitCode);
  }
  served = join(root, "dist");
} else if (preview) {
  const env = { ...process.env, HOSTING: "", VITE_CONTENT_ORIGIN: "", VITE_EDITOR_ORIGINS: "" };
  for (const cmd of [["bun", "scripts/copy-wasm.ts", "--strip"], ["bunx", "tsrs", "-p", "tsconfig.sw.json"], ["bunx", "vite", "build", "--outDir", "dist-check"]]) {
    const r = Bun.spawnSync(cmd, { cwd: app, env, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode) process.exit(r.exitCode);
  }
  // As a self-hosted copy: the built folder pointed at its host afterwards, by the same script (with node, as one would).
  if (split) {
    const file = join(mkdtempSync(join(tmpdir(), "check-hosting-")), "hosting.json");
    await Bun.write(file, JSON.stringify({ contentOrigin: `http://run.runbun.localhost:${PORT}`, editorOrigins: [`http://runbun.localhost:${PORT}`] }));
    const r = Bun.spawnSync(["node", "hosting/configure.ts", "dist-check", file], { cwd: app, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode) process.exit(r.exitCode);
  }
}

// Its output only matters if it doesn't start (it forwards the page's console warnings otherwise).
const viteArgs = preview ? ["preview", "--outDir", served] : [];
const vite = Bun.spawn(["bunx", "vite", ...viteArgs, "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  // Its own optimized-deps cache, so a dev server you have running isn't disturbed (vite.config.ts cacheDir).
  env: {
    ...process.env,
    VITE_CACHE_DIR: join(app, "node_modules/.vite-check"),
    // The same server under two hosts: a different origin, the same site, as runbun.dev and run.runbun.dev are.
    ...(split && { VITE_CONTENT_ORIGIN: `http://run.runbun.localhost:${PORT}`, VITE_EDITOR_ORIGINS: `http://runbun.localhost:${PORT}` }),
  },
});
const profile = mkdtempSync(join(tmpdir(), "check-examples-"));
let failed = 0;
try {
  await waitForServer(`http://localhost:${PORT}/`).catch(async (e) => {
    vite.kill();
    console.error(`${e.message}:\n${await new Response(vite.stdout).text()}${await new Response(vite.stderr).text()}`);
    process.exit(1);
  });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
  try {
    for (const name of names) {
      const page = await browser.newPage();
      const crashes: string[] = [];
      page.on("pageerror", (e) => crashes.push(e instanceof Error ? e.message : String(e)));
      const started = Date.now();
      await page.goto(`http://${split ? "runbun.localhost" : "localhost"}:${PORT}/?example=${name === "demo" ? "" : name}`, { waitUntil: "domcontentloaded" });
      const status = await settled(page);
      const ms = Date.now() - started;
      // What leaves the program running, so the status doesn't show it: a start that timed out (it may still come up),
      // the runtime's channel failing, a worker_threads thread (a wasm binding's) that didn't load.
      const text = await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
      const runtimeError = ["worker start timed out", "worker error:", "failed to load the worker of thread"].find((s) => text.includes(s));
      const bad = !status || status.state === "error" || crashes.length || runtimeError;
      if (bad) failed++;
      console.log(`${bad ? "✗" : "✓"} ${name}: ${status ? status.text : "didn't settle"} (${(ms / 1000).toFixed(1)} s)`);
      if (bad) {
        for (const c of crashes) console.log(`    ${c}`);
        const lines = await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
        if (lines) console.log(`    console: …${lines.slice(-400)}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  vite.kill();
  await vite.exited;
  rmSync(profile, { recursive: true, force: true });
  if (unpacked) rmSync(unpacked, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} of ${names.length} failed` : `\n${names.length} projects run in the browser`);
process.exit(failed ? 1 : 0);

async function waitForServer(url: string) {
  for (let i = 0; i < 100; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    await Bun.sleep(200);
  }
  throw new Error(`the dev server didn't come up at ${url}`);
}

/** The status once it has stopped changing and isn't busy; null if that takes longer than SETTLE_WITHIN. */
async function settled(page: import("puppeteer-core").Page): Promise<{ state: string; text: string } | null> {
  const end = Date.now() + SETTLE_WITHIN;
  let last = "";
  let since = Date.now();
  while (Date.now() < end) {
    const s = await page
      .evaluate(() => {
        const el = document.querySelector<HTMLElement>("#status");
        return el ? { state: el.dataset.state ?? "", text: el.textContent?.trim() ?? "" } : null;
      })
      .catch(() => null);
    const key = JSON.stringify(s);
    if (key !== last) [last, since] = [key, Date.now()];
    else if (s && s.state !== "busy" && Date.now() - since >= STEADY_FOR) return s;
    await Bun.sleep(250);
  }
  return null;
}
