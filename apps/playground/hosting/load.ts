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
 * DOCS_URL, CANARY=1.
 *
 * The Cloudflare Worker's side (wrangler.jsonc: routes, KV and D1 bindings, vars) is not read from here: wrangler only
 * reads its own config. scripts/hosting-check.ts checks that wrangler.jsonc's vars name the same hosts as these files.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  landing: boolean;
  worker: boolean;
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

/** Reads and checks a hosting file; throws with the file's name on anything it doesn't know. */
export function readHostingFile(path: string): HostingFile {
  const file = isAbsolute(path) ? path : resolve(here, path);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`HOSTING=${path}: ${(e as Error).message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${path}: not a JSON object`);
  const known = new Set(["$schema", "docsUrl", "contentOrigin", "editorOrigins", "canary", "name", "gallery", "defaultProject", "landing", "worker"]);
  for (const key of Object.keys(data)) if (!known.has(key)) throw new Error(`${path}: unknown field "${key}" (fields: ${[...known].slice(1).join(", ")})`);
  const d = data as Record<string, unknown>;
  const out: HostingFile = {};
  if (d.docsUrl !== undefined) {
    if (typeof d.docsUrl !== "string" || !URL.canParse(d.docsUrl)) throw new Error(`${path}: docsUrl must be a URL`);
    out.docsUrl = d.docsUrl;
  }
  if (d.contentOrigin !== undefined) out.contentOrigin = origin(d.contentOrigin, "contentOrigin", path);
  if (d.editorOrigins !== undefined) {
    if (!Array.isArray(d.editorOrigins) || d.editorOrigins.length === 0) throw new Error(`${path}: editorOrigins must be a non-empty array of origins`);
    out.editorOrigins = d.editorOrigins.map((o, i) => origin(o, `editorOrigins[${i}]`, path));
  }
  for (const key of ["canary", "landing", "worker"] as const)
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
  if (d.defaultProject !== undefined) {
    if (typeof d.defaultProject !== "string" || !folder.test(d.defaultProject)) throw new Error(`${path}: defaultProject must be an example folder name`);
    out.defaultProject = d.defaultProject;
  }
  return out;
}

/** The build's hosting settings: defaults, then the `HOSTING` file, then single env vars (see above). */
export function loadHosting(mode: string, env: Record<string, string | undefined> = process.env): Hosting {
  const file = env.HOSTING ? readHostingFile(env.HOSTING) : {};
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
    landing: file.landing ?? true,
    worker: file.worker ?? mode === "development",
    file: env.HOSTING,
  };
}
