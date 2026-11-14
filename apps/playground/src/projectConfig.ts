// runbun.json: an optional file beside package.json that says how the playground (and an embed) opens and runs the
// project. JSONC (comments and trailing commas allowed), every field optional; what's missing is guessed as before.
// No code: a project from a link can't use it to run itself (main.ts) or to leave the browser. The schema is
// src/schema/runbun.json (served at /schema/runbun.json); keep the two in step. Imported by the worker too (env): nothing here touches the page.

export const CONFIG_FILE = "runbun.json";

/** The panes a project can open or close: the file tree, the editor's tab bar (embeds), the preview, the console. */
export type Panel = "files" | "tabs" | "preview" | "console";
const PANELS: Panel[] = ["files", "tabs", "preview", "console"];
/** The panes `sizes` sets a share of space for. */
export type Sized = "files" | "editor" | "preview";
const SIZED: Sized[] = ["files", "editor", "preview"];
const REQUIREMENTS =["cross-origin-isolation", "local-bun"] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

export type ProjectConfig = {
  /** What Run starts, over the guess (package.json's module, main, dev script, index.ts). */
  run?: { entry: string; args: string[] };
  /** Run once opened (default: yes). Ignored for code from a link, which waits for the reader's Run. */
  autorun?: boolean;
  /** `process.env` for the program, over the defaults. Not for secrets: the file is shared with the project. */
  env?: Record<string, string>;
  /** The files opened as tabs, in order; the first is shown. */
  open?: string[];
  /** Files kept out of the tabs (still in the project and the tree). */
  hidden?: string[];
  /** Files the editor won't change, and folders for everything in them; the program can still write them. */
  readonly?: string[];
  /** Panes to show (true) or hide (false) when the project opens; the others stay as they are. */
  panels?: Partial<Record<Panel, boolean>>;
  /**
   * Shares of space, in percent: `files` of the width for the tree, `editor` of what's left beside the preview and
   * console (of the height with them under it), `preview` of the column it shares with the console.
   */
  sizes?: Partial<Record<Sized, number>>;
  /** Where the preview points first, and preset requests, each in its own preview tab. */
  preview?: { path?: string; requests?: string[] };
  /** What it can't run without: the playground says so up front. */
  requires?: Requirement[];
};

/** JSON with comments and trailing commas (as tsconfig.json), parsed; throws like JSON.parse. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "$1").replace(/,(\s*[}\]])/g, "$1"));
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const bare = (path: string) => path.replace(/^\.?\//, "");

/**
 * The project's runbun.json, checked: fields of the wrong shape are left out, each with a line in `problems` (the
 * caller logs them). Empty without the file.
 */
export function readConfig(read: (path: string) => string | undefined, problems: string[] = []): ProjectConfig {
  const text = read(CONFIG_FILE);
  if (text === undefined) return {};
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (e) {
    problems.push(`${CONFIG_FILE} isn't valid JSON: ${e instanceof Error ? e.message : e}`);
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(`${CONFIG_FILE} must hold an object`);
    return {};
  }
  const r = raw as Record<string, unknown>;
  const c: ProjectConfig = {};
  const bad = (field: string, want: string) => problems.push(`${CONFIG_FILE}: "${field}" must be ${want}, ignored`);
  for (const key of Object.keys(r))
    if (!["$schema", "run", "autorun", "env", "open", "hidden", "readonly", "panels", "sizes", "preview", "requires"].includes(key)) problems.push(`${CONFIG_FILE}: unknown field "${key}"`);

  if (r.run !== undefined) {
    const run = r.run as { entry?: unknown; args?: unknown };
    if (typeof run !== "object" || run === null || typeof run.entry !== "string" || (run.args !== undefined && !isStrings(run.args)))
      bad("run", '{ "entry": "<file>", "args"?: [strings] }');
    else c.run = { entry: bare(run.entry), args: run.args ?? [] };
  }
  if (r.autorun !== undefined) typeof r.autorun === "boolean" ? (c.autorun = r.autorun) : bad("autorun", "true or false");
  if (r.env !== undefined) {
    const env = r.env as Record<string, unknown>;
    if (typeof env !== "object" || env === null || Array.isArray(env)) bad("env", "an object of strings");
    else c.env = Object.fromEntries(Object.entries(env).flatMap(([k, v]) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? [[k, String(v)]] : [])));
  }
  if (r.open !== undefined) isStrings(r.open) ? (c.open = r.open.map(bare)) : bad("open", "a list of paths");
  if (r.hidden !== undefined) isStrings(r.hidden) ? (c.hidden = r.hidden.map(bare)) : bad("hidden", "a list of paths");
  if (r.readonly !== undefined)
    isStrings(r.readonly) ? (c.readonly = r.readonly.map((p) => bare(p).replace(/\/+$/, "")).filter(Boolean)) : bad("readonly", "a list of paths");
  if (r.panels !== undefined) {
    const panels = r.panels as Record<string, unknown>;
    if (typeof panels !== "object" || panels === null || Array.isArray(panels)) bad("panels", `an object of ${PANELS.join(", ")}: true or false`);
    else {
      c.panels = {};
      for (const [k, v] of Object.entries(panels)) {
        if (PANELS.includes(k as Panel) && typeof v === "boolean") c.panels[k as Panel] = v;
        else problems.push(`${CONFIG_FILE}: panels."${k}" must be true, false or one of ${PANELS.join(", ")}`);
      }
    }
  }
  if (r.sizes !== undefined) {
    const sizes = r.sizes as Record<string, unknown>;
    if (typeof sizes !== "object" || sizes === null || Array.isArray(sizes)) bad("sizes", `an object of ${SIZED.join(", ")}: percent`);
    else {
      c.sizes = {};
      for (const [k, v] of Object.entries(sizes)) {
        if (SIZED.includes(k as Sized) && typeof v === "number" && v > 0 && v < 100) c.sizes[k as Sized] = v;
        else problems.push(`${CONFIG_FILE}: sizes."${k}" must be one of ${SIZED.join(", ")}, a percent between 0 and 100`);
      }
    }
  }
  if (r.preview !== undefined) {
    const p = r.preview as { path?: unknown; requests?: unknown };
    if (typeof p !== "object" || p === null || (p.path !== undefined && typeof p.path !== "string") || (p.requests !== undefined && !isStrings(p.requests)))
      bad("preview", '{ "path"?: "/…", "requests"?: ["GET /…", …] }');
    else c.preview = { path: p.path as string | undefined, requests: p.requests as string[] | undefined };
  }
  if (r.requires !== undefined) {
    if (!isStrings(r.requires)) bad("requires", `a list of ${REQUIREMENTS.join(", ")}`);
    else {
      c.requires = r.requires.filter((x): x is Requirement => (REQUIREMENTS as readonly string[]).includes(x));
      for (const x of r.requires) if (!c.requires.includes(x as Requirement)) problems.push(`${CONFIG_FILE}: unknown requirement "${x}"`);
    }
  }
  return c;
}
