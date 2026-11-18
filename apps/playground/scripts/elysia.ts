#!/usr/bin/env bun
// Elysia 2 as a baseline, end to end: fixtures/elysia2 (an app.ts that uses as much of Elysia 2 and its @elysia/*
// plugins as it can, and a main.ts that starts it and drives every feature over fetch, a WebSocket client,
// `app.handle()` and Eden Treaty, one `label: result` line per case) runs in the embed in headless Chrome after an
// install from npm, and each line must be the one native Bun prints for the same files. Lines are matched by label, so
// what a failing case prints to stderr doesn't shift the rest.
//   bun scripts/elysia.ts [--no-native]
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5360;
const HOST_PORT = 5361;
const EDITOR = `http://localhost:${PORT}`;
const END = "__elysia_end__";

const fixture = join(app, "fixtures/elysia2");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory()
      ? walk(join(dir, name))
      : [join(dir, name)],
  );
const files: Record<string, string> = Object.fromEntries(
  walk(fixture).map((p) => [relative(fixture, p), readFileSync(p, "utf8")]),
);

let bad = 0;
/** `label: result` lines by label (the first `: ` ends the label). */
const byLabel = (lines: string[]) =>
  new Map(
    lines
      .filter((l) => l.includes(": "))
      .map((l) => [l.slice(0, l.indexOf(": ")), l] as const),
  );

// Native Bun: the expectations are its behavior. Its bun.lock goes to the playground too, so both install the same.
let want: string[] = [];
if (!process.argv.includes("--no-native")) {
  const dir = mkdtempSync(join(tmpdir(), "elysia-"));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    const install = Bun.spawnSync(["bun", "install", "--no-progress"], {
      cwd: dir,
    });
    if (install.exitCode)
      throw new Error(`native bun install:\n${install.stderr.toString()}`);
    files["bun.lock"] = readFileSync(join(dir, "bun.lock"), "utf8");
    const r = Bun.spawnSync(["bun", "main.ts"], { cwd: dir, timeout: 120_000 });
    want = r.stdout.toString().trimEnd().split("\n");
    if (want.at(-1) !== END)
      throw new Error(
        `native bun main.ts didn't finish:\n${r.stdout}\n${r.stderr}`,
      );
    want.pop();
    const failed = want.filter((l) => / ! /.test(l.slice(l.indexOf(": "))));
    console.log(
      `✓ native bun: ${want.length} cases${failed.length ? `, ${failed.length} throwing (expected as such):\n  ${failed.join("\n  ")}` : ""}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const chrome =
  process.env.CHROME ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const vite = Bun.spawn(
  ["bunx", "vite", "--port", String(PORT), "--strictPort"],
  {
    cwd: app,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VITE_CACHE_DIR: join(app, "node_modules/.vite-elysia"),
    },
  },
);
// The embedding page, on another origin as a real host is.
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=console" allow="cross-origin-isolated"></iframe>
<script>
  window.lines = []; window.events = [];
  const files = ${JSON.stringify(files).replace(/</g, "\\u003c")};
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
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "credentialless",
        },
      },
    ),
});
type W = {
  lines: string[];
  events: string[];
  rpc: (m: string, p?: unknown) => Promise<unknown>;
};
const profile = mkdtempSync(join(tmpdir(), "elysia-chrome-"));
try {
  for (let i = 0; ; i++) {
    if (
      await fetch(`http://localhost:${PORT}/`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (i > 150)
      throw new Error(
        `the dev server didn't come up:\n${await new Response(vite.stderr).text()}`,
      );
    await Bun.sleep(200);
  }
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profile,
  });
  try {
    const page = await browser.newPage();
    const crashes: string[] = [];
    page.on("pageerror", (e) =>
      crashes.push(e instanceof Error ? e.message : String(e)),
    );
    if (process.env.DEBUG)
      page.on("console", (m) => console.error("console", m.text()));
    await page.goto(`http://localhost:${HOST_PORT}/`);
    await page.waitForFunction(
      () => (window as unknown as W).events.includes("ready"),
      { timeout: 60_000 },
    );

    const installed = await page.evaluate(() =>
      (window as unknown as W).rpc("install").then(
        () => "ok",
        (e: Error) => e.message,
      ),
    );
    if (installed !== "ok") (bad++, console.error(`✗ install: ${installed}`));

    const mark = await page.evaluate(
      () => (window as unknown as W).lines.length,
    );
    await page.evaluate(() =>
      (window as unknown as W).rpc("run", { entry: "main.ts" }),
    );
    // Stderr lines can start with `error:` (a stream that throws is a case), so only the end marker ends the run.
    const finished = await page
      .waitForFunction(
        (n: number, end: string) =>
          (window as unknown as W).lines.slice(n).includes(end),
        { timeout: 240_000 },
        mark,
        END,
      )
      .then(
        () => true,
        () => false,
      );
    await Bun.sleep(300);
    const all = (
      await page.evaluate(() => (window as unknown as W).lines)
    ).slice(mark);
    if (!finished)
      (bad++, console.error(`✗ main.ts didn't print ${END} within 4 minutes`));

    if (want.length) {
      const got = byLabel(all);
      let wrong = 0;
      for (const line of want) {
        const label = line.slice(0, line.indexOf(": "));
        const g = got.get(label);
        if (g === line) continue;
        wrong++;
        console.error(
          `✗ ${label}\n  got  ${g === undefined ? "(missing)" : JSON.stringify(g.slice(label.length + 2, label.length + 402))}\n  want ${JSON.stringify(line.slice(label.length + 2, label.length + 402))}`,
        );
      }
      bad += wrong;
      console.log(
        `${wrong ? "✗" : "✓"} elysia2 fixture: ${want.length - wrong}/${want.length} cases match native Bun`,
      );
      if (!got.size || process.env.DEBUG) console.error(all.join("\n"));
    } else
      console.log(`(no native Bun: printed, not compared)\n${all.join("\n")}`);
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
