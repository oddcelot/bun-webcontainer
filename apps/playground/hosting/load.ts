/**
 * Where a playground build is hosted: the settings a deploy changes, in one file per deploy (hosting/runbun.dev.json,
 * hosting/canary.json; a self-hosted copy writes its own). Nothing about the host is compiled in: hosting/configure.ts
 * writes these into a built folder (vite.config.ts runs it at the end of a build), and the dev server serves them
 * (src/hosting.ts). Nothing else reads hosting env vars.
 *
 * `HOSTING=<file>` (relative to apps/playground, or absolute) picks the file; the moon tasks set it. Without one, dev
 * and builds use the defaults below: project code on the editor's own origin, the docs on localhost:4321 in dev and
 * docs.runbun.dev in builds. Single env vars still override a field, for the test scripts that start a dev server with
 * a content origin (scripts/check-examples.ts --split): VITE_CONTENT_ORIGIN, VITE_EDITOR_ORIGINS (comma-separated),
 * DOCS_URL, CANARY=1. HOSTING_LOCAL=1 leaves out the file's `contentOrigin` and `editorOrigins`, which name hosts that
 * a dev server on localhost isn't: a file written for a deploy (hosting/example.json) then runs here as it is.
 *
 * The Cloudflare Worker's side (wrangler.jsonc: routes, KV and D1 bindings, vars) is not read from here: wrangler only
 * reads its own config. scripts/hosting-check.ts checks that wrangler.jsonc's vars name the same hosts as these files.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The language packs of the library (src/languages/index.ts), by id: what a hosting file's `languages` may name. Here,
 * not beside the library, because the release archive ships this file alone; the library's type keeps the two in step.
 */
export const LANGUAGE_IDS = ["reactivescript"] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

/** A hosting file's fields (all optional): see hosting/README.md. */
export interface HostingFile {
  /** The docs site the playground links to. Default: http://localhost:4321/ in dev, https://docs.runbun.dev/ in builds. */
  docsUrl?: string;
  /**
   * The origin that runs project code (the runtime Worker and the previews), e.g. https://run.runbun.dev. It must serve
   * the same build as the editor, and should be the same site (a subdomain), see src/contentOrigin.ts. Default: none,
   * project code runs on the editor's own origin.
   */
  contentOrigin?: string;
  /**
   * The editor origins the content origin's pages answer (host.html, the service worker's previews). Only these may
   * drive project code there. Default: http://localhost:5173.
   */
  editorOrigins?: string[];
  /** A canary build: shows src/canary.ts's badge. Default: false. */
  canary?: boolean;
  /** The site's name, in the page titles and share cards in place of "runbun.dev". */
  name?: string;
  /**
   * The gallery's projects: folder names of the examples (apps/playground/examples), in this order. Default: all of
   * them. Others still open by `?example=<name>`.
   */
  gallery?: string[];
  /**
   * The language packs the playground enables, by id (LANGUAGE_IDS: "reactivescript"). Files of a pack left out
   * are plain files: no types or errors of the pack's own, no formatter, no gallery cards that need it. Default: all of
   * them; [] enables none.
   */
  languages?: string[];
  /** The example (a folder name) the playground opens when the URL names no project. Default: the confetti demo. */
  defaultProject?: string;
  /** Show the landing page to first-time visitors at `/`. false opens the playground right away. Default: true. */
  landing?: boolean;
  /**
   * The host runs worker/index.ts (wrangler.jsonc) next to the files: short links (/s/, /api/short), feedback
   * (/api/feedback), signing in with GitHub (/api/auth/) and the git proxy (/git-proxy/, for git clone and GitHub
   * dependencies). Without it the playground leaves those out. Default: true in dev (vite.config.ts answers the git
   * proxy and sign-in), false in builds.
   */
  worker?: boolean;
  /**
   * The header's Local Bun switch (packages/connect: runs go to native Bun on the visitor's machine). Default: true.
   */
  localRunner?: boolean;
  /**
   * The project's runbun.json in the file tree and the tabs. false keeps it out of both (it still applies, and Settings
   * edits it); visitors can show it again in Settings. Default: true.
   */
  showConfig?: boolean;
  /**
   * The step debugger (a prototype): the Debug buttons, breakpoints and the Debug panel. Default: false (env
   * DEBUGGER=1 turns it on, like CANARY).
   */
  debugger?: boolean;
  /**
   * Which panes the playground opens with, where a project's runbun.json `panels` doesn't say: `files`, `preview`,
   * `console`, each true (shown) or false (hidden). The reader can still show and hide them, and a hidden console
   * opens when the program fails. Default: all as the reader left them. The embed has its own modes.
   */
  panels?: HostingPanels;
  /**
   * Makes the playground the host's own: its logo and `name` in the header in place of runbun's dumpling and the
   * random bun names, its logo as the page's icon, and `name` alone as the page title. The status bar's About
   * then opens runbun.dev's about page ("Powered by runbun"), unless the host has the landing page itself.
   */
  brand?: {
    /** The logo: an SVG, PNG or WebP file next to the hosting file (a path relative to it), at most 64 kB. Shown 24px high. */
    logo: string;
    /** The logo on dark themes. Default: `logo`. */
    logoDark?: string;
    /** Where the logo links to, e.g. the project's home page. Default: no link. */
    home?: string;
    /** The pages' description, for search results and share cards. Default: runbun's. */
    description?: string;
    /**
     * The picture a link to the playground gets where it is shared (og:image): a PNG next to the hosting file, 1200 by
     * 630 pixels, at most 1 MB. Configure copies it into the folder. Default: runbun's.
     */
    card?: string;
    /** What the card shows, for people who can't see it. Default: `name`. */
    cardAlt?: string;
  };
  /** How the playground looks before a visitor picks a theme themself. */
  theme?: {
    /** The theme family first-time visitors get, by its light variant ("solid-light", "github-light"). Default: "pierre-light". */
    family?: string;
    /**
     * The theme families the picker offers, by their light variants. With one, the picker is the color scheme
     * (system, light, dark) alone. Default: all of them; `family`, when both are set, must be one of these.
     */
    families?: string[];
    /**
     * CSS custom properties on top of every theme's (the embed's `vars` shape): `base` for both schemes, `light`
     * and `dark` for one, e.g. `{ "base": { "--radius": "8px" }, "dark": { "--accent": "#65c5ff" } }`.
     */
    vars?: HostingVars;
    /**
     * How a theme switch (light/dark, another family) reveals the new colors: "logo" grows them out of the middle of
     * the window in the shape of the logo (`brand.logo`, or runbun's), "circle" in a circle, "none" switches at once.
     * Default: "logo".
     */
    transition?: "logo" | "circle" | "none";
  };
}

/** CSS custom properties by scheme: the shape of the embed's `vars` (packages/embed/src/protocol.ts). */
export interface HostingVars {
  base?: Record<string, string>;
  light?: Record<string, string>;
  dark?: Record<string, string>;
}

/**
 * A hosting file's `brand`, its logo files read into data: URLs (hosting.js carries them; nothing to copy or serve).
 * The card is a file: `file` is the name configure gives it in the folder, from its contents (share sites cache a
 * picture by its URL).
 */
export interface HostingBrand {
  logo: string;
  logoDark: string | null;
  home: string | null;
  description: string | null;
  card: { file: string; data: Uint8Array } | null;
  cardAlt: string | null;
}

/** The settings a build uses, defaults filled in, URLs normalized. */
export interface Hosting {
  /** Ends in "/". */
  docsUrl: string;
  /** An origin (no path), or undefined. */
  contentOrigin?: string;
  /** Origins (no path), at least one. */
  editorOrigins: string[];
  canary: boolean;
  name: string;
  gallery?: string[];
  defaultProject?: string;
  languages?: string[];
  landing: boolean;
  worker: boolean;
  localRunner: boolean;
  debugger: boolean;
  showConfig: boolean;
  panels?: HostingPanels;
  brand?: HostingBrand;
  theme?: { family?: string; families?: string[]; vars?: HostingVars; transition?: "logo" | "circle" | "none" };
  /** The file it came from, for messages; undefined for the defaults. */
  file?: string;
}

const here = fileURLToPath(new URL("..", import.meta.url));

function origin(value: unknown, field: string, file: string): string {
  if (typeof value !== "string") throw new Error(`${file}: ${field} must be a URL string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${file}: ${field} is not a URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${file}: ${field} must be http(s): ${value}`);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`${file}: ${field} must be an origin, without a path: ${value}`);
  return url.origin;
}

const LOGO_TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
const LOGO_MAX = 64 * 1024;

/** A logo file as a data: URL. `dir` is the hosting file's folder. */
function logo(value: unknown, field: string, dir: string, path: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${path}: ${field} must be a file path, relative to the hosting file`);
  const type = LOGO_TYPES[extname(value).toLowerCase()];
  if (!type) throw new Error(`${path}: ${field} must be an .svg, .png or .webp file: ${value}`);
  let data: Buffer;
  try {
    data = readFileSync(resolve(dir, value));
  } catch (e) {
    throw new Error(`${path}: ${field}: ${(e as Error).message}`);
  }
  if (data.length > LOGO_MAX) throw new Error(`${path}: ${field} is ${data.length} bytes; a logo may be 64 kB at most`);
  return `data:${type};base64,${data.toString("base64")}`;
}

const CARD_MAX = 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A share card: a 1200x630 PNG. `dir` is the hosting file's folder. */
function card(value: unknown, dir: string, path: string): { file: string; data: Uint8Array } {
  if (typeof value !== "string" || !value) throw new Error(`${path}: brand.card must be a file path, relative to the hosting file`);
  let data: Buffer;
  try {
    data = readFileSync(resolve(dir, value));
  } catch (e) {
    throw new Error(`${path}: brand.card: ${(e as Error).message}`);
  }
  // A PNG starts with its signature, then the IHDR chunk: the width and height at bytes 16 and 20.
  if (data.length < 24 || PNG.some((b, i) => data[i] !== b)) throw new Error(`${path}: brand.card must be a PNG file: ${value}`);
  const [width, height] = [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (width !== 1200 || height !== 630) throw new Error(`${path}: brand.card is ${width}x${height}; a share card is 1200x630`);
  if (data.length > CARD_MAX) throw new Error(`${path}: brand.card is ${data.length} bytes; a card may be 1 MB at most`);
  return { file: `brand-card-${createHash("sha256").update(data).digest("hex").slice(0, 12)}.png`, data };
}

const VAR_NAME = /^--[a-z0-9-]+$/i;
function vars(value: unknown, field: string, path: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: ${field} must be an object of CSS custom properties`);
  for (const [name, v] of Object.entries(value))
    if (!VAR_NAME.test(name) || typeof v !== "string") throw new Error(`${path}: ${field}: "${name}" must be a custom property ("--name") with a string value`);
  return value as Record<string, string>;
}

/** The panes a hosting file's `panels` can show or hide: the full playground's (src/ui/App.tsx). */
const HOSTING_PANELS = ["files", "preview", "console"] as const;
export type HostingPanels = Partial<Record<(typeof HOSTING_PANELS)[number], boolean>>;

function fields(value: unknown, field: string, known: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: ${field} must be an object`);
  for (const key of Object.keys(value)) if (!known.includes(key)) throw new Error(`${path}: unknown field "${field}.${key}" (fields: ${known.join(", ")})`);
  return value as Record<string, unknown>;
}

/**
 * Reads and checks a hosting file; throws with the file's name on anything it doesn't know. `card: false` leaves the
 * brand's card unread, for the script that draws it (scripts/brand-card.ts).
 */
export function readHostingFile(path: string, read: { card?: boolean } = {}): Omit<HostingFile, "brand"> & { brand?: HostingBrand } {
  const file = isAbsolute(path) ? path : resolve(here, path);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`HOSTING=${path}: ${(e as Error).message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${path}: not a JSON object`);
  const known = new Set(["$schema", "docsUrl", "contentOrigin", "editorOrigins", "canary", "name", "gallery", "defaultProject", "languages", "landing", "worker", "localRunner", "debugger", "showConfig", "panels", "brand", "theme"]);
  for (const key of Object.keys(data)) if (!known.has(key)) throw new Error(`${path}: unknown field "${key}" (fields: ${[...known].slice(1).join(", ")})`);
  const d = data as Record<string, unknown>;
  const out: Omit<HostingFile, "brand"> & { brand?: HostingBrand } = {};
  if (d.docsUrl !== undefined) {
    if (typeof d.docsUrl !== "string" || !URL.canParse(d.docsUrl)) throw new Error(`${path}: docsUrl must be a URL`);
    out.docsUrl = d.docsUrl;
  }
  if (d.contentOrigin !== undefined) out.contentOrigin = origin(d.contentOrigin, "contentOrigin", path);
  if (d.editorOrigins !== undefined) {
    if (!Array.isArray(d.editorOrigins) || d.editorOrigins.length === 0) throw new Error(`${path}: editorOrigins must be a non-empty array of origins`);
    out.editorOrigins = d.editorOrigins.map((o, i) => origin(o, `editorOrigins[${i}]`, path));
  }
  for (const key of ["canary", "landing", "worker", "localRunner", "debugger", "showConfig"] as const)
    if (d[key] !== undefined) {
      if (typeof d[key] !== "boolean") throw new Error(`${path}: ${key} must be true or false`);
      out[key] = d[key];
    }
  if (d.name !== undefined) {
    if (typeof d.name !== "string" || !d.name.trim() || /[<>"&]/.test(d.name)) throw new Error(`${path}: name must be a non-empty string without < > " &`);
    out.name = d.name.trim();
  }
  const folder = /^[A-Za-z0-9._-]+$/;
  if (d.gallery !== undefined) {
    if (!Array.isArray(d.gallery) || !d.gallery.length || !d.gallery.every((g) => typeof g === "string" && folder.test(g)))
      throw new Error(`${path}: gallery must be a non-empty array of example folder names`);
    out.gallery = d.gallery;
  }
  if (d.languages !== undefined) {
    const list = d.languages;
    if (!Array.isArray(list) || new Set(list).size !== list.length || !list.every((l): l is string => typeof l === "string"))
      throw new Error(`${path}: languages must list language pack ids, each once, e.g. ["reactivescript"]`);
    const unknown = list.filter((l) => !(LANGUAGE_IDS as readonly string[]).includes(l));
    if (unknown.length) throw new Error(`${path}: unknown language pack "${unknown[0]}" in languages (packs: ${LANGUAGE_IDS.join(", ")})`);
    out.languages = list;
  }
  if (d.defaultProject !== undefined) {
    if (typeof d.defaultProject !== "string" || !folder.test(d.defaultProject)) throw new Error(`${path}: defaultProject must be an example folder name`);
    out.defaultProject = d.defaultProject;
  }
  if (d.brand !== undefined) {
    const b = fields(d.brand, "brand", ["logo", "logoDark", "home", "description", "card", "cardAlt"], path);
    const dir = dirname(file);
    if (b.home !== undefined && (typeof b.home !== "string" || !/^https?:$/.test(URL.parse(b.home)?.protocol ?? ""))) throw new Error(`${path}: brand.home must be an http(s) URL`);
    if (b.description !== undefined && (typeof b.description !== "string" || !b.description.trim() || /[<>"&]/.test(b.description)))
      throw new Error(`${path}: brand.description must be a non-empty string without < > " &`);
    if (b.cardAlt !== undefined && (typeof b.cardAlt !== "string" || !b.cardAlt.trim() || /[<>"&]/.test(b.cardAlt))) throw new Error(`${path}: brand.cardAlt must be a non-empty string without < > " &`);
    if (b.cardAlt !== undefined && b.card === undefined) throw new Error(`${path}: brand.cardAlt describes brand.card, which isn't set`);
    out.brand = {
      logo: logo(b.logo, "brand.logo", dir, path),
      logoDark: b.logoDark === undefined ? null : logo(b.logoDark, "brand.logoDark", dir, path),
      home: (b.home as string | undefined) ?? null,
      description: (b.description as string | undefined)?.trim() ?? null,
      card: b.card === undefined || read.card === false ? null : card(b.card, dir, path),
      cardAlt: (b.cardAlt as string | undefined)?.trim() ?? null,
    };
  }
  if (d.panels !== undefined) {
    const p = fields(d.panels, "panels", [...HOSTING_PANELS], path);
    out.panels = {};
    for (const key of HOSTING_PANELS)
      if (p[key] !== undefined) {
        if (typeof p[key] !== "boolean") throw new Error(`${path}: panels.${key} must be true or false`);
        out.panels[key] = p[key];
      }
  }
  if (d.theme !== undefined) {
    const t = fields(d.theme, "theme", ["family", "families", "vars", "transition"], path);
    out.theme = {};
    if (t.family !== undefined) {
      if (typeof t.family !== "string" || !folder.test(t.family)) throw new Error(`${path}: theme.family must be a theme's name, e.g. "solid-light"`);
      out.theme.family = t.family;
    }
    if (t.families !== undefined) {
      const list = t.families;
      if (!Array.isArray(list) || !list.length || !list.every((f): f is string => typeof f === "string" && folder.test(f)) || new Set(list).size !== list.length)
        throw new Error(`${path}: theme.families must list theme names, each once, e.g. ["solid-light"]`);
      if (out.theme.family && !list.includes(out.theme.family)) throw new Error(`${path}: theme.family "${out.theme.family}" isn't in theme.families`);
      out.theme.families = list;
    }
    if (t.vars !== undefined) {
      const v = fields(t.vars, "theme.vars", ["base", "light", "dark"], path);
      out.theme.vars = {};
      for (const key of ["base", "light", "dark"] as const) if (v[key] !== undefined) out.theme.vars[key] = vars(v[key], `theme.vars.${key}`, path);
    }
    if (t.transition !== undefined) {
      if (t.transition !== "logo" && t.transition !== "circle" && t.transition !== "none") throw new Error(`${path}: theme.transition must be "logo", "circle" or "none"`);
      out.theme.transition = t.transition;
    }
  }
  return out;
}

/** The build's hosting settings: defaults, then the `HOSTING` file, then single env vars (see above). */
export function loadHosting(mode: string, env: Record<string, string | undefined> = process.env): Hosting {
  const file = env.HOSTING ? readHostingFile(env.HOSTING) : {};
  if (env.HOSTING_LOCAL === "1") delete file.contentOrigin, delete file.editorOrigins;
  const where = env.HOSTING ?? "env";
  const docs = env.DOCS_URL || file.docsUrl || (mode === "development" ? "http://localhost:4321/" : "https://docs.runbun.dev/");
  const editors = env.VITE_EDITOR_ORIGINS
    ? env.VITE_EDITOR_ORIGINS.split(",")
        .map((o) => o.trim())
        .filter(Boolean)
        .map((o, i) => origin(o.replace(/\/$/, "") + "/", `VITE_EDITOR_ORIGINS[${i}]`, where))
    : (file.editorOrigins ?? ["http://localhost:5173"]);
  const content = env.VITE_CONTENT_ORIGIN ? origin(env.VITE_CONTENT_ORIGIN.replace(/\/$/, "") + "/", "VITE_CONTENT_ORIGIN", where) : file.contentOrigin;
  if (content && editors.includes(content)) throw new Error(`${where}: contentOrigin ${content} is also an editor origin; leave it out to run project code on the editor's origin`);
  return {
    docsUrl: docs.endsWith("/") ? docs : docs + "/",
    contentOrigin: content,
    editorOrigins: editors,
    canary: env.CANARY ? env.CANARY === "1" : (file.canary ?? false),
    name: file.name ?? "runbun.dev",
    gallery: file.gallery,
    defaultProject: file.defaultProject,
    languages: file.languages,
    landing: file.landing ?? true,
    worker: file.worker ?? mode === "development",
    localRunner: file.localRunner ?? true,
    debugger: env.DEBUGGER ? env.DEBUGGER === "1" : (file.debugger ?? false),
    showConfig: file.showConfig ?? true,
    panels: file.panels,
    brand: file.brand,
    theme: file.theme,
    file: env.HOSTING,
  };
}
