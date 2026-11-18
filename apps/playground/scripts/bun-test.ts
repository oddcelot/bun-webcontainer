#!/usr/bin/env bun
// `bun:test` (src/worker/node/test.ts) end to end: the test files of fixtures/bun-test run through the console's
// `bun test` in headless Chrome, and native `bun test` runs the same files in a temp folder. What has to agree: the
// summary (pass / fail / skip / todo, expect() calls, tests and files), every failing test's name and error text, and
// the snapshot files the run writes (`__snapshots__/*.snap`, byte for byte). The report's decoration differs (Bun
// prints the source around a failure; the console doesn't) and is dropped on both sides.
// Then fixtures/bun-test-coverage the same way with `--coverage` (src/coverage/): the coverage table and every
// lcov.info the run writes have to be identical too.
//   bun scripts/bun-test.ts [--no-native] [--no-browser]
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const fixtures = join(app, "fixtures/bun-test");
const PORT = Number(process.env.EDITOR_PORT ?? 5220);
const HOST_PORT = Number(process.env.HOST_PORT ?? 5221);
const EDITOR = `http://localhost:${PORT}`;

/** Each step: the arguments of `bun test`, then optional edits to the project before it (path to new text, null removes). */
type Step = { args: string[]; edit?: Record<string, string | null>; env?: Record<string, string>; expectFail?: string[] };
// The snapshots are written in the first step; the second finds them all; `-u` rewrites the files; CI forbids new ones.
const CI_ON = { "runbun.json": JSON.stringify({ env: { CI: "1" } }) };
const STEPS: Step[] = [
  { args: [] },
  { args: [] },
  { args: ["-u"] },
  { args: [], env: { CI: "1" }, edit: { "__snapshots__/snapshot.test.ts.snap": null, ...CI_ON } },
  // Counting what runs changes none of it.
  { args: ["--coverage"], env: { CI: "1" } },
];

// What differs on purpose, by "file :: test": only that it fails on both sides is compared.
const ONLY_FAILS = new Set(["extend.test.ts :: unknown matcher"]);

const read = (dir: string, root = dir): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) Object.assign(out, read(p, root));
    else out[relative(root, p)] = readFileSync(p, "utf8");
  }
  return out;
};
const files = read(fixtures);

// Coverage: the table on its own, the reporters by flag (both forms), then all of bunfig.toml's options (its threshold
// fails the run).
const COVERAGE_BUNFIG = `[test]
coverage = true
coverageReporter = ["text", "lcov"]
coverageDir = "out/cov"
coverageSkipTestFiles = false
coveragePathIgnorePatterns = ["ignored/**"]
coverageThreshold = { lines = 0.95, functions = 0.5 }
`;
const COVERAGE_STEPS: Step[] = [
  { args: ["--coverage"] },
  { args: ["--coverage", "--coverage-reporter", "text", "--coverage-reporter=lcov"] },
  { args: [], edit: { "bunfig.toml": COVERAGE_BUNFIG } },
];
const coverageFiles = read(join(app, "fixtures/bun-test-coverage"));
type Project = { route: string; dir: string; files: Record<string, string>; steps: Step[]; coverage?: boolean };
const PROJECTS: Project[] = [
  { route: "/", dir: fixtures, files, steps: STEPS },
  { route: "/coverage", dir: join(app, "fixtures/bun-test-coverage"), files: coverageFiles, steps: COVERAGE_STEPS, coverage: true },
];

/** The coverage table's lines (separators, header, rows), colors dropped. */
const coverageTable = (lines: string[]) => lines.map(plain).filter((l) => /^-+\|-{9}\|-{9}\|-+$/.test(l) || /^File +\| % Funcs/.test(l) || /\| +[\d.]+ \| +[\d.]+ \|/.test(l));
const isLcov = (p: string) => p.endsWith("lcov.info");

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A run's report reduced to what must agree: the totals, and "file :: test" with the error that failed it. */
function digest(lines: string[]) {
  const failures: string[] = [];
  const summary: string[] = [];
  let file = "";
  let buf: string[] = [];
  let last: number | undefined;
  for (const raw of lines) {
    const line = plain(raw).replace(/\s+\[[\d.]+m?s\]$/, "").replace(/\s+$/, "");
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:\(fail\)|✗) (.*)$/))) {
      failures.push(`${file} :: ${m[1]}\n${buf.join("\n")}`);
      last = failures.length - 1;
      buf = [];
    } else if (last !== undefined && /^\s+\^ /.test(line)) {
      failures[last] += `\n${line.trim()}`;
      last = undefined;
    } else if ((m = line.match(/^(\S+\.(?:test|spec)\.\w+):$/))) {
      file = m[1];
      last = undefined;
    } else if ((m = line.match(/^\s*(\d+ (?:pass|fail|skip|todo|expect\(\) calls))$/))) summary.push(m[1]);
    else if ((m = line.match(/^\s*\d+ snapshots?, (\d+ expect\(\) calls)$/))) summary.push(m[1]);
    else if (/^snapshots: /.test(line)) {
      /* the counts differ a little: not compared */
    }
    else if ((m = line.match(/^Ran (\d+ tests? across \d+ files?)\.?/))) summary.push(m[1].replace("tests ", "test ").replace("files", "file"));
    else if (/^\s*\d+ \|/.test(line) || /^\s+\^+$/.test(line) || /^\s+at /.test(line) || /^(\(pass\)|\(skip\)|\(todo\)|✓|»|✎|bun test v)/.test(line) || !line.trim()) {
      /* decoration */
    } else buf.push(line.trim());
    if (!/^\s+\^ /.test(line) && !/^(?:\(fail\)|✗) /.test(line)) last = undefined;
  }
  failures.sort();
  return { failures, summary };
}

let bad = 0;
function compare(label: string, got: ReturnType<typeof digest>, want: ReturnType<typeof digest>) {
  const before = bad;
  if (JSON.stringify(got.summary) !== JSON.stringify(want.summary)) (bad++, console.error(`✗ ${label}: summary\n  got  ${JSON.stringify(got.summary)}\n  want ${JSON.stringify(want.summary)}`));
  const head = (f: string) => f.split("\n")[0];
  const gotBy = new Map(got.failures.map((f) => [head(f), f]));
  const wantBy = new Map(want.failures.map((f) => [head(f), f]));
  for (const k of new Set([...gotBy.keys(), ...wantBy.keys()])) {
    const g = gotBy.get(k);
    const w = wantBy.get(k);
    if (g === w || (g && w && ONLY_FAILS.has(k))) continue;
    bad++;
    console.error(`✗ ${label}: ${k}\n  got  ${JSON.stringify(g?.split("\n").slice(1).join("\n"))}\n  want ${JSON.stringify(w?.split("\n").slice(1).join("\n"))}`);
  }
  if (bad === before) console.log(`✓ ${label}: ${want.summary.join(", ")}`);
}

/** Files under `dir` as the run left them, `__snapshots__` only. */
const snaps = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([p]) => isTracked(p)));
/** What a run can write: snapshot files, and test files whose inline snapshots it fills in. */
function isTracked(p: string) {
  return p.includes("__snapshots__") || /\.test\.ts$/.test(p);
}

function compareSnaps(label: string, got: Record<string, string>, want: Record<string, string>) {
  const g = snaps(got);
  const w = snaps(want);
  let wrong = 0;
  for (const k of new Set([...Object.keys(g), ...Object.keys(w)])) {
    if (g[k] === w[k]) continue;
    wrong++;
    // Where they part, not the whole files.
    let at = 0;
    while (at < (g[k] ?? "").length && g[k]![at] === (w[k] ?? "")[at]) at++;
    const around = (t: string | undefined) => JSON.stringify(t === undefined ? t : t.slice(Math.max(0, at - 60), at + 120));
    console.error(`✗ ${label}: ${k} (differs at ${at})\n  got  ${around(g[k])}\n  want ${around(w[k])}`);
  }
  bad += wrong;
  if (!wrong && Object.keys(w).length) console.log(`✓ ${label}: ${Object.keys(w).length} file(s) identical`);
}

function applyEdit(project: Record<string, string>, edit?: Step["edit"]) {
  for (const [p, text] of Object.entries(edit ?? {})) if (text === null) delete project[p];
  else project[p] = text;
}

/** The coverage table and lcov files of a run agree with native Bun's. */
function compareCoverage(label: string, lines: string[], have: Record<string, string>, want: { lines: string[]; files: Record<string, string> }) {
  const before = bad;
  const got = coverageTable(lines);
  const expected = coverageTable(want.lines);
  if (JSON.stringify(got) !== JSON.stringify(expected)) (bad++, console.error(`✗ ${label}: coverage table\n  got\n${got.join("\n")}\n  want\n${expected.join("\n")}`));
  const lcovs = new Set([...Object.keys(have), ...Object.keys(want.files)].filter(isLcov));
  for (const p of lcovs) {
    if (have[p] === want.files[p]) continue;
    bad++;
    const g = (have[p] ?? "").split("\n");
    const w = (want.files[p] ?? "").split("\n");
    const at = g.findIndex((l, i) => l !== w[i]);
    console.error(`✗ ${label}: ${p} differs at line ${at + 1}: got ${JSON.stringify(g.slice(at, at + 3))}, want ${JSON.stringify(w.slice(at, at + 3))}`);
  }
  if (bad === before) console.log(`✓ ${label}: coverage table (${expected.length} lines)${lcovs.size ? `, ${[...lcovs].join(", ")}` : ""} identical`);
}

// Native Bun first: the expectations are its behavior.
const native = new Map<Project, { out: ReturnType<typeof digest>; lines: string[]; files: Record<string, string> }[]>();
if (!process.argv.includes("--no-native")) {
  for (const project of PROJECTS) {
    const runs: { out: ReturnType<typeof digest>; lines: string[]; files: Record<string, string> }[] = [];
    native.set(project, runs);
    const dir = mkdtempSync(join(tmpdir(), "bun-test-"));
    try {
      cpSync(project.dir, dir, { recursive: true });
      for (const step of project.steps) {
        for (const [p, text] of Object.entries(step.edit ?? {})) {
          if (text === null) rmSync(join(dir, p), { force: true });
          else (mkdirSync(join(dir, p, ".."), { recursive: true }), writeFileSync(join(dir, p), text));
        }
        const env = { ...process.env, ...step.env, NO_COLOR: "1" } as Record<string, string | undefined>;
        if (!step.env?.CI) delete env.CI;
        const r = Bun.spawnSync(["bun", "test", ...step.args], { cwd: dir, env });
        const lines = (r.stdout.toString() + "\n" + r.stderr.toString()).split("\n");
        runs.push({ out: digest(lines), lines, files: read(dir) });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

if (process.argv.includes("--no-browser")) process.exit(0);

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
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-bun-test") },
});
const host = Bun.serve({
  port: HOST_PORT,
  fetch: (req) =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=console" allow="cross-origin-isolated"></iframe>
<script>
  window.lines = []; window.events = [];
  const files = ${JSON.stringify({ ...PROJECTS.find((p) => p.route === new URL(req.url).pathname)?.files, "index.ts": "" })};
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
type W = { lines: string[]; events: string[]; rpc: (m: string, p?: unknown) => Promise<unknown> };
const profile = mkdtempSync(join(tmpdir(), "bun-test-chrome-"));
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
    for (const project of PROJECTS) {
      await page.goto(`http://localhost:${HOST_PORT}${project.route}`);
      await page.waitForFunction(() => (window as unknown as W).events.includes("ready"), { timeout: 60_000 });
      const embed = page.frames().find((f) => f.url().includes("/embed"))!;
      await Bun.sleep(3000); // the embed runs index.ts after init
      const files = { ...project.files };
      const expected = native.get(project) ?? [];
      for (const [i, step] of project.steps.entries()) {
        for (const [p, text] of Object.entries(step.edit ?? {})) await page.evaluate((path, t) => (window as unknown as W).rpc(t === null ? "removeFile" : "writeFile", { path, text: t }), p, text);
        applyEdit(files, step.edit);
        const mark = (await page.evaluate(() => (window as unknown as W).lines)).length;
        await embed.focus(".xterm-helper-textarea");
        await page.keyboard.type(`bun test ${step.args.join(" ")}\n`);
        await page.waitForFunction((n: number) => (window as unknown as W).lines.slice(n).some((l) => /^Ran \d+ tests? across/.test(l) || /^\[exited with code/.test(l)), { timeout: 60_000 }, mark).catch(() => {});
        await Bun.sleep(300);
        const lines = (await page.evaluate(() => (window as unknown as W).lines)).slice(mark);
        const label = `${project.coverage ? "coverage: " : ""}bun test ${step.args.join(" ")}`.trim();
        const got = digest(lines);
        if (expected[i]) compare(label, got, expected[i].out);
        else console.log(`${label}: ${got.summary.join(", ")}`);
        if (expected[i]) {
          const listed = (await page.evaluate(() => (window as unknown as W).rpc("listFiles"))) as string[];
          const have: Record<string, string> = {};
          for (const p of listed) if (isTracked(p) || isLcov(p)) have[p] = (await page.evaluate((path) => (window as unknown as W).rpc("readFile", { path }), p)) as string;
          if (project.coverage || step.args.includes("--coverage")) compareCoverage(label, lines, have, expected[i]);
          if (!project.coverage) compareSnaps(`${label} snapshots`, have, expected[i].files);
        }
        if (bad && process.env.DEBUG) console.error(lines.join("\n"));
      }
    }
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
