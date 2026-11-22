#!/usr/bin/env bun
// The dock under the preview (ui/Dock.tsx) and its Devtools tab (ui/Devtools.tsx, src/previewDevtools.ts), in headless
// Chrome on a dev server of its own with the debugger on:
// - a project without Solid's devtools has the console alone; a run that stops at `debugger;` brings the Debug tab
//   forward, and a failed run the Console tab;
// - solid-start-devtools and solid-ssr-dashboard open on the Devtools tab, with the toolbar in the dock's frame and not
//   over the page; Cmd+K opens its search there (and not the playground's Mod+K), Alt+Shift+D brings the tab back;
//   a second preview tab, and a reload, keep one toolbar shown, the active tab's;
// - in the embed, the tab shows too, and after an edit (Vite reloads a start-mode page for it) the toolbar is back, on
//   the page shown.
// Installs the examples from npm, so it isn't part of `test`.
//   bun scripts/devtools-dock.ts
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import puppeteer, { type Frame, type Page } from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5382;
const HOST_PORT = 5383;
const EDITOR = `http://localhost:${PORT}`;

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

let bad = 0;
const report = (name: string, pass: boolean, detail: unknown) => {
  if (!pass) bad++;
  console.log(`${pass ? "✓" : "✗"} ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

/** What the page shows of the dock: its tabs (the picked one starred), its header, and the devtools' frame. */
const dockState = (page: Page | Frame) =>
  page.evaluate(() => {
    type Host = HTMLElement & { __runbunDocument?: Document };
    const frame = document.getElementById("devtools-frame") as HTMLIFrameElement | null;
    const hosts = [...(frame?.contentDocument?.querySelectorAll<Host>(".runbun-devtools-host") ?? [])];
    const shown = hosts.filter((h) => !h.hidden);
    const previews = [...document.querySelectorAll<HTMLIFrameElement>("iframe.preview-frame")];
    const active = previews.find((f) => !f.hidden);
    return {
      status: document.querySelector("#status")?.textContent?.trim() ?? "",
      tabs: [...document.querySelectorAll("#dock-head [role=tab]")].map((t) => t.textContent!.trim() + (t.getAttribute("aria-selected") === "true" ? "*" : "")),
      label: document.querySelector("#dock-head > .label")?.textContent ?? null,
      debugStatus: document.querySelector("#dock-head .status")?.textContent?.trim() ?? null,
      hosts: hosts.length,
      shown: shown.length,
      shownIsActive: shown.length === 1 && shown[0].__runbunDocument === active?.contentDocument,
      inFrame: !!shown[0]?.querySelector("[data-solid-dev-toolbar]"),
      inPage: !!active?.contentDocument?.querySelector("[data-solid-dev-toolbar]"),
      palette: !!shown[0]?.querySelector("[data-solid-dev-toolbar-palette-layer] *"),
      previewShown: (document.getElementById("preview-panel")?.getBoundingClientRect().height ?? 0) > 40,
    };
  });
type Dock = Awaited<ReturnType<typeof dockState>>;

async function until(page: Page | Frame, done: (s: Dock) => boolean, ms: number): Promise<Dock> {
  let s = await dockState(page);
  for (const end = Date.now() + ms; !done(s) && Date.now() < end; ) {
    await Bun.sleep(500);
    s = await dockState(page).catch(() => s);
  }
  return s;
}

async function press(page: Page, mods: string[], key: string) {
  for (const m of mods) await page.keyboard.down(m as never);
  await page.keyboard.press(key as never);
  for (const m of [...mods].reverse()) await page.keyboard.up(m as never);
  await Bun.sleep(700);
}

/** Replaces the open file's text by typing it (the editor has no other door from outside). */
async function typeFile(page: Page, text: string) {
  await page.click("#editor");
  await press(page, ["Meta"], "a");
  await page.keyboard.type(text);
}

async function fullPlayground(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // A project without the devtools: the console alone, then the debugger's tab.
  await page.goto(`${EDITOR}/?example=demo`, { waitUntil: "domcontentloaded" });
  let s = await until(page, (s) => /^Running/.test(s.status), 120_000);
  report("demo: console alone", s.tabs.length === 0 && s.label === "Console", s);

  await page.click("#debug");
  s = await until(page, (s) => s.tabs.includes("Debug*"), 5_000);
  report("Debug on: its tab forward", s.tabs.join() === "Console,Debug*", s.tabs);
  await page.click('#dock-head [role=tab][data-value="console"]');
  await typeFile(page, "const answer = 42;\ndebugger;\nconsole.log(answer);\n");
  await press(page, ["Meta"], "Enter");
  s = await until(page, (s) => /^Paused/.test(s.debugStatus ?? ""), 30_000);
  report("a pause brings the Debug tab forward", s.tabs.join() === "Console,Debug*" && /^Paused/.test(s.debugStatus ?? ""), { tabs: s.tabs, debug: s.debugStatus });
  await press(page, [], "F8");
  await typeFile(page, "process.exit(3);\n");
  await press(page, ["Meta"], "Enter");
  s = await until(page, (s) => /code 3/.test(s.status), 30_000);
  report("a failed run brings the Console tab forward", s.tabs.join() === "Console*,Debug", { status: s.status, tabs: s.tabs });
  await page.click("#debug");

  for (const example of ["solid-start-devtools", "solid-ssr-dashboard"]) {
    await page.goto(`${EDITOR}/?example=${example}`, { waitUntil: "domcontentloaded" });
    s = await until(page, (s) => s.inFrame, 240_000);
    report(`${example}: the toolbar is in the dock`, s.tabs.join() === "Devtools*,Console" && s.shownIsActive && s.inFrame && !s.inPage, s);
    // Its buttons answer: Solid's event delegation reaches them in the frame.
    const pane = page.frames().find((f) => f.name() === "runbun-devtools")!;
    await pane.click(".runbun-devtools-host:not([hidden]) #solid-dev-toolbar-view-structure");
    await Bun.sleep(500);
    const picked = await pane.evaluate(() => document.querySelector(".runbun-devtools-host:not([hidden]) #solid-dev-toolbar-view-structure")?.getAttribute("aria-selected"));
    // Inspect element toggles: on after one click and off after the next means its handler ran once per click, where
    // Solid delegates the event as well as where previewDevtools has to (a handler run twice leaves it off).
    const inspect = ".runbun-devtools-host:not([hidden]) [aria-label^='Inspect element']";
    const inspecting = () => pane.$eval(inspect, (b) => b.hasAttribute("data-active"));
    await pane.click(inspect);
    await Bun.sleep(500);
    const on = await inspecting();
    await pane.click(inspect);
    await Bun.sleep(500);
    const off = !(await inspecting());
    report(`${example}: a click in the toolbar works, once`, picked === "true" && on && off, { structureSelected: picked, inspectOn: on, inspectOffAgain: off });
  }

  // Keys pressed in the pane: the toolbar's first, the playground's after.
  const pane = page.frames().find((f) => f.name() === "runbun-devtools")!;
  await pane.click("[data-solid-dev-toolbar-dock]", { offset: { x: 400, y: 200 } });
  await press(page, ["Meta"], "k");
  s = await dockState(page);
  report("Cmd+K in the pane opens the toolbar's search", s.palette && s.previewShown, { palette: s.palette, previewShown: s.previewShown });
  await press(page, ["Meta"], "k");
  await page.click('#dock-head [role=tab][data-value="console"]');
  await page.click("#editor");
  await press(page, ["Alt", "Shift"], "KeyD");
  s = await dockState(page);
  report("Alt+Shift+D brings the Devtools tab forward", s.tabs[0] === "Devtools*", s.tabs);

  // Preview tabs: the pane shows the active one's toolbar.
  await page.click("#preview-tabs .add");
  s = await until(page, (s) => s.hosts === 2 && s.shownIsActive, 60_000);
  report("a second preview tab has its own toolbar, shown", s.hosts === 2 && s.shown === 1 && s.shownIsActive, s);
  await page.click("#preview-tabs .tab:first-of-type [role=tab]");
  s = await until(page, (s) => s.shownIsActive, 5_000);
  report("back on the first tab, its toolbar", s.shown === 1 && s.shownIsActive, s);
  const first = page.frames().filter((f) => f.url().includes("/__preview/"))[0];
  await first.evaluate(() => location.reload());
  await Bun.sleep(1000);
  s = await until(page, (s) => s.hosts === 2 && s.shownIsActive, 60_000);
  report("a reload replaces the page's toolbar", s.hosts === 2 && s.shown === 1 && s.shownIsActive, s);
  await page.click("#preview-tabs .tab:last-of-type .close");
  s = await until(page, (s) => s.hosts === 1, 10_000);
  report("closing a preview tab drops its toolbar", s.hosts === 1 && s.shownIsActive, s);
  report("no page errors", errors.length === 0, errors.slice(0, 3).join(" | ") || "none");
}

// The embed: a host page on another origin, as solid-start.ts has it, with the example's files.
const fixture = join(app, "examples/solid-start-devtools");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (name === "node_modules" ? [] : statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const files: Record<string, string> = Object.fromEntries(walk(fixture).map((p) => [relative(fixture, p), readFileSync(p, "utf8")]));

async function embed(page: Page) {
  await page.goto(`http://localhost:${HOST_PORT}/`);
  await page.waitForFunction(() => (window as any).events.includes("ready"), { timeout: 60_000 });
  await page.evaluate(() => (window as any).rpc("install"));
  await page.evaluate(() => (window as any).rpc("run", { entry: "index.ts" }));
  const editor = page.frames().find((f) => f.url().startsWith(`${EDITOR}/embed`))!;
  let s = await until(editor, (s) => s.inFrame, 240_000);
  report("embed: the Devtools tab, with the toolbar", s.tabs[0] === "Devtools*" && s.inFrame && !s.inPage, s);

  const before = await editor.evaluate(() => (document.querySelector("iframe.preview-frame") as HTMLIFrameElement).contentDocument);
  const app = files["src/App.tsx"];
  const edited = app.replace(/<h1>[^<]*<\/h1>/, "<h1>Edited while the devtools watch</h1>");
  if (edited === app) throw new Error("src/App.tsx has no <h1> to edit");
  await page.evaluate((text) => (window as any).rpc("writeFile", { path: "src/App.tsx", text }), edited);
  await editor.waitForFunction(() => (document.querySelector("iframe.preview-frame") as HTMLIFrameElement).contentDocument?.querySelector("h1")?.textContent === "Edited while the devtools watch", { timeout: 30_000 }).catch(() => {});
  const same = await editor.evaluate((doc) => (document.querySelector("iframe.preview-frame") as HTMLIFrameElement).contentDocument === doc && document.querySelector("iframe.preview-frame") !== null, before);
  const h1 = await editor.evaluate(() => (document.querySelector("iframe.preview-frame") as HTMLIFrameElement).contentDocument?.querySelector("h1")?.textContent);
  s = await dockState(editor);
  report("after an edit, the toolbar of the page shown", h1 === "Edited while the devtools watch" && s.shownIsActive && s.inFrame, { h1, reloaded: !same, shownIsActive: s.shownIsActive });
}

const vite = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, DEBUGGER: "1", VITE_CACHE_DIR: join(app, "node_modules/.vite-devtools-dock") },
});
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:1400px;height:900px" src="${EDITOR}/embed?init=1&mode=full" allow="cross-origin-isolated"></iframe>
<script>
  window.events = [];
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
  });
</script>`,
      { headers: { "content-type": "text/html; charset=utf-8", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" } },
    ),
});

const profile = mkdtempSync(join(tmpdir(), "devtools-dock-"));
try {
  for (let i = 0; ; i++) {
    if (await fetch(EDITOR).then((r) => r.ok, () => false)) break;
    if (i === 60) throw new Error("the playground's dev server didn't start");
    await Bun.sleep(1000);
  }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 950 });
    await fullPlayground(page);
    await embed(page);
  } finally {
    await browser.close();
  }
} catch (e) {
  bad++;
  console.log(`✗ ${e instanceof Error ? e.message : e}`);
} finally {
  host.stop(true);
  vite.kill();
  rmSync(profile, { recursive: true, force: true });
}
console.log(bad ? `${bad} failed` : "all checks passed");
process.exit(bad ? 1 : 0);
