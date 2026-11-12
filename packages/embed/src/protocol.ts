// The embed API (v1): what a host page and runbun.dev/embed say to each other over postMessage. The element
// (element.ts) and the playground's embed page (apps/playground/src/embed/) both import it. Names here are public: add,
// don't rename. An element from npm can be older or newer than the deployed embed, so a change must work with both.

/** Every message either way carries this key with the protocol version; anything else is ignored. */
export const TAG = "bunPlayground";
export const VERSION = 1;

export const MODES = ["code", "preview", "console", "full", "result"] as const;
export type Mode = (typeof MODES)[number];

/** Where the preview (or console) column goes: beside the editor, or under it. */
export const LAYOUTS = ["side", "stack"] as const;
export type Layout = (typeof LAYOUTS)[number];

export const FEATURES = ["files", "tabs", "console", "preview", "types", "format", "install", "terminal", "open", "watch", "autosave", "close", "git"] as const;
export type Feature = (typeof FEATURES)[number];

export type Status = { state: "idle" | "busy" | "running" | "error"; text: string };

/** Chrome CSS variables the host sets on top of the theme's: `base` for both schemes, `light`/`dark` for one. */
export type Vars = {
  base?: Record<string, string>;
  light?: Record<string, string>;
  dark?: Record<string, string>;
};

/** What the host may set at load (URL parameters or `init`) and later (`setMode`, `setFeatures`, `setTheme`). */
export type Options = {
  mode: Mode;
  /** Comma list layered on the mode's defaults; `-name` turns one off and keeps readers from turning it on. */
  features: string;
  /** The file opened first (default: the entry file Run starts). */
  file: string;
  /** What the preview requests first (default: `/`), e.g. `/user/123`. */
  path: string;
  /**
   * Requests a reader can try, each in its own preview tab, the first active: `;`-separated `METHOD /path [body]`, e.g.
   * `GET /user/1; POST /form {"hello":"Elysia"}`. The first is sent once the server runs, the others the first time
   * their tab opens. Wins over `path`.
   */
  requests: string;
  /** Run once loaded (default: on, except in full mode). */
  autorun: boolean;
  /** auto, light, dark, or a theme family by its light variant (e.g. "github-light"). */
  theme: string;
  /**
   * A theme family by its light variant (e.g. "elysia-light"). Unlike `theme`, it leaves the color mode alone, so a
   * host can follow its own light/dark setting with `theme` and keep the family.
   */
  family: string;
  /** Stylesheet URLs for the embed to load (fonts), whitespace-separated. */
  fonts: string;
  /** The editor doesn't take edits; Run still works. */
  readonly: boolean;
  /** Keep edits across reloads (in this browser) under this key; without it every load starts from the source. */
  persist: string;
  /**
   * A button that asks the host to show the embed in a modal (the `expand` event): "" none, "on" in the same mode,
   * or a mode to switch to while expanded (`expand=full`: a snippet opens as the whole playground).
   */
  expand: "" | "on" | Mode;
  /**
   * "side" (default): the preview (or console) beside the editor; "stack": under it, as in a narrow frame, which
   * stacks either way. Set at load only.
   */
  layout: Layout;
  /** Where the run status shows: "toast", one that fades once it settles (default), or "bar", a pill in the bar. */
  status: "bar" | "toast";
};

/**
 * A project of an example library: what its card in the gallery shows, and its files (path → text) or a public GitHub
 * repo to open instead (`owner/repo`, `owner/repo@ref` or a github.com URL). `id` names it (`project`, `openProject`).
 * The fields match example.json in github.com/oddcelot/runbun-examples; `pack` builds a library from such folders.
 */
export type LibraryProject = {
  id: string;
  name: string;
  description?: string;
  /** "starter": a small project to build on; "example" (default): one that shows a framework or feature. */
  kind?: "starter" | "example";
  /** The frameworks and libraries it is built on; the gallery filters by them. */
  tags?: string[];
  files?: Record<string, string>;
  repo?: string;
};

/**
 * The host's own projects (`library` on <bun-playground>): the embed gets a project button whose gallery lists only
 * these. `open` names the one it starts with (default: the host's inline files if any, else the first).
 */
export type Library = { projects: LibraryProject[]; open?: string };

/**
 * What `test` replies and the `test` event carries: failed tests in all, and per test file that ran, in order (a file
 * that fails to load counts one). `results` is missing from embeds older than it, and when the run ended before it
 * reported (`process.exit` in a test, `stop`, past 30 s; `failed` is then at least 1): grade no file as passed then.
 */
export type TestResult = { failed: number; results?: { file: string; failed: number }[] };

/**
 * Who changed a file (the `change` event): "reader" in the editor, the file tree or the console; "program" the code
 * running (`run` or `test`); "host" with `writeFile` or `removeFile`.
 */
export type ChangeBy = "reader" | "program" | "host";

/** Host → embed. Each gets a reply with the same `id`: `{ id, result }` or `{ id, error }`. */
export type Request =
  | {
      method: "init";
      /**
       * `hidden`: files of `files` not opened as tabs (`data-hidden`), still in the file tree.
       * `generated`: files of `files` the host owns (`data-generated`), such as checks a test runs: written on every
       * load over what `persist` restored, never saved, and kept out of the file tree and the tabs so the reader can't
       * edit them. Run and test see them. Embeds older than it ignore `generated`: name them in `hidden` too.
       */
      params: { files?: Record<string, string>; hidden?: string[]; generated?: string[]; options?: Partial<Options>; vars?: Vars; library?: Library };
    }
  /** Opens a project of the library in place of the current one, as the reader picking it in the gallery does. */
  | { method: "openProject"; params: { id: string } }
  | { method: "run"; params?: { entry?: string } }
  | { method: "stop" }
  | { method: "install" }
  /**
   * `bun test` on these files (default: every test file); replies a TestResult. `run`, `test` and `install` take turns:
   * one sent while another is under way starts when it's done.
   */
  | { method: "test"; params?: { files?: string[] } }
  | { method: "readFile"; params: { path: string } }
  | { method: "writeFile"; params: { path: string; text: string } }
  | { method: "listFiles" }
  | { method: "openFile"; params: { path: string } }
  /** Deletes a file (and closes its tab); an error when there's no such file. */
  | { method: "removeFile"; params: { path: string } }
  | { method: "setMode"; params: { mode: Mode } }
  | { method: "setFeatures"; params: Partial<Record<Feature, boolean>> }
  | { method: "setTheme"; params: { theme: string } }
  | { method: "setFamily"; params: { family: string } }
  | { method: "setVars"; params: { vars: Vars } }
  /** The host shows (or stopped showing) the embed in a modal; the embed switches mode and its button follows. */
  | { method: "setExpanded"; params: { open: boolean } }
  | { method: "getShareUrl" };

export type Method = Request["method"];

/** Embed → host, unsolicited. */
export type Event =
  /** The page loaded and listens; with `?init=1` in its URL it waits for `init` before loading a project. */
  | { event: "boot"; data: { version: number } }
  | { event: "ready"; data: { version: number; bun: string; canRun: boolean; mode: Mode; features: Feature[] } }
  | { event: "unsupported"; data: { checks: { name: string; ok: boolean; why: string }[] } }
  | { event: "status"; data: Status }
  | { event: "console"; data: { level: string; text: string } }
  /** `by` is missing from embeds older than it: count those changes as the reader's. */
  | { event: "change"; data: { path: string; removed: boolean; by?: ChangeBy } }
  | { event: "test"; data: TestResult }
  | { event: "mode"; data: { mode: Mode; features: Feature[] } }
  | { event: "resize"; data: { height: number } }
  /** The reader pressed the expand button (or Escape while expanded): the host should open or close its modal. */
  | { event: "expand"; data: { open: boolean } }
  /** Another project of the library opened (the reader picked it, or `openProject`). */
  | { event: "project"; data: { id: string } };

export type EventName = Event["event"];

export type Reply = { id: number; result?: unknown; error?: string };

export type Message = { [TAG]: typeof VERSION } & ((Request & { id: number }) | Event | Reply);

/** True for a message in this protocol (any version). */
export const isMessage = (data: unknown): data is Message => typeof data === "object" && data !== null && TAG in data;
