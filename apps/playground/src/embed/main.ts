import "virtual:uno.css";
import "./embed.css";
import { createEffect, createMemo, createRoot, createSignal, createStore, untrack } from "solid-js";
import { BASE } from "../base";
import { createPlayground } from "../boot";
import { examples, loadExample } from "../examples";
import { loadRepo, parseRepo, repoQuery } from "../github";
import { attach, discard, restore, SKIP } from "../persist";
import { isShareLink, loadShareLink, rememberSource, shareLink } from "../share";
import { isFamily, pickFamily, setColorMode, setThemeVars } from "../theme";
import { BUN_VERSION } from "../worker/bunVersion";
import { isFeature, isMode, lockedFeatures, optionsFromUrl, resolveFeatures } from "./config";
import { mountEmbed } from "./mount";
import { parseRequests } from "./requests";
import { responseReserve } from "../preview";
import { isMessage, TAG, VERSION, type Event, type Feature, type Mode, type Options, type Request } from "@runbun/embed/protocol";

// runbun.dev/embed: the playground inside another page (an iframe, or <bun-playground>, which builds one). The URL's
// parameters (embed/config.ts) pick the mode, features and project; with `?init=1` the host sends the files first.

const params = new URLSearchParams(location.search);
const pg = createPlayground({ watch: () => embed.has("watch") });
const { vfs, session, workspace, log } = pg;

// --- Messages. Only the embedding window talks to us; once it has, replies and events go to its origin alone.

let hostOrigin = "*";
const post = (msg: object) => {
  if (parent !== window) parent.postMessage({ [TAG]: VERSION, ...msg }, hostOrigin);
};
function emit<E extends Event["event"]>(event: E, data: Extract<Event, { event: E }>["data"]) {
  post({ event, data });
}

// Every console line goes to the host, from the first: loading the project logs too (restored files, storage warnings).
pg.onLog((level, text) => emit("console", { level, text }));

let receiveInit!: (p: Extract<Request, { method: "init" }>["params"]) => void;
const initReceived = new Promise<Extract<Request, { method: "init" }>["params"]>((r) => (receiveInit = r));
/** Resolves once the project has loaded and the engine is up: requests other than init wait for it. */
let markStarted!: () => void;
const started = new Promise<void>((r) => (markStarted = r));

addEventListener("message", async (e) => {
  if (e.source !== parent || parent === window || !isMessage(e.data) || !("method" in e.data)) return;
  const { id, ...req } = e.data as Request & { id: number };
  if (hostOrigin === "*") hostOrigin = e.origin;
  else if (e.origin !== hostOrigin) return;
  try {
    if (req.method !== "init") await started;
    post({ id, result: (await handle(req)) ?? null });
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Options and features. The menu and the API change them; the URL (or init) sets where they start.

const options = await (async (): Promise<Options> => {
  if (params.get("init") !== "1") return optionsFromUrl(params);
  emit("boot", { version: VERSION });
  const init = await initReceived;
  // The host's options over the URL's, parsed together so defaults that depend on the mode (autorun) follow it.
  const merged = new URLSearchParams(params);
  for (const [k, v] of Object.entries(init.options ?? {})) merged.set(k, String(v));
  return optionsFromUrl(merged);
})();
const init = params.get("init") === "1" ? await initReceived : undefined;
const initFiles = init?.files ?? {};
const locked = lockedFeatures(options.features);

/** A short FNV-1a hash, base 36. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
// Where the reader's pane sizes are kept for the tab. Embeds on a page often share a URL (the host sends the files),
// so the host's files and options and a share link tell them apart.
const sizesKey = `embed-sizes:${location.search}#${hash(JSON.stringify([initFiles, init?.options ?? {}, location.hash]))}`;

const embed = createRoot(() => {
  const [mode, setMode] = createSignal<Mode>(options.mode);
  const [expanded, setOpen] = createSignal(false);
  // The mode, and the features the reader changed, to go back to when the modal closes (`expand=<mode>` switched it).
  let modeBefore: Mode | undefined;
  let changesBefore: Partial<Record<Feature, boolean>> = {};
  // The tabs inline, put back on the way out: the modal's tabs close and its tree opens files, which inline has
  // neither of (with `close` off, a file opened in the modal couldn't be closed inline).
  let tabsBefore: { open: string[]; active: string | null } = { open: [], active: null };
  const [changes, setChanges] = createStore<Partial<Record<Feature, boolean>>>({});
  const features = createMemo(() => resolveFeatures(mode(), options.features, changes));
  const has = (f: Feature) => features().includes(f);
  // A column beside the editor: the preview, or the console in console mode. `layout=stack` puts it under the editor,
  // inline only: the modal has room for the usual layout, file tree included.
  const side = () => mode() !== "result" && (has("preview") || (mode() === "console" && has("console")));
  const stacked = () => side() && options.layout === "stack" && !expanded();
  // The frame is as tall as the embed asked (`resize`): a host with height="auto". Stacked rows then fit the code.
  const [fit, setFit] = createSignal(false);
  createEffect(
    () => ({ mode: mode(), features: features() }),
    (d) => {
      emit("mode", d);
    },
  );
  createEffect(
    () => session.status(),
    (s) => {
      emit("status", { state: s.state, text: s.text });
    },
  );
  return {
    options,
    locked,
    sizesKey,
    mode,
    features,
    has,
    side,
    stacked,
    fit,
    setFit,
    setMode,
    expanded,
    /** Asks the host for its modal (or to close it); it answers with `setExpanded`. */
    requestExpand(open: boolean) {
      emit("expand", { open });
    },
    /** The host opened or closed its modal: an `expand=<mode>` embed switches to that mode meanwhile. */
    setExpanded(open: boolean) {
      setOpen(open);
      if (open) tabsBefore = { open: [...workspace.state.open], active: workspace.state.active };
      else {
        workspace.saveAll();
        workspace.closeAll();
        for (const path of tabsBefore.open) if (vfs.files.has(path)) workspace.open(path);
        if (tabsBefore.active && vfs.files.has(tabsBefore.active)) workspace.activate(tabsBefore.active);
      }
      const to = options.expand;
      if (to === "" || to === "on") return;
      if (open) {
        modeBefore = mode();
        changesBefore = { ...changes };
        setMode(to);
      } else if (modeBefore) {
        // Back inline as it was: features turned on or off in the modal's menu were for the modal's mode.
        setChanges((c) => {
          for (const f of Object.keys(c) as Feature[]) delete c[f];
          Object.assign(c, changesBefore);
        });
        setMode(modeBefore);
        modeBefore = undefined;
      }
    },
    /** Turns features on or off; `fromReader` (the menu) can't turn on what the author locked. */
    setFeatures(next: Partial<Record<Feature, boolean>>, fromReader = false) {
      setChanges((c) => {
        for (const [f, on] of Object.entries(next)) if (isFeature(f) && !(fromReader && on && locked.has(f))) c[f] = on;
      });
    },
    run: () => void pg.run(),
    stop: pg.stop,
    install: () => void pg.install(),
    reset,
    /** Opens the project on runbun.dev in a new tab (opened at once: a tab opened after an await is a blocked popup). */
    async openInPlayground() {
      const tab = open("about:blank", "_blank");
      const url = await shareUrl();
      if (!tab) return void open(url, "_blank", "noopener");
      tab.opener = null;
      tab.location.href = url;
    },
  };
});
export type Embed = typeof embed;

function applyTheme(theme: string) {
  if (theme === "light" || theme === "dark") setColorMode(theme);
  else if (isFamily(theme)) pickFamily(theme);
  else setColorMode("system");
}

/** Keeps the color mode alone (unlike `theme`) and picks both variants of a family. */
function applyFamily(family: string) {
  if (isFamily(family)) pickFamily(family);
}

/** Loads the stylesheets a host names in `fonts` (fonts for `--font-ui` and `--font-mono`). */
const loadedFonts = new Set<string>();
function applyFonts(fonts: string) {
  for (const href of fonts.split(/\s+/)) {
    if (!href || loadedFonts.has(href)) continue;
    loadedFonts.add(href);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  }
}

setThemeVars(init?.vars);
applyFonts(options.fonts);
applyFamily(options.family);
applyTheme(options.theme);

// --- The project: saved edits (with `persist`), else the host's files, a share link, a repo, an example or a stub.

const persistId = options.persist ? `embed:${options.persist}` : "";
let stopSaving = async () => {};

async function loadSource() {
  const inline = Object.entries(initFiles);
  if (inline.length) {
    for (const [path, text] of inline) vfs.write(path.replace(/^\.?\//, ""), text);
    return;
  }
  if (isShareLink(location.hash)) {
    try {
      await loadShareLink(vfs, location.hash);
      return;
    } catch {
      log("error", "[share] this link is damaged or incomplete");
      vfs.clear();
    }
  }
  const repoParam = params.get("repo");
  const repo = repoParam ? parseRepo(repoParam) : null;
  if (repoParam && !repo) log("error", `[github] not a GitHub repo: ${repoParam}`);
  if (repo && (await loadRepo(vfs, repo, log))) return rememberSource(vfs, `?repo=${repoQuery(repo)}`, `${repoQuery(repo)} on GitHub`);
  const example = params.get("example");
  if (example && (await loadExample(vfs, example))) return rememberSource(vfs, `?example=${example}`, `the ${examples[example] ?? example} example`);
  if (example) log("error", `[embed] no example named ${example}`);
  vfs.write("index.ts", 'console.log("Hello from Bun!");\n');
}

async function reset() {
  await stopSaving();
  if (persistId) await discard(persistId).catch(() => {});
  location.reload();
}

/** The project as a runbun.dev link (the full playground, not this page). */
async function shareUrl() {
  workspace.saveAll();
  const url = new URL((await shareLink(vfs)).url);
  if (url.pathname.endsWith("/embed")) url.pathname = BASE;
  return url.href;
}

mountEmbed(pg, embed);

const restored = persistId ? await restore(persistId, vfs, log) : 0;
if (!restored) await loadSource();
if (persistId) stopSaving = await attach(persistId, vfs, log, !restored);
await pg.start({ reset });

// Inline files open in tabs, in their order; otherwise the entry file. `file` picks the one shown first. Hidden ones
// (generated, such as a package.json) stay in the project and the tree, out of the tabs.
const bare = (path: string) => path.replace(/^\.?\//, "");
const hidden = new Set((init?.hidden ?? []).map(bare));
const file = options.file && vfs.files.has(options.file) && !hidden.has(options.file) ? options.file : pg.entryFile();
const first = hidden.has(file) ? undefined : file;
for (const path of Object.keys(initFiles).map(bare)) if (!hidden.has(path)) workspace.open(path);
if (first) workspace.open(first);

// `path` picks where the preview's first tab points (default "/"); the next Run loads it there. `requests` wins over it:
// a tab per preset, the first sent by that Run, the others when first opened (previews.ts presets).
const presets = parseRequests(options.requests);
if (presets.length) pg.previews.presets(presets);
else if (options.path) pg.previews.start(options.path);

// --- Events

// Escape while expanded closes the modal (keys pressed in this frame never reach the host's dialog), unless something
// in here used it: a completion list, the preview's own full view.
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !untrack(embed.expanded) || document.querySelector("#preview-wrap.expanded")) return;
  embed.requestExpand(false);
});

vfs.onChange(({ path, removed }) => {
  if (!SKIP.test(path)) emit("change", { path, removed: !!removed });
});
// The height the embed would like (`height="auto"` on <bun-playground>): the bar, the open file's lines (within
// bounds) and the console when it sits under the editor.
const LINE = 20;
/** Heights for the modes that don't fit their content (embed-element/index.ts HEIGHTS). */
const MODE_HEIGHT: Partial<Record<Mode, number>> = { console: 360, preview: 420, full: 600, result: 420 };
/**
 * Stacked (`layout=stack`), the editor fits its lines and the rows under it get these (embed.css, `data-fit`); the
 * preview grows past its 200 to fit a response (previewHeight).
 */
const STACK_PREVIEW = 200;
const STACK_CONSOLE = 120;
let unmeasured = 0;
let measuredOnce = false;
function wantedHeight() {
  const stacked = embed.stacked();
  const fixed = MODE_HEIGHT[embed.mode()];
  if (fixed && !stacked) return fixed;
  // Read first, so that another file measures again, and (stacked) another preview tab, a response, or a switch
  // between page and response.
  const path = workspace.state.active;
  if (stacked && embed.has("preview")) {
    const tab = pg.previews.state.tabs.find((t) => t.id === pg.previews.state.active);
    void [tab?.view, tab?.response, tab?.method, tab?.panel, tab?.section];
  }
  const below = embed.has("console") && !embed.has("preview") && embed.mode() === "code";
  const measured = measuredHeight(stacked, below);
  if (measured) return (unmeasured = 0), (measuredOnce = true), measured;
  // The editor isn't laid out yet (it remounts when tabs come back from the modal): try again for a few frames, and
  // keep the height there is meanwhile rather than jump to the estimate.
  if (unmeasured++ < 30) requestAnimationFrame(() => sendResize(untrack(wantedHeight)));
  if (measuredOnce && lastHeight) return lastHeight;
  // Before the editor is laid out, an estimate. Each stacked row adds its height and the 4px grid gap.
  const lines = Math.min(Math.max((path ? (vfs.readText(path) ?? "") : "").split("\n").length, 3), 30);
  const rows = stacked ? (embed.has("preview") ? STACK_PREVIEW + 4 : 0) + (embed.has("console") ? STACK_CONSOLE + 4 : 0) : 0;
  return 40 + (embed.has("tabs") || embed.has("autosave") ? 38 : 0) + lines * LINE + 24 + (below ? 160 : 0) + rows + (pg.canRun ? 0 : 44);
}

/**
 * The height as laid out, measured: constants missed what fonts and classic scrollbars add (the code's horizontal
 * scrollbar is 11px), and the editor overflowed. It's what sits outside the panes (the bar, a notice), the grid's
 * padding and gaps, the editor pane's chrome (tab bar), the code (its lines, held to 3 to 30, its padding and
 * scrollbar) and the rows under it at their fitted sizes. Undefined until the editor (Pierre's, in a shadow root) is
 * there.
 */
let observed: Element | undefined;
const contentObserver = new ResizeObserver(() => sendResize(untrack(wantedHeight)));
function measuredHeight(stacked: boolean, below: boolean): number | undefined {
  const main = document.getElementById("embed-main");
  const pane = document.getElementById("editor-pane");
  const host = pane?.querySelector<HTMLElement>(".pierre-host");
  const code = host?.firstElementChild?.shadowRoot?.querySelector<HTMLElement>("pre > code");
  // The lines' grid is as tall as the lines; the code and the container around it stretch to fill the pane.
  const lines = code?.querySelector<HTMLElement>("[data-content]");
  if (!main || !pane || !host || !code || !lines?.children.length || !host.clientHeight) return;
  if (lines !== observed) {
    if (observed) contentObserver.unobserve(observed);
    contentObserver.observe((observed = lines));
  }
  // Boxes, not offsetHeight: a tab bar 38.5px tall at 2x read as 38 left the code half a pixel short, and the host
  // showed a scrollbar for it.
  const height = (e: Element) => e.getBoundingClientRect().height;
  const count = lines.children.length;
  const lh = height(lines) / count;
  const box = getComputedStyle(code);
  const codeHeight = (Math.min(Math.max(count, 3), 30) * lh) + parseFloat(box.paddingTop) + parseFloat(box.paddingBottom) + code.offsetHeight - code.clientHeight;
  // The console under the editor (code mode) keeps the height it has; a reader may have dragged it.
  const consoleWrap = below && document.getElementById("console-wrap");
  const consoleH = consoleWrap && height(consoleWrap);
  const rows = (stacked ? [embed.has("preview") && previewHeight(), embed.has("console") && STACK_CONSOLE] : [consoleH]).filter((h): h is number => !!h);
  const grid = getComputedStyle(main);
  const gaps = (parseFloat(grid.rowGap) || 0) * rows.length + parseFloat(grid.paddingTop) + parseFloat(grid.paddingBottom);
  // What sits above the panes (the bar, a notice), measured as such: the frame minus the grid is off by whatever the
  // page overflows.
  const outside = [...(main.parentElement?.children ?? [])].reduce((sum, e) => sum + (e === main ? 0 : height(e)), 0);
  // The pane's tab bar, and a scrollbar of the host's own.
  const paneChrome = height(pane) - height(host) + host.offsetHeight - host.clientHeight;
  return Math.ceil(outside + gaps + paneChrome + codeHeight + rows.reduce((a, b) => a + b, 0));
}
/**
 * The stacked preview row's height with `height="auto"`: as tall as it needs, at least STACK_PREVIEW. That's its
 * chrome (tabs, request bar, a body's panel at its fitted height: the panel less its views, with the body's dragged
 * height swapped for its fitted one) and the response: a card's content, and with a body at least the card's reserve
 * (preview.ts responseReserve), so a tab that hasn't sent yet keeps the room its answer will take. With a body, the
 * response also gets what the body lacks of BODY_ROOM_LINES lines (`data-room` less `data-fit`): room to drag the
 * body down into, since a drag never resizes the embed. A page in the frame
 * with no body has no height of its own, so it keeps STACK_PREVIEW. Set as `--stack-preview` for the fitted rows
 * (embed.css); past the 640px the element allows, the frame isn't fitted and the rows share it, the response scrolling.
 *
 * Measured again on another tab, view or response (wantedHeight reads them), a card's content resizing, and the body's
 * lines changing (`bodyfit`, ui/Preview.tsx). Not on a drag of the body's handle: that only moves room between body and
 * response, and the body's box isn't watched.
 */
let previewWatched: Element[] = [];
const previewObserver = new ResizeObserver(() => queueResize());
addEventListener("bodyfit", () => queueResize());
function previewHeight(): number {
  const panel = document.getElementById("preview-panel");
  const views = document.getElementById("preview-views");
  const body = document.getElementById("req-body");
  const shown = !!body && !body.hidden && !document.getElementById("req-panel")?.hidden && !!body.dataset.fit;
  const response = views?.querySelector<HTMLElement>(".preview-response:not([hidden])");
  const kids = response ? [...response.children] : [];
  // A card's content changed: measure again (once per frame).
  if (kids.length !== previewWatched.length || kids.some((e, i) => e !== previewWatched[i])) {
    previewObserver.disconnect();
    for (const e of (previewWatched = kids)) previewObserver.observe(e);
  }
  let h = STACK_PREVIEW;
  if (panel && views && (shown || (response && kids.length))) {
    const box = response && getComputedStyle(response);
    const content = kids.length && box ? kids[kids.length - 1]!.getBoundingClientRect().bottom - kids[0]!.getBoundingClientRect().top + parseFloat(box.paddingTop) + parseFloat(box.paddingBottom) : 0;
    const dragged = shown ? body!.getBoundingClientRect().height - Number(body!.dataset.fit) : 0;
    const chrome = panel.getBoundingClientRect().height - views.getBoundingClientRect().height - dragged;
    const slack = shown ? Math.max(0, Number(body!.dataset.room ?? 0) - Number(body!.dataset.fit)) : 0;
    h = Math.max(STACK_PREVIEW, Math.ceil(chrome + (shown ? slack + Math.max(content, responseReserve()) : content)));
  }
  document.getElementById("embed")?.style.setProperty("--stack-preview", `${h}px`);
  return h;
}
/** A measurement on the next frame, however many asked for one in this: no jitter while a body is typed. */
let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    sendResize(untrack(wantedHeight));
  });
}
let lastHeight = 0;
const checkFit = () => embed.setFit(Math.abs(innerHeight - lastHeight) <= 1);
// The frame changing size: fitted or not, and a measurement that waited for the frame (0 tall for a moment as the
// modal closes) can be taken now. The height asked for doesn't depend on the frame's, so this doesn't loop.
addEventListener("resize", () => {
  checkFit();
  sendResize(untrack(wantedHeight));
});
function sendResize(height: number) {
  // The modal sizes the frame itself; the inline height waits for the embed to come back (measured as it was).
  if (height === lastHeight || untrack(embed.expanded)) return;
  lastHeight = height;
  emit("resize", { height });
  checkFit();
}
createRoot(() =>
  createEffect(wantedHeight, (height) => {
    sendResize(height);
    // Once the change (another file, a feature) is laid out, measure again.
    requestAnimationFrame(() => sendResize(untrack(wantedHeight)));
  }),
);
vfs.onChange(({ path }) => {
  if (path === untrack(() => workspace.state.active)) sendResize(untrack(wantedHeight));
});

markStarted();
emit("ready", { version: VERSION, bun: BUN_VERSION, canRun: pg.canRun, mode: embed.mode(), features: embed.features() });
if (!pg.canRun) emit("unsupported", { checks: pg.support });

if (pg.canRun) {
  // Missing packages install before the first run whatever the mode; the `install` feature is the menu's action.
  if ((embed.has("install") || options.autorun) && pg.missingDeps()) await pg.install();
  if (options.autorun) await pg.run();
  else session.setStatus({ state: "idle", text: "Ready" });
}

// --- Requests

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case "init":
      return receiveInit(req.params ?? {});
    case "run":
      return pg.run(req.params?.entry);
    case "stop":
      return pg.stop();
    case "install":
      return pg.install();
    case "test": {
      const failed = await pg.test(req.params?.files ?? [...vfs.files.keys()].filter((p) => /[._](test|spec)\.[cm]?[jt]sx?$/.test(p) && !SKIP.test(p)));
      emit("test", { failed });
      return { failed };
    }
    case "readFile": {
      workspace.saveAll();
      const data = vfs.read(req.params.path);
      if (data === undefined) throw new Error(`no such file: ${req.params.path}`);
      return typeof data === "string" ? data : new Uint8Array(data);
    }
    case "writeFile":
      vfs.write(req.params.path, req.params.text);
      return;
    case "listFiles":
      return [...vfs.files.keys()].filter((p) => !SKIP.test(p));
    case "openFile":
      if (!vfs.files.has(req.params.path)) throw new Error(`no such file: ${req.params.path}`);
      return workspace.open(req.params.path);
    case "setMode":
      if (!isMode(req.params.mode)) throw new Error(`unknown mode: ${req.params.mode}`);
      return embed.setMode(req.params.mode);
    case "setFeatures":
      return embed.setFeatures(req.params);
    case "setTheme":
      return applyTheme(req.params.theme);
    case "setFamily":
      return applyFamily(req.params.family);
    case "setVars":
      return setThemeVars(req.params.vars);
    case "setExpanded":
      return embed.setExpanded(!!req.params.open);
    case "getShareUrl":
      return shareUrl();
    default:
      throw new Error(`unknown method: ${(req as { method: string }).method}`);
  }
}
