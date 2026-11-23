#!/usr/bin/env bun
// The tiling layout (ui/Tiles.tsx over @runbun/ui's Tiling) in headless Chrome, against a dev server that is already running:
// the panels tile the room, the keyboard (Mod+K, then a key) moves, turns, maximizes, floats and hides them, a drag drops one onto
// another's side, and through all of it the preview's frame never loads again and the layout survives a reload.
//   bun scripts/tiling.ts [url]        (default http://localhost:5173; SHOTS=<dir> keeps a screenshot per step)
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";

const EDITOR = process.argv[2] ?? "http://localhost:5173";
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

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

type Box = { x: number; y: number; w: number; h: number; hidden: boolean; floating: boolean; max: boolean; focused: boolean };
const tiles = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-tiling-root] [data-tiling-tile]")].map((el) => {
        const r = el.getBoundingClientRect();
        const d = el.dataset;
        return [d.tile!, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hidden: "hidden" in d, floating: "floating" in d, max: "maximized" in d, focused: "focused" in d }];
      }),
    ),
  ) as Promise<Record<string, Box>>;
/** After the tiles have glided to their places. */
const settled = async (page: Page) => {
  await page.waitForFunction(() => !document.querySelector("[data-tiling-root][data-animating]"), { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 60));
  return tiles(page);
};
let step = 0;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${String(++step).padStart(2, "0")}-${name}.png`) as `${string}.png` });
};
const chord = async (page: Page, keys: string) => {
  const parts = keys.split("+");
  const key = parts.pop()!;
  const mods = parts.map((m) => (m === "Ctrl" ? "Control" : m)) as ("Control" | "Alt" | "Shift" | "Meta")[];
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key.length === 1 ? (`Key${key}` as "KeyA") : (key as "ArrowLeft"));
  for (const m of mods.reverse()) await page.keyboard.up(m);
};
/** A tiling command by its keys: the panel keys' chord (Mod+K), then the command's key (keymap.ts tileKeyCommand). */
const tileKey = async (page: Page, key: string) => {
  await chord(page, `${process.platform === "darwin" ? "Meta" : "Ctrl"}+K`);
  await chord(page, key);
};
const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
/** No two shown, tiled panels overlap, and none is empty. */
const tiled = (all: Record<string, Box>) => {
  const shown = Object.values(all).filter((b) => !b.hidden && !b.floating);
  return shown.every((a) => a.w > 40 && a.h > 40 && shown.every((b) => a === b || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y));
};

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-first-run", "--window-size=1440,900"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${(e as Error).message}`));
  page.on("console", (m) => {
    // The workspace's own warning (its `readonly` list, read in an effect's apply) is not the layout's.
    if (m.text().includes('"createWorkspace.readonly"')) return;
    if (m.type() === "error" || (m.type() === "warn" && /solid|\[[A-Z_]{6,}\]/i.test(m.text()))) problems.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });

  await page.goto(`${EDITOR}/?example=demo`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-tiling-root] [data-tiling-tile]", { timeout: 60_000 });
  await page.evaluate(() => localStorage.removeItem("layout.tiles"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-tiling-root] [data-tiling-tile] #editor", { timeout: 60_000 });
  let t = await settled(page);
  report("the four panels tile the room", Object.keys(t).length === 4 && tiled(t) && t.files.x < t.editor.x && t.editor.x < t.preview.x && t.preview.y < t.console.y, t);
  await shot(page, "start");

  // Where the editor, the preview and the console meet: one drag moves both borders.
  const crossing = await page.evaluate(() => {
    const all = [...document.querySelectorAll<HTMLElement>("[data-tiling-crossing]")].map((el) => el.getBoundingClientRect());
    return all.map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }));
  });
  if (crossing.length === 1) {
    await page.mouse.move(crossing[0].x, crossing[0].y);
    const lit = await page.evaluate(() => document.querySelectorAll("[data-tiling-handle][data-active]").length);
    await page.mouse.down();
    await page.mouse.move(crossing[0].x + 50, crossing[0].y + 40, { steps: 5 });
    await shot(page, "crossing");
    await page.mouse.up();
    const c = await settled(page);
    report("a crossing drags both borders at once", lit === 2 && tiled(c) && c.editor.w === t.editor.w + 50 && c.preview.h === t.preview.h + 40 && c.console.h === t.console.h - 40 && c.files.w === t.files.w, { lit, editor: [t.editor.w, c.editor.w], preview: [t.preview.h, c.preview.h] });
    await page.mouse.click(crossing[0].x + 50, crossing[0].y + 40, { count: 2 });
    t = await settled(page);
  } else report("a crossing drags both borders at once", false, { crossings: crossing.length });

  // Run, so there is a preview frame to keep alive (the default project needs no install to serve).
  await page.keyboard.down("Meta");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Meta");
  const frame = await page.waitForSelector("#preview-panel iframe", { timeout: 90_000 }).catch(() => null);
  if (frame) {
    await new Promise((r) => setTimeout(r, 4000));
    await page.evaluate(() => {
      const w = window as unknown as { __loads: number };
      w.__loads = 0;
      for (const f of document.querySelectorAll("#preview-panel iframe")) f.addEventListener("load", () => w.__loads++);
    });
  }
  report("a run shows a preview frame", !!frame, frame ? "frame mounted" : "no frame within 90s (the frame checks below are skipped)");
  await shot(page, "ran");

  // Keyboard: focus, move, turn, maximize, float, hide.
  await page.mouse.click(center(t.console).x, center(t.console).y);
  t = await settled(page);
  report("a click focuses the tile", t.console.focused && !t.editor.focused, { console: t.console.focused, editor: t.editor.focused });
  await tileKey(page, "K");
  t = await settled(page);
  report("Mod+K, K focuses the tile above", t.preview.focused, Object.entries(t).filter(([, b]) => b.focused).map(([n]) => n));
  await tileKey(page, "J");
  await tileKey(page, "Shift+H");
  t = await settled(page);
  report("move left: the console becomes a column between editor and preview", tiled(t) && t.console.h === t.editor.h && t.console.x > t.editor.x && t.console.x < t.preview.x, t);
  await shot(page, "console-moved-left");
  await tileKey(page, "Shift+J");
  t = await settled(page);
  report("move down at the edge: the console spans the bottom", tiled(t) && t.console.x === t.files.x && t.console.x + t.console.w === t.preview.x + t.preview.w && t.console.y > t.editor.y, t);
  await shot(page, "console-bottom");
  await tileKey(page, "S");
  t = await settled(page);
  report("turn the split: the console is a full-height column", tiled(t) && t.console.h === t.files.h && t.console.y === t.files.y, t);
  await shot(page, "split-turned");
  await tileKey(page, "F");
  t = await settled(page);
  const room = await page.evaluate(() => {
    const r = document.querySelector("[data-tiling-root]")!.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  report("maximize fills the room", t.console.max && t.console.w >= room.w - 10 && t.console.h >= room.h - 10, { console: t.console, room });
  await shot(page, "maximized");
  await tileKey(page, "F");
  await tileKey(page, "V");
  t = await settled(page);
  report("float lifts the console off the tiles", t.console.floating && tiled(t) && t.editor.w > 0, t);
  await shot(page, "floating");
  await tileKey(page, "V");
  t = await settled(page);
  report("tiled again, beside the tile it was next to", !t.console.floating && tiled(t) && (t.console.x === t.preview.x || t.console.y === t.preview.y), t);
  await tileKey(page, "C");
  t = await settled(page);
  report("hide: the others take the room", t.console.hidden && tiled(t), t);
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyJ");
  await page.keyboard.up("Meta");
  t = await settled(page);
  report("Mod+J brings the console back", !t.console.hidden && tiled(t), t);

  // Mouse: with Alt held each tile shows its grip, which drops the preview on the editor's left half; a border drag resizes.
  const grips = () =>
    page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-tiling-tile]:not([data-hidden]) [data-tiling-grip]")].map((g) => getComputedStyle(g).opacity === "1" && getComputedStyle(g).pointerEvents !== "none"));
  const without = await grips();
  await page.keyboard.down("Alt");
  await new Promise((r) => setTimeout(r, 250));
  const held = await grips();
  await shot(page, "alt-held");
  report("the grips show only while Alt is held", without.length === 4 && !without.some(Boolean) && held.every(Boolean), { without, held });
  const grip = center(t.preview);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.keyboard.up("Alt");
  await page.mouse.move(t.editor.x + t.editor.w * 0.15, center(t.editor).y, { steps: 8 });
  await shot(page, "dragging");
  const dropShown = await page.evaluate(() => !document.querySelector<HTMLElement>("[data-tiling-drop]")!.hidden);
  await page.mouse.up();
  const before = t;
  t = await settled(page);
  report("drag by the grip: the preview lands left of the editor", dropShown && tiled(t) && t.preview.x < t.editor.x && t.preview.y === t.editor.y, { dropShown, t });
  await shot(page, "dropped");
  const handle = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-tiling-handle][data-orientation="horizontal"]')!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 60, handle.y, { steps: 4 });
  await page.mouse.up();
  const dragged = await settled(page);
  report("a border drag resizes", tiled(dragged) && JSON.stringify(dragged) !== JSON.stringify(t), Object.fromEntries(Object.entries(dragged).map(([n, b]) => [n, b.w])));
  void before;

  if (frame) {
    const loads = await page.evaluate(() => (window as unknown as { __loads: number }).__loads);
    report("the preview's frame never loaded again", loads === 0, { loads });
  }

  // The layout is kept.
  const kept = await tiles(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-tiling-root] [data-tiling-tile] #editor", { timeout: 60_000 });
  t = await settled(page);
  const same = Object.keys(kept).every((n) => Math.abs(kept[n].x - t[n].x) <= 1 && Math.abs(kept[n].w - t[n].w) <= 1 && Math.abs(kept[n].y - t[n].y) <= 1);
  report("a reload keeps the layout", same, { kept, t });
  await shot(page, "reloaded");

  report("no errors or Solid warnings in the console", problems.length === 0, problems);
  await page.evaluate(() => localStorage.removeItem("layout.tiles"));
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
