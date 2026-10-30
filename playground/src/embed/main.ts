import "virtual:uno.css";
import "./embed.css";
import { createEffect, createMemo, createRoot, createSignal, createStore, untrack } from "solid-js";
import { BASE } from "../base";
import { createPlayground } from "../boot";
import { examples, loadExample } from "../examples";
import { loadRepo, parseRepo, repoQuery } from "../github";
import { attach, discard, restore, SKIP } from "../persist";
import { isShareLink, loadShareLink, rememberSource, shareLink } from "../share";
import { isFamily, pickFamily, setColorMode } from "../theme";
import { BUN_VERSION } from "../worker/bunVersion";
import { isFeature, isMode, lockedFeatures, optionsFromUrl, resolveFeatures } from "./config";
import { mountEmbed } from "./mount";
import { isMessage, TAG, VERSION, type Event, type Feature, type Mode, type Options, type Request } from "./protocol";

// runbun.dev/embed: the playground inside another page (an iframe, or <bun-playground>, which builds one). The URL's
// parameters (embed/config.ts) pick the mode, features and project; with `?init=1` the host sends the files first.

const params = new URLSearchParams(location.search);
const pg = createPlayground();
const { vfs, session, workspace, log } = pg;

// --- Messages. Only the embedding window talks to us; once it has, replies and events go to its origin alone.

let hostOrigin = "*";
const post = (msg: object) => {
  if (parent !== window) parent.postMessage({ [TAG]: VERSION, ...msg }, hostOrigin);
};
function emit<E extends Event["event"]>(event: E, data: Extract<Event, { event: E }>["data"]) {
  post({ event, data });
}

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
const initFiles = params.get("init") === "1" ? ((await initReceived).files ?? {}) : {};
const locked = lockedFeatures(options.features);

const embed = createRoot(() => {
  const [mode, setMode] = createSignal<Mode>(options.mode);
  const [expanded, setOpen] = createSignal(false);
  // The mode to go back to when the modal closes (`expand=<mode>` switched it).
  let modeBefore: Mode | undefined;
  const [changes, setChanges] = createStore<Partial<Record<Feature, boolean>>>({});
  const features = createMemo(() => resolveFeatures(mode(), options.features, changes));
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
    mode,
    features,
    has: (f: Feature) => features().includes(f),
    setMode,
    expanded,
    /** Asks the host for its modal (or to close it); it answers with `setExpanded`. */
    requestExpand(open: boolean) {
      emit("expand", { open });
    },
    /** The host opened or closed its modal: an `expand=<mode>` embed switches to that mode meanwhile. */
    setExpanded(open: boolean) {
      setOpen(open);
      const to = options.expand;
      if (to === "" || to === "on") return;
      if (open) {
        modeBefore = mode();
        setMode(to);
      } else if (modeBefore) {
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

applyTheme(options.theme);

function applyTheme(theme: string) {
  if (theme === "light" || theme === "dark") setColorMode(theme);
  else if (isFamily(theme)) pickFamily(theme);
  else setColorMode("system");
}

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

// Inline files open in tabs, in their order; otherwise the entry file. `file` picks the one shown first.
const first = options.file && vfs.files.has(options.file) ? options.file : pg.entryFile();
for (const path of Object.keys(initFiles)) workspace.open(path.replace(/^\.?\//, ""));
workspace.open(first);

// --- Events

// Escape while expanded closes the modal (keys pressed in this frame never reach the host's dialog), unless something
// in here used it: a completion list, the preview's own full view.
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !untrack(embed.expanded) || document.querySelector("#preview-wrap.expanded")) return;
  embed.requestExpand(false);
});

pg.onLog((level, text) => emit("console", { level, text }));
vfs.onChange(({ path, removed }) => {
  if (!SKIP.test(path)) emit("change", { path, removed: !!removed });
});
// The height the embed would like (`height="auto"` on <bun-playground>): the bar, the open file's lines (within
// bounds) and the console when it sits under the editor.
const LINE = 20;
/** Heights for the modes that don't fit their content (embed-element/index.ts HEIGHTS). */
const MODE_HEIGHT: Partial<Record<Mode, number>> = { console: 360, preview: 420, full: 600, result: 420 };
function wantedHeight() {
  const fixed = MODE_HEIGHT[embed.mode()];
  if (fixed) return fixed;
  const path = workspace.state.active;
  const lines = Math.min(Math.max((path ? (vfs.readText(path) ?? "") : "").split("\n").length, 3), 30);
  const below = embed.has("console") && !embed.has("preview") && embed.mode() === "code";
  return 40 + (embed.has("tabs") ? 38 : 0) + lines * LINE + 24 + (below ? 160 : 0) + (pg.canRun ? 0 : 44);
}
let lastHeight = 0;
function sendResize(height: number) {
  if (height === lastHeight) return;
  lastHeight = height;
  emit("resize", { height });
}
createRoot(() =>
  createEffect(wantedHeight, (height) => {
    sendResize(height);
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
    case "setExpanded":
      return embed.setExpanded(!!req.params.open);
    case "getShareUrl":
      return shareUrl();
    default:
      throw new Error(`unknown method: ${(req as { method: string }).method}`);
  }
}
