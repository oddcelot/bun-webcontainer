#!/usr/bin/env bun
// Checks the language support for ReactiveScript (.rx) files (src/typecheck/rx.ts) in headless Chrome against a running
// playground: opens the `reactivescript` example, waits for its install and run, opens src/app.rx and checks
//   (a) resting the pointer on a name shows its TypeScript type,
//   (b) the compiler's own rule errors are markers with source rx(<rule>),
//   (c) TypeScript errors are markers on the .rx text with source ts(<code>),
//   (d) the unchanged file has no diagnostics once its dependencies are installed (no false positives from the projection),
//   (f) an element's tag and an attribute have hovers, (g) Format reflows the module,
//   (e) rxc.wasm and the type checker load (no console error starting with `rxc:` or `tsrs:`).
// It prints one ok/FAIL line per check with what it saw and exits 1 if any failed.
//   bun scripts/rx-language.ts                    against http://localhost:5174 (a running `bun run dev`)
//   URL=http://localhost:5173 bun scripts/rx-language.ts
//   DUMP=1 bun scripts/rx-language.ts             also print the projected TSX and the tsconfig sent to the type checker
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";

const BASE = (process.env.URL ?? "http://localhost:5173").replace(/\/$/, "");
const FILE = "src/app.rx";
const SETTLE_WITHIN = 90_000;
const STEADY_FOR = 2_000;
/** How long a check may wait for the debounce (300 ms) and the first type check, which loads two wasm modules. */
const WAIT_FOR = 20_000;
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

let failed = 0;
const report = (name: string, pass: boolean, detail: string) => {
  if (!pass) failed++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}: ${detail}`);
};

type Marker = { line: number; column: number; length: number; severity: string; source: string; message: string };

/** Finds the editor of FILE: its shadow root. Runs in the page. */
const EDITOR = `[...document.querySelectorAll("diffs-container")].map((c) => c.shadowRoot).find((r) => r && r.querySelector('[data-content][aria-label="${FILE}"]'))`;

const profile = mkdtempSync(join(tmpdir(), "rx-language-"));
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile, defaultViewport: { width: 1400, height: 900 } });
  const page = await browser.newPage();
  const consoleLog: string[] = [];
  page.on("console", (m) => consoleLog.push(m.text()));
  page.on("pageerror", (e) => consoleLog.push(`pageerror: ${e instanceof Error ? e.message : e}`));
  // The type checker's worker: every request and answer, to say what was asked and what came back.
  await page.evaluateOnNewDocument(() => {
    const W = window.Worker;
    const log: { dir: "out" | "in"; d: any }[] = [];
    (window as any).__ls = log;
    (window as any).Worker = class extends W {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!/typecheck\/worker/.test(String(url))) return;
        this.addEventListener("message", (e) => log.push({ dir: "in", d: e.data }));
        const post = this.postMessage.bind(this);
        (this as any).postMessage = (m: any, ...rest: any[]) => (log.push({ dir: "out", d: m }), (post as any)(m, ...rest));
      }
    };
  });

  await page.goto(`${BASE}/?example=reactivescript`, { waitUntil: "domcontentloaded" });
  const status = await settled(page);
  if (!status || status.state === "error" || !/^Running/.test(status.text)) {
    console.log(`FAIL setup: the example didn't install and run: ${status ? status.text : "didn't settle"}`);
    console.log(`  console: ${consoleLog.filter((l) => !/vite/.test(l)).slice(-8).join(" | ")}`);
    process.exit(1);
  }
  console.log(`ok   setup: ${status.text}`);

  const mark = await lsMark(page);
  await openFile(page);
  const original = await editorText(page);
  const k = keys(page);
  // Where the example has what the checks point at (1-based lines).
  const lineIn = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;
    const doubledLine = lineIn(original ?? "", "doubled = count * 2");
  const buttonLine = lineIn(original ?? "", "<button onClick=");
  if (!original || !doubledLine || !buttonLine) throw new Error(`src/app.rx isn't the example these checks know: ${JSON.stringify(original)}`);

  // (d) no diagnostics on the unchanged file, after the type checker has answered for it.
  const first = await waitFor(() => lsReply(page, mark), WAIT_FOR);
  await Bun.sleep(1000);
  let markers = await readMarkers(page, false);
  const counts = await problemCounts(page);
  const raw = first ? rawDiagnostics(first) : "no answer from the type checker";
  report(
    "(d) no diagnostics on the correct file",
    !!first && markers.length === 0 && counts === "0 errors, 0 warnings",
    `${first ? "" : "NO ANSWER FROM THE TYPE CHECKER; "}status bar: ${counts}; markers: ${fmtMarkers(markers)}; type checker's raw answer: ${raw}`,
  );

  // (a) hovers.
  const hovers: string[] = [];
  let hoverOk = true;
  for (const [line, name, type] of [[doubledLine, "doubled", /: number/], [lineIn(original, "parity = "), "parity", /: "even" \| "odd"|: string/]] as const) {
    const text = await hoverOn(page, line, name);
    hovers.push(`${name} (line ${line}): ${JSON.stringify(text)}`);
    if (!text || !type.test(text)) hoverOk = false;
  }
  report("(a) hover shows the type", hoverOk, hovers.join("; "));

  // (f) markup: an element's tag and an attribute.
  const tokens = (await page.evaluate(`[...${EDITOR}.querySelectorAll('[data-content] [data-line="${buttonLine}"] [data-char]')].map((s) => s.dataset.char + ":" + JSON.stringify(s.textContent)).join(" ")`)) as string;
  // The opening tag's token is `<button` or `button`, as the grammar splits the line.
  const opening = await hoverOn(page, buttonLine, "<button");
  const closing = await hoverOn(page, buttonLine, "button");
  const tag = opening?.startsWith("no `") ? closing : opening;
  const attr = await hoverOn(page, buttonLine, "onClick");
  report("(f) hover on an element and an attribute", !!tag && /HTMLElementTags\.button/.test(tag) && !!attr && /onClick/.test(attr), `<button: ${JSON.stringify(opening)}; button: ${JSON.stringify(closing)}; onClick: ${JSON.stringify(attr)}; its line's tokens: ${tokens}`);

  // (g) Format: the equation's indent is put right, which gives the example as it is written (rxFormat.ts).
  await focus(page);
  await k.press("a", [MOD]);
  await k.press("ArrowLeft");
  await k.press("ArrowDown", [], doubledLine - 1);
  await page.keyboard.type("    ");
  await page.click(".format");
  const formatted = await waitFor(async () => {
    const t = await editorText(page);
    return t && /\n  doubled = count \* 2\n/.test(t) ? t : null;
  }, WAIT_FOR);
  report(
    "(g) Format reflows the module",
    formatted === original,
    formatted ? JSON.stringify(formatted) : `not formatted: ${JSON.stringify(await editorText(page))}`,
  );
  await restore(page, original);

  // (b) a rule error: `doubled = …` is an equation, `doubled := …` writes to it.
  await focus(page);
  await k.press("a", [MOD]);
  await k.press("ArrowLeft");
  await k.press("ArrowDown", [], doubledLine - 1);
  await k.press("ArrowRight", [], "  doubled ".length);
  await page.keyboard.type(":");
  const afterB = await editorText(page);
  const wantB = original.replace("doubled = count * 2", "doubled := count * 2");
  // A marker, or at least the status bar counting an error (a diagnostic with no visible marker is a finding of its own).
  await waitFor(async () => (await problemCounts(page)).startsWith("0 errors") ? null : true, WAIT_FOR);
  await Bun.sleep(1500);
  markers = await readMarkers(page);
  const rxMarkers = markers.filter((m) => m.source.startsWith("rx("));
  report(
    "(b) rx(<rule>) error markers",
    afterB === wantB && rxMarkers.length > 0 && rxMarkers.every((m) => m.severity === "error" && m.line === doubledLine),
    `${afterB === wantB ? "" : `EDIT DIDN'T APPLY (editor text ${JSON.stringify(afterB)}); `}status bar: ${await problemCounts(page)}; markers: ${fmtMarkers(markers)}`,
  );
  await restore(page, original);

  // (c) type errors, mapped onto the module's text.
  await focus(page);
  await k.press("a", [MOD]);
  await k.press("ArrowLeft");
  await k.press("ArrowDown", [], doubledLine - 1);
  await k.press("End");
  await k.press("Enter");
  await page.keyboard.type("wrong = count.toUpperCase()");
  await k.press("Enter");
  await page.keyboard.type("label: string = count");
  const afterC = await editorText(page);
  const typed = afterC.split("\n").slice(doubledLine, doubledLine + 2).map((l) => l.trim());
  markers = await waitMarkers(page, (m) => m.length >= 2);
  // A marker whose popover can't be shown has no source to read; the type checker's own answer says which codes it reported.
  const reply = await lsLastReply(page);
  const codes = new Set<number>(((reply?.diagnostics ?? []) as { severity: number; code: number }[]).filter((d) => d.severity === 1).map((d) => d.code));
  const at = (line: number, column: number, length: number, code: number) =>
    markers.some((m) => m.line === line && m.column === column && m.length === length && (m.source === `ts(${code})` || (m.source === "" && codes.has(code))));
  // `wrong = count.toUpperCase()`: the property name; `label: string = count`: the declared name.
  const lineOf = (needle: string) => afterC.split("\n").findIndex((l) => l.includes(needle)) + 1;
  const wl = lineOf("wrong =");
  const ll = lineOf("label: string = count");
  const wc = (afterC.split("\n")[wl - 1] ?? "").indexOf("toUpperCase") + 1;
  const lc = (afterC.split("\n")[ll - 1] ?? "").indexOf("label") + 1;
  report(
    "(c) ts(<code>) errors mapped onto the .rx text",
    typed[0] === "wrong = count.toUpperCase()" && typed[1] === "label: string = count" && at(wl, wc, "toUpperCase".length, 2339) && at(ll, lc, "label".length, 2322),
    `expected ts(2339) at ${wl}:${wc}+11 and ts(2322) at ${ll}:${lc}+5; ${typed[0] === "wrong = count.toUpperCase()" && typed[1] === "label: string = count" ? "" : `EDIT DIDN'T APPLY (lines ${JSON.stringify(typed)}); `}${fmtMarkers(markers)}`,
  );
  await restore(page, original);

  // (e) the wasm modules loaded.
  const bad = consoleLog.filter((l) => /^(rxc|tsrs):/.test(l) || l.startsWith("pageerror:"));
  report("(e) rxc.wasm and tsrs load", bad.length === 0 && (await lsRequests(page, ".rx.tsx")) > 0, bad.length ? bad.join(" | ") : "no console error starting with rxc: or tsrs:");

  if (process.env.DUMP || failed) await dump(page);
} finally {
  await browser?.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

function fmtMarkers(ms: Marker[]): string {
  return ms.length
    ? ms.map((m) => `[${m.severity} ${m.line}:${m.column}+${m.length} ${m.source || "(no source)"} ${JSON.stringify(m.message)}]`).join(" ")
    : "none";
}

/** The status once it has stopped changing and isn't busy; null if that takes longer than SETTLE_WITHIN. */
async function settled(page: Page): Promise<{ state: string; text: string } | null> {
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

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, within: number): Promise<T | null> {
  const end = Date.now() + within;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(250);
  }
  return null;
}

/** Expands `src` in the file tree (a shadow root) and opens FILE. */
async function openFile(page: Page) {
  const click = (path: string) =>
    page.evaluate((p) => {
      const root = (document.querySelector("file-tree-container") as any)?.shadowRoot;
      const item = root?.querySelector(`[data-item-path="${p}"]`) as HTMLElement | null;
      item?.click();
      return !!item;
    }, path);
  if (!(await waitFor(() => click("src/"), 10_000))) throw new Error("no `src` folder in the file tree");
  if (!(await waitFor(() => click(FILE), 5_000))) throw new Error(`no ${FILE} in the file tree`);
  if (!(await waitFor(async () => (await editorText(page).catch(() => null)) !== null, 10_000))) throw new Error(`${FILE} didn't open`);
}

/** The text the editor shows (its lines joined). */
async function editorText(page: Page): Promise<string | null> {
  return page.evaluate(`(() => {
    const r = ${EDITOR};
    if (!r) return null;
    return [...r.querySelectorAll("[data-content] [data-line]")].map((l) => l.textContent).join("\\n");
  })()`) as Promise<string | null>;
}

async function focus(page: Page) {
  await page.evaluate(`${EDITOR}.querySelector("[data-content]").focus()`);
}

function keys(page: Page) {
  return {
    /** The editor only takes real key events (execCommand edits the DOM, not its text). */
    async press(key: string, mods: string[] = [], n = 1) {
      for (const m of mods) await page.keyboard.down(m as any);
      for (let i = 0; i < n; i++) await page.keyboard.press(key as any);
      for (const m of [...mods].reverse()) await page.keyboard.up(m as any);
    },
  };
}

/** Undoes edits until the editor's text is `text` again (the playground's state is in the browser only; the file on disk isn't touched). */
async function restore(page: Page, text: string) {
  const k = keys(page);
  await focus(page);
  for (let i = 0; i < 40 && (await editorText(page)) !== text; i++) await k.press("z", [MOD]);
  if ((await editorText(page)) !== text) console.log("note: couldn't undo back to the original text; later checks may be off");
  await Bun.sleep(1200);
}

/** The editor's error and warning markers: where (1-based line, column, length in characters), the severity and, by hovering each, its message and source. */
async function readMarkers(page: Page, withMessages = true): Promise<Marker[]> {
  const boxes = (await page.evaluate(`(() => {
    const r = ${EDITOR};
    if (!r) return [];
    const lines = [...r.querySelectorAll("[data-content] [data-line]")].map((l) => ({ n: Number(l.dataset.line), rect: l.getBoundingClientRect(), first: l.querySelector('[data-char="0"]') }));
    const first = r.querySelector('[data-content] [data-line="1"] [data-char="0"]');
    const ch = first ? (() => { const g = document.createRange(); g.selectNodeContents(first); return g.getBoundingClientRect().width / first.textContent.length; })() : 0;
    return [...r.querySelectorAll("[data-marker-range]")].map((m) => {
      const b = m.getBoundingClientRect();
      const cy = b.top + b.height / 2;
      const line = lines.find((l) => l.rect.top <= cy && cy < l.rect.bottom);
      const left = line?.first ? line.first.getBoundingClientRect().left : null;
      const column = left === null ? 0 : Math.round((b.left - left) / ch) + 1;
      const length = Math.round(b.width / ch);
      // The editor shows a marker's popover for the token that STARTS inside it, so that's where to point.
      const el = r.querySelector('[data-content] [data-line="' + (line ? line.n : 0) + '"]');
      const tok = el && [...el.querySelectorAll("[data-char]")].find((s) => Number(s.dataset.char) >= column - 1 && Number(s.dataset.char) < column - 1 + Math.max(length, 1) && s.textContent.trim());
      const tb = tok ? tok.getBoundingClientRect() : null;
      return { severity: m.hasAttribute("data-marker-error") ? "error" : m.hasAttribute("data-marker-warning") ? "warning" : "info", line: line?.n ?? 0, column, length, x: tb ? tb.left + Math.min(tb.width, ch) / 2 : b.left + Math.min(b.width, ch) / 2, y: cy };
    });
  })()`)) as (Omit<Marker, "source" | "message"> & { x: number; y: number })[];
  const out: Marker[] = [];
  for (const b of boxes) {
    let source = "";
    let message = "";
    if (withMessages) {
      // The popover comes 300 ms after the pointer rests on the marker; the first try can miss it (the editor re-renders markers).
      for (let attempt = 0; attempt < 3 && !message; attempt++) {
        await page.mouse.move(b.x, b.y - 40);
        await page.mouse.move(b.x, b.y, { steps: 3 });
        const text = await waitFor(
          () =>
            page.evaluate(`(() => {
              const r = ${EDITOR};
              const pop = r && r.querySelector("[data-marker-popover]");
              const t = pop && pop.querySelector(".hover-text");
              if (!t) return null;
              const s = t.querySelector(".hover-source");
              return { source: s ? s.textContent : "", message: [...t.childNodes].filter((n) => n !== s).map((n) => n.textContent).join("").trim() };
            })()`) as Promise<{ source: string; message: string } | null>,
          2_500,
        );
        if (text) ({ source, message } = text);
        await page.mouse.move(0, 0);
        await Bun.sleep(350);
      }
    }
    if (withMessages && !message) message = "(no popover: no token starts inside the marker, which is what the editor's marker hover needs)";
    out.push({ line: b.line, column: b.column, length: b.length, severity: b.severity, source, message });
  }
  return out;
}

/** Marker lists until `ok` holds for one (up to WAIT_FOR), then once more after it has held still for a moment. Returns the last. */
async function waitMarkers(page: Page, ok: (m: Marker[]) => boolean): Promise<Marker[]> {
  const end = Date.now() + WAIT_FOR;
  let last: Marker[] = [];
  while (Date.now() < end) {
    last = await readMarkers(page);
    if (ok(last)) {
      await Bun.sleep(600);
      return readMarkers(page);
    }
    await Bun.sleep(500);
  }
  return last;
}

/** The status bar's problem counts, as `N errors, M warnings`. */
async function problemCounts(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector(".problems")?.textContent ?? "no problem counter").replace(/errors?,?/, " errors,").replace(/warnings?/, " warnings").replace(/\s+/g, " ").trim());
}

/** The tooltip after resting the real pointer on the `name` token of `line` (1-based). */
async function hoverOn(page: Page, line: number, name: string): Promise<string | null> {
  const at = (await page.evaluate(`(() => {
    const r = ${EDITOR};
    const span = [...r.querySelectorAll('[data-content] [data-line="${line}"] [data-char]')].find((s) => s.textContent.trim() === ${JSON.stringify(name)});
    if (!span) return null;
    const b = span.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`)) as { x: number; y: number } | null;
  if (!at) return `no \`${name}\` token on line ${line}`;
  await page.mouse.move(0, 0);
  await Bun.sleep(400);
  await page.mouse.move(at.x - 20, at.y);
  await page.mouse.move(at.x, at.y, { steps: 4 });
  const text = await waitFor(
    () =>
      page.evaluate(() => {
        const tip = document.querySelector<HTMLElement>(".editor-hover");
        return tip && !tip.hidden ? tip.textContent?.trim() || null : null;
      }),
    8_000,
  );
  await page.mouse.move(0, 0);
  await Bun.sleep(400);
  return text;
}

type Msg = { dir: "out" | "in"; d: any };
function lsLog(page: Page): Promise<Msg[]> {
  return page.evaluate(() => (window as any).__ls as Msg[]);
}

/** How many messages the worker log has now. */
async function lsMark(page: Page): Promise<number> {
  return (await lsLog(page)).length;
}

/** The type checker's answer to the first request for FILE's projection after `since`. */
async function lsReply(page: Page, since: number): Promise<any | null> {
  const log = await lsLog(page);
  const req = log.findIndex((m, i) => i >= since && m.dir === "out" && String(m.d.path).endsWith(`${FILE}.tsx`) && m.d.kind === "diagnostics");
  if (req < 0) return null;
  return log.slice(req).find((m) => m.dir === "in" && m.d.id === log[req].d.id)?.d ?? null;
}

async function lsRequests(page: Page, suffix: string): Promise<number> {
  return (await lsLog(page)).filter((m) => m.dir === "out" && String(m.d.path).endsWith(suffix)).length;
}

/** The type checker's latest answer for FILE's projection. */
async function lsLastReply(page: Page): Promise<any | null> {
  const log = await lsLog(page);
  const req = log.findLastIndex((m) => m.dir === "out" && String(m.d.path).endsWith(`${FILE}.tsx`) && m.d.kind === "diagnostics");
  return req < 0 ? null : (log.slice(req).find((m) => m.dir === "in" && m.d.id === log[req].d.id)?.d ?? null);
}

/** Every diagnostic of the type checker's answer, as it came, before the playground drops the hints and implicit-any ones. */
function rawDiagnostics(reply: any): string {
  const all = (reply.diagnostics ?? []) as { range: { start: { line: number; character: number } }; severity: number; code: number; message: string }[];
  if (reply.error) return `error: ${reply.error}`;
  return all.length ? all.map((d) => `[sev ${d.severity} ts(${d.code}) tsx ${d.range.start.line + 1}:${d.range.start.character + 1} ${JSON.stringify(d.message)}]`).join(" ") : "none";
}

/** The projection and the tsconfig as sent (the first request that carried them: later ones send only changes). */
async function dump(page: Page) {
  const log = await lsLog(page);
  const find = (key: string) => log.find((m) => m.dir === "out" && m.d.changed && key in m.d.changed)?.d.changed[key];
  console.log(`\n--- /${FILE}.tsx as sent to the type checker ---\n${find(`/${FILE}.tsx`) ?? "(never sent)"}`);
  console.log(`--- tsconfig (path ${log.find((m) => m.dir === "out" && m.d.config)?.d.config}) ---\n${find("/.runbun/tsconfig.json") ?? "(not in the files sent)"}`);
}
