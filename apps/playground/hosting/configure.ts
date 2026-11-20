#!/usr/bin/env node
/**
 * Points a built playground (a dist/ folder) at its host: the one step between the build and serving it, for this
 * repo's deploys (vite.config.ts runs it at the end of `vite build`) and for a prebuilt copy (the release archive,
 * hosting/README.md). Runs again on a configured folder to move it elsewhere. Node 24+ or Bun, no dependencies:
 *
 *   node hosting/configure.ts <dist> <hosting file>     # e.g. node configure.ts dist my-host.json
 *
 * What it writes, from the hosting file (hosting/load.ts):
 * - hosting.js, which every page and worker loads when it starts (src/hosting.ts);
 * - sw.js's first lines: `__HOSTING__` (the editor origins, src/sw.ts) and `__SHELL__`, the service worker's manifest
 *   of every file and its hash, which it caches by: the files changed here get new hashes, so browsers refetch them;
 * - the HTML pages' links to the docs (index.html's static parts);
 * - _headers (Cloudflare, Netlify): the content origin's rules, which have to name its host.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadHosting, type Hosting } from "./load.ts";

/** What a build has before any configure: the docs links index.html is written with (vite.config.ts docsLink()). */
const BUILT_DOCS = "https://docs.runbun.dev/";
const SHELL_LINE = /^var __SHELL__ = .*;\n/m;
const HOSTING_LINE = /^var __HOSTING__ = .*;\n/m;
const HEADERS_BEGIN = "# hosting/configure.ts: begin";
const HEADERS_END = "# hosting/configure.ts: end";

const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/** The values pages and workers read (src/hosting.ts RuntimeHosting). */
export function runtimeHosting(h: Hosting) {
  return { docsUrl: h.docsUrl, contentOrigin: h.contentOrigin ?? null, editorOrigins: h.editorOrigins, canary: h.canary };
}

/** The settings a configured folder has now (its hosting.js), if any. */
function current(dist: string): ReturnType<typeof runtimeHosting> | undefined {
  const file = join(dist, "hosting.js");
  if (!existsSync(file)) return undefined;
  const m = /^export default (.*);\s*$/m.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error(`${file}: not written by hosting/configure.ts`);
  return JSON.parse(m[1]);
}

/**
 * Writes `hosting` into the built playground at `dist`. `base` is the path it was built for (`vite build --base`);
 * the release archive's build is at "/".
 */
export function configure(dist: string, hosting: Hosting, base = "/"): void {
  const sw = join(dist, "sw.js");
  if (!existsSync(sw) || !existsSync(join(dist, "index.html"))) throw new Error(`${dist}: not a built playground (no index.html or sw.js)`);
  const next = runtimeHosting(hosting);
  const before = current(dist);

  writeFileSync(join(dist, "hosting.js"), `// hosting/configure.ts${hosting.file ? ` from ${hosting.file}` : ""}; read by src/hosting.ts.\nexport default ${JSON.stringify(next)};\n`);

  const docsBefore = before?.docsUrl ?? BUILT_DOCS;
  if (docsBefore !== next.docsUrl)
    for (const page of readdirSync(dist).filter((f) => f.endsWith(".html"))) {
      const file = join(dist, page);
      writeFileSync(file, readFileSync(file, "utf8").replaceAll(`href="${docsBefore}`, `href="${next.docsUrl}`));
    }

  const headers = join(dist, "_headers");
  if (existsSync(headers)) {
    let text = readFileSync(headers, "utf8");
    const at = text.indexOf(HEADERS_BEGIN);
    if (at >= 0) text = text.slice(0, at).trimEnd() + "\n" + text.slice(text.indexOf(HEADERS_END, at) + HEADERS_END.length).replace(/^\n/, "");
    if (next.contentOrigin) {
      // It runs project code and is framed by the editor under COEP, so CORP cross-origin; it never appears in search
      // results; host.html may be framed by any page (an embedder frames /embed, which frames this): who may drive it is
      // its own check of its parent against the editor origins. Absolute URLs match by host, so these only apply there.
      const at = next.contentOrigin + base;
      const rules = [
        HEADERS_BEGIN,
        `# The content origin's rules (src/contentOrigin.ts); vite.config.ts originHeaders() sends the same in dev.`,
        `${at}*`,
        "  Cross-Origin-Resource-Policy: cross-origin",
        "  X-Robots-Tag: noindex",
        `${at}host`,
        "  Content-Security-Policy: frame-ancestors *",
        `${at}host.html`,
        "  Content-Security-Policy: frame-ancestors *",
        HEADERS_END,
      ];
      text = text.trimEnd() + "\n\n" + rules.join("\n") + "\n";
    }
    writeFileSync(headers, text);
  }

  // Last: the manifest hashes the files as written above.
  let code = readFileSync(sw, "utf8");
  const shellLine = SHELL_LINE.exec(code)?.[0];
  code = code.replace(SHELL_LINE, "").replace(HOSTING_LINE, "");
  let shell = "";
  if (shellLine) {
    const old: Record<string, string> = JSON.parse(shellLine.slice("var __SHELL__ = ".length, -2));
    const files: Record<string, string> = {};
    for (const path of new Set([...Object.keys(old), "hosting.js"])) {
      const file = join(dist, path);
      if (existsSync(file)) files[path] = hash(readFileSync(file));
    }
    shell = `var __SHELL__ = ${JSON.stringify(files)};\n`;
  }
  writeFileSync(sw, shell + `var __HOSTING__ = ${JSON.stringify({ editorOrigins: next.editorOrigins })};\n` + code);
}

if (import.meta.main) {
  const [dist, file, ...rest] = process.argv.slice(2);
  const base = rest[0] === "--base" ? rest[1] : "/";
  if (!dist || !file) {
    console.error("usage: node configure.ts <dist> <hosting file> [--base /sub/path/]");
    process.exit(1);
  }
  try {
    const hosting = loadHosting("production", { HOSTING: resolve(file) });
    configure(resolve(dist), hosting, base.endsWith("/") ? base : base + "/");
    console.log(`configure: ${dist} now runs ${hosting.contentOrigin ? `project code on ${hosting.contentOrigin}, ` : ""}for ${hosting.editorOrigins.join(", ")}`);
  } catch (e) {
    console.error(`configure: ${(e as Error).message}`);
    process.exit(1);
  }
}
