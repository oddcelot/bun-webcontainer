#!/usr/bin/env bun
// The embed's layout (ui/EmbedApp.tsx over @runbun/ui's Tiling) in headless Chrome, against a dev server that is
// already running: where the panes are in each mode, with the options and frame sizes that change the arrangement,
// and that a border, a crossing of borders and the keyboard resize them.
//   bun scripts/embed-layout.ts [url]                (default http://localhost:5173)
//   bun scripts/embed-layout.ts [url] --write <file> (keeps the panes' boxes of every case)
//   bun scripts/embed-layout.ts [url] --compare <file> (and holds them against a kept file: a layout change shows)
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer, { type Frame, type Page } from "puppeteer-core";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const EDITOR = args[0] && !args[0].startsWith("--") ? args[0] : "http://localhost:5173";
const writeTo = flag("--write");
const compareTo = flag("--compare");

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

type Box = { x: number; y: number; w: number; h: number };
type Boxes = Record<string, Box>;
const PANES = { tree: "tree", editor: "editor-pane", preview: "preview-panel", console: "console-wrap" };

/** The shown panes' boxes in the frame. */
const boxes = (frame: Page | Frame) =>
  frame.evaluate((panes) => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const [name, id] of Object.entries(panes)) {
      const el = document.getElementById(id);
      const r = el?.getBoundingClientRect();
      if (!el || !r || !r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
      out[name] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return out;
  }, PANES) as Promise<Boxes>;

/** The same once two readings a moment apart agree (the editor mounts, a fitted frame takes its height). */
async function settled(frame: Page | Frame) {
  let last = "";
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const now = JSON.stringify(await boxes(frame).catch(() => ({})));
    if (now === last && now !== "{}") return JSON.parse(now) as Boxes;
    last = now;
  }
  return JSON.parse(last || "{}") as Boxes;
}

/** The frame as the page (`w` by `h`), or in a `<bun-playground height="auto">` (`auto`: the frame fits its content). */
type Case = { name: string; query: string; w: number; h: number; auto?: boolean };
const CASES: Case[] = [
  { name: "code", query: "mode=code", w: 800, h: 400 },
  { name: "code, files", query: "mode=code&features=files", w: 900, h: 400 },
  { name: "console", query: "mode=console", w: 900, h: 500 },
  { name: "preview", query: "mode=preview", w: 900, h: 500 },
  { name: "preview, console", query: "mode=preview&features=console", w: 900, h: 500 },
  { name: "full", query: "mode=full", w: 1100, h: 600 },
  { name: "full, no preview", query: "mode=full&features=-preview", w: 1100, h: 600 },
  { name: "result", query: "mode=result", w: 800, h: 500 },
  { name: "result, console", query: "mode=result&features=console", w: 800, h: 500 },
  { name: "narrow: code, files", query: "mode=code&features=files", w: 500, h: 500 },
  { name: "narrow: preview", query: "mode=preview", w: 500, h: 600 },
  { name: "narrow: full", query: "mode=full", w: 500, h: 700 },
  { name: "stack: preview", query: "mode=preview&layout=stack", w: 900, h: 700 },
  { name: "stack: preview, console", query: "mode=preview&layout=stack&features=console", w: 900, h: 700 },
  { name: "stack: console", query: "mode=console&layout=stack", w: 900, h: 600 },
  { name: "stack: full, roomy", query: "mode=full&layout=stack", w: 1000, h: 800 },
  { name: "stack: full", query: "mode=full&layout=stack", w: 700, h: 800 },
  { name: "stack: narrow", query: "mode=full&layout=stack", w: 500, h: 800 },
  { name: "fit: code", query: "mode=code", w: 800, h: 0, auto: true },
  { name: "fit: stack preview", query: "mode=preview&layout=stack&file=util.ts", w: 800, h: 0, auto: true },
  { name: "fit: stack preview, console", query: "mode=preview&layout=stack&features=console&file=util.ts", w: 800, h: 0, auto: true },
  { name: "fit: stack console", query: "mode=console&layout=stack&file=util.ts", w: 800, h: 0, auto: true },
];

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
try {
  const errors: string[] = [];
  const open = async (c: Case): Promise<{ page: Page; frame: Page | Frame }> => {
    const page = await browser.newPage();
    // The element's page here has no origin (setContent), which the preview's host page objects to; nothing runs in these cases.
    page.on("pageerror", (e) => /not a configured editor origin/.test(e.message) || errors.push(`${c.name}: ${e.message}`));
    await page.setViewport({ width: c.w, height: c.h || 900 });
    if (!c.auto) {
      await page.goto(`${EDITOR}/embed?example=demo&autorun=false&${c.query}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#embed-main", { timeout: 60000 });
      return { page, frame: page };
    }
    // An element sizing its frame to what the embed asks for.
    const attrs = [...new URLSearchParams(c.query)].map(([k, v]) => `${k}="${v}"`).join(" ");
    await page.goto(`${EDITOR}/host.html`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.setContent(
      `<!doctype html><body style="margin:0"><script type="module" src="${EDITOR}/embed.js"></script>
       <bun-playground src="${EDITOR}/" example="demo" autorun="false" load="eager" height="auto" ${attrs} style="display:block;width:${c.w}px"></bun-playground>`,
    );
    let frame: Frame | undefined;
    for (let i = 0; i < 240 && !frame; i++) {
      await new Promise((r) => setTimeout(r, 250));
      frame = page.frames().find((f) => f.url().includes("/embed?"));
    }
    if (!frame) throw new Error(`${c.name}: no embed frame`);
    await frame.waitForSelector("#embed-main", { timeout: 60000 });
    return { page, frame };
  };

  const all: Record<string, Boxes> = {};
  for (const c of CASES) {
    const { page, frame } = await open(c);
    all[c.name] = await settled(frame);
    report(c.name, Object.keys(all[c.name]).length > 0, all[c.name]);
    await page.close();
  }

  if (writeTo) writeFileSync(writeTo, JSON.stringify(all, null, 2));
  if (compareTo) {
    const kept = JSON.parse(readFileSync(compareTo, "utf8")) as Record<string, Boxes>;
    for (const c of CASES) {
      const [a, b] = [kept[c.name] ?? {}, all[c.name]];
      const off: string[] = [];
      for (const pane of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!a[pane] || !b[pane]) off.push(`${pane}: ${a[pane] ? "gone" : "new"}`);
        else for (const k of ["x", "y", "w", "h"] as const) if (Math.abs(a[pane][k] - b[pane][k]) > 2) off.push(`${pane}.${k}: ${a[pane][k]} → ${b[pane][k]}`);
      }
      report(`as kept: ${c.name}`, !off.length, off.length ? off : "same");
    }
  }

  // The borders: full mode has three (tree | editor | preview over console) and one crossing.
  {
    const { page } = await open({ name: "borders", query: "mode=full", w: 1100, h: 600 });
    const start = await settled(page);
    const handles = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("#embed-main [data-tiling-handle]")].map((el) => {
          const r = el.getBoundingClientRect();
          return { label: el.getAttribute("aria-label") ?? "", x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }),
      );
    const at = async (label: string) => (await handles()).find((h) => h.label === label)!;
    const drag = async (from: { x: number; y: number }, dx: number, dy: number) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 3 });
      await page.mouse.move(from.x + dx, from.y + dy, { steps: 3 });
      await page.mouse.up();
      return settled(page);
    };
    const labels = (await handles()).map((h) => h.label).sort();
    report("a labelled separator per border", labels.join() === "Resize editor and preview,Resize file tree,Resize preview and console", labels);

    let now = await drag(await at("Resize file tree"), 50, 0);
    report("a drag widens the tree", now.tree.w === start.tree.w + 50 && now.editor.x === start.editor.x + 50, { tree: [start.tree.w, now.tree.w] });

    const before = now;
    const crossing = await page.evaluate(() => {
      const r = document.querySelector("#embed-main [data-tiling-crossing]")?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    if (crossing) now = await drag(crossing, 40, 30);
    report("the crossing drags both borders", !!crossing && now.editor.w === before.editor.w + 40 && now.preview.h === before.preview.h + 30, { editor: [before.editor.w, now.editor.w], preview: [before.preview.h, now.preview.h] });

    const rowsBefore = now.preview.h;
    await page.evaluate(() => document.querySelector<HTMLElement>('#embed-main [aria-label="Resize preview and console"]')!.focus());
    await page.keyboard.press("ArrowDown");
    now = await settled(page);
    report("an arrow key moves the focused border", now.preview.h === rowsBefore + 16, [rowsBefore, now.preview.h]);

    // The tree keeps its pixels as the frame grows; the shares follow it.
    await page.setViewport({ width: 1300, height: 600 });
    const wide = await settled(page);
    report("a wider frame leaves the tree's width", wide.tree.w === now.tree.w && wide.editor.w > now.editor.w, { tree: wide.tree.w, editor: [now.editor.w, wide.editor.w] });
    await page.setViewport({ width: 1100, height: 600 });
    await settled(page);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#embed-main", { timeout: 60000 });
    const kept = await settled(page);
    report("a reload keeps the sizes", JSON.stringify(kept) === JSON.stringify(now), { kept, now });

    const tree = await at("Resize file tree");
    await page.mouse.click(tree.x, tree.y, { count: 2 });
    now = await settled(page);
    report("a double click goes back to the usual", now.tree.w === start.tree.w, now.tree.w);

    // The frame narrowing lays the panes out again: stacked, the tree a drawer over the editor from its button.
    await page.setViewport({ width: 500, height: 700 });
    const narrow = await settled(page);
    report("a narrow frame stacks the panes", !narrow.tree && narrow.preview.y > narrow.editor.y && narrow.console.y > narrow.preview.y && narrow.editor.w === narrow.preview.w, narrow);
    await page.click("#embed .controls .files");
    const drawer = await settled(page);
    report("the tree opens as a drawer over the editor", !!drawer.tree && drawer.tree.x === drawer.editor.x && drawer.tree.y > drawer.editor.y && drawer.tree.y + drawer.tree.h <= drawer.editor.y + drawer.editor.h + 1 && drawer.editor.w === narrow.editor.w, drawer);
    await page.keyboard.press("Escape");
    report("Escape closes it", !(await settled(page)).tree, "closed");
    await page.setViewport({ width: 1100, height: 600 });
    const back = await settled(page);
    report("and a wide one puts them side by side again", JSON.stringify(back) === JSON.stringify(now), back);
    await page.close();
  }

  report("no page errors", !errors.length, errors);
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
