#!/usr/bin/env bun
// A workspace monorepo installs and runs in the playground (src/install.ts, lockfile.ts, workspaces.ts), end to end in
// headless Chrome: the project is sent to the embed, which installs (a workspace package copied into node_modules, a
// dependency one workspace needs its own version of in that workspace's node_modules) and runs an app that imports a
// workspace package and an npm package. The bun.lock it wrote is checked too. The expected lines are what native Bun prints
// for the same project (run with `bun` in a temp folder, unless --no-native). Needs the network (registry.npmjs.org).
//   bun scripts/workspaces.ts [--no-native]
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";
import { nativeEnv } from "./native-env";

const app = join(import.meta.dir, "..");
const PORT = 5280;
const HOST_PORT = 5281;
const EDITOR = `http://localhost:${PORT}`;
const ENTRY = "packages/app/main.ts";

// A registry of its own that wants a token, for `@types` (the project's .npmrc names it and the token): a process of its
// own, as native Bun is run with this script blocked.
const registry = Bun.spawn(["bun", join(import.meta.dir, "test-registry.ts"), "--auth"], { stdout: "pipe", stderr: "inherit" });
process.on("exit", () => registry.kill());
const REGISTRY = `http://localhost:${Number((await registry.stdout.getReader().read().then((r) => new TextDecoder().decode(r.value))).match(/port (\d+)/)![1])}`;

const files: Record<string, string> = {
  ".npmrc": `@types:registry=${REGISTRY}/\n//${REGISTRY.slice("http://".length)}/:_authToken=secret\n`,
  "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"], catalog: { ms: "^2.1.3" }, overrides: { ms: "2.1.2" } }),
  "packages/shared/package.json": JSON.stringify({ name: "@mono/shared", version: "1.0.0", main: "index.ts", dependencies: { "is-odd": "^3.0.0" } }),
  "packages/shared/index.ts": `import isOdd from "is-odd";\nimport { version } from "is-odd/package.json";\nexport const odd = (n: number) => isOdd(n);\nexport const oddVersion = version;\n`,
  "packages/ui/package.json": JSON.stringify({ name: "@mono/ui", version: "0.2.0", dependencies: { "@mono/shared": "workspace:^" } }),
  "packages/ui/index.ts": `import { odd } from "@mono/shared";\nexport const label = (n: number) => (odd(n) ? "odd" : "even") + ":" + n;\n`,
  "packages/app/package.json": JSON.stringify({
    name: "app",
    version: "1.0.0",
    dependencies: { "@mono/ui": "workspace:*", "@mono/shared": "workspace:*", ms: "catalog:", "is-odd": "^0.1.2", "@types/ms": "^0.7.0" },
  }),
  [ENTRY]: `import { label } from "@mono/ui";
import { oddVersion } from "@mono/shared";
import ms from "ms";
import { version as msVersion } from "ms/package.json";
import { version as appOdd } from "is-odd/package.json";
import { version as typesMs } from "@types/ms/package.json";
console.log("label:", label(3), label(4));
console.log("ms:", ms("2 days"), msVersion);
console.log("shared is-odd:", oddVersion.split(".")[0]);
console.log("app is-odd:", appOdd.split(".")[0] + "." + appOdd.split(".")[1]);
console.log("types/ms:", typesMs.split(".").slice(0, 2).join("."));
console.log("__end__");
`,
};

const EXPECTED = ["label: odd:3 even:4", "ms: 172800000 2.1.2", "shared is-odd: 3", "app is-odd: 0.1", "types/ms: 0.7", "__end__"];
let bad = 0;
const compare = (label: string, got: string[]) => {
  const wrong = EXPECTED.length !== got.length || EXPECTED.some((l, i) => l !== got[i]);
  if (!wrong) return console.log(`✓ ${label}: ${got.length} lines`);
  bad++;
  console.error(`✗ ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(EXPECTED)}`);
};
const write = (dir: string, project: Record<string, string>) => {
  for (const [p, text] of Object.entries(project)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
};

let native: string | undefined;
if (!process.argv.includes("--no-native")) {
  const dir = mkdtempSync(join(tmpdir(), "ws-run-"));
  try {
    write(dir, files);
    const install = Bun.spawnSync(["bun", "install", "--ignore-scripts"], { cwd: dir, stderr: "pipe", env: nativeEnv() });
    if (install.exitCode) throw new Error(`native bun install: ${install.stderr}`);
    native = readFileSync(join(dir, "bun.lock"), "utf8");
    const r = Bun.spawnSync(["bun", ENTRY], { cwd: dir, env: nativeEnv() });
    compare("native bun", r.stdout.toString().trim().split("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-workspaces") },
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
      { headers: { "content-type": "text/html" } },
    ),
});
const profile = mkdtempSync(join(tmpdir(), "workspaces-"));
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
    // Run installs first: the workspaces' dependencies are missing.
    await page.evaluate((entry: string) => (window as unknown as W).rpc("run", { entry }), ENTRY);
    await page.waitForFunction(() => (window as unknown as W).lines.some((l) => l.includes("__end__") || /^error/i.test(l)), { timeout: 90_000 }).catch(() => {});
    await Bun.sleep(300);
    const all = await page.evaluate(() => (window as unknown as W).lines);
    const start = all.findIndex((l) => l.startsWith("label:"));
    const got = start < 0 ? all : all.slice(start, all.indexOf("__end__", start) + 1 || undefined).filter((l) => l.trim() !== "");
    compare("playground", got);
    if (start < 0) console.error(all.join("\n"));
    // A workspace's source edited after the install: its copy in node_modules follows, so the next run sees it.
    const mark = all.length;
    await page.evaluate(() => (window as unknown as W).rpc("writeFile", { path: "packages/ui/index.ts", text: `import { odd } from "@mono/shared";\nexport const label = (n: number) => (odd(n) ? "ODD" : "even") + ":" + n;\n` }));
    await page.evaluate((entry: string) => (window as unknown as W).rpc("run", { entry }), ENTRY);
    await page.waitForFunction((n: number) => (window as unknown as W).lines.slice(n).some((l) => l.includes("__end__")), { timeout: 30_000 }, mark).catch(() => {});
    const again = (await page.evaluate(() => (window as unknown as W).lines)).slice(mark).filter((l) => l.startsWith("label:"));
    if (again[0] === "label: ODD:3 even:4") console.log("✓ an edit in a workspace reaches the next run");
    else (bad++, console.error(`✗ edit in a workspace\n  got  ${JSON.stringify(again)}\n  want ["label: ODD:3 even:4"]`));
    // The bun.lock the install wrote is the one native Bun wrote.
    const lock = await page.evaluate(() => (window as unknown as W).rpc("readFile", { path: "bun.lock" })).catch(() => undefined);
    if (native === undefined) console.log("- bun.lock not compared (--no-native)");
    else if (lock === native) console.log("✓ bun.lock identical to native bun install's");
    else (bad++, console.error(`✗ bun.lock differs from native bun install's\n${lock}`));
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
