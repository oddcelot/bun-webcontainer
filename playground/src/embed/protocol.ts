// The embed API (v1): what a host page and runbun.dev/embed say to each other over postMessage. The custom element
// (embed-element/) imports these types too. Names here are public: add, don't rename.

/** Every message either way carries this key with the protocol version; anything else is ignored. */
export const TAG = "bunPlayground";
export const VERSION = 1;

export const MODES = ["code", "preview", "console", "full", "result"] as const;
export type Mode = (typeof MODES)[number];

export const FEATURES = ["files", "tabs", "console", "preview", "types", "format", "install", "terminal", "open"] as const;
export type Feature = (typeof FEATURES)[number];

export type Status = { state: "idle" | "busy" | "running" | "error"; text: string };

/** What the host may set at load (URL parameters or `init`) and later (`setMode`, `setFeatures`, `setTheme`). */
export type Options = {
  mode: Mode;
  /** Comma list layered on the mode's defaults; `-name` turns one off and keeps readers from turning it on. */
  features: string;
  /** The file opened first (default: the entry file Run starts). */
  file: string;
  /** Run once loaded (default: on, except in full mode). */
  autorun: boolean;
  /** auto, light, dark, or a theme family by its light variant (e.g. "github-light"). */
  theme: string;
  /** The editor doesn't take edits; Run still works. */
  readonly: boolean;
  /** Keep edits across reloads (in this browser) under this key; without it every load starts from the source. */
  persist: string;
};

/** Host → embed. Each gets a reply with the same `id`: `{ id, result }` or `{ id, error }`. */
export type Request =
  | { method: "init"; params: { files?: Record<string, string>; options?: Partial<Options> } }
  | { method: "run"; params?: { entry?: string } }
  | { method: "stop" }
  | { method: "install" }
  | { method: "test"; params?: { files?: string[] } }
  | { method: "readFile"; params: { path: string } }
  | { method: "writeFile"; params: { path: string; text: string } }
  | { method: "listFiles" }
  | { method: "openFile"; params: { path: string } }
  | { method: "setMode"; params: { mode: Mode } }
  | { method: "setFeatures"; params: Partial<Record<Feature, boolean>> }
  | { method: "setTheme"; params: { theme: string } }
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
  | { event: "change"; data: { path: string; removed: boolean } }
  | { event: "test"; data: { failed: number } }
  | { event: "mode"; data: { mode: Mode; features: Feature[] } }
  | { event: "resize"; data: { height: number } };

export type EventName = Event["event"];

export type Reply = { id: number; result?: unknown; error?: string };

export type Message = { [TAG]: typeof VERSION } & ((Request & { id: number }) | Event | Reply);

/** True for a message in this protocol (any version). */
export const isMessage = (data: unknown): data is Message => typeof data === "object" && data !== null && TAG in data;
