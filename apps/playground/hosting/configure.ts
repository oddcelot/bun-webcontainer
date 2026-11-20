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
 * - the HTML pages' static parts: the docs links, the canonical and share-card URLs, the site's name in the titles,
 *   whether the landing page shows; a `brand`'s titles, description and icon; robots.txt's and sitemap.xml's URLs;
 * - _headers (Cloudflare, Netlify): the content origin's rules, which have to name its host.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadHosting, type Hosting } from "./load.ts";

/**
 * What a build has before any configure: the docs links, site URL and name its HTML is written with (index.html,
 * vite.config.ts docsLink()), and which the first configure replaces.
 */
const BUILT = { docsUrl: "https://docs.runbun.dev/", siteUrl: "https://runbun.dev/", name: "runbun.dev", brand: null as RuntimeBrand | null };
/** The pages' description as index.html has it (the same text in its meta, og: and twitter: tags). */
const DESCRIPTION = "Run Bun.serve apps, install packages and edit TypeScript in a tab, built from Bun&#39;s own Rust crates compiled to wasm64.";
/** What index.html's share card shows (the same text in its og: and twitter: tags). */
const CARD_ALT = "A pixel-art kitchen counter with a dumpling in a bamboo steamer, under the words: Bun in your browser";
/** A brand as hosting.js has it: `card` is its share card's file name in the folder. */
type RuntimeBrand = { logo: string; logoDark: string | null; home: string | null; description: string | null; card?: string | null; cardAlt?: string | null };
/** A share card's tag, and the build's own picture when a brand's stands in for it. */
const CARD_TAG = /(property="og:image"|name="twitter:image") content="([^"]*)"(?: data-built="([^"]*)")?/g;

/**
 * The texts a `brand` changes in the HTML, for a host's name and brand: the pages' titles (index.html's, its share
 * cards', embed.html's) and their description. A branded host's titles are its name alone. configure() swaps the
 * ones the folder has for the next host's, in this order: embed.html's title comes first, since a branded one starts
 * with index.html's (the comment after it tells them apart on the way back).
 */
function pageTexts(name: string, brand: RuntimeBrand | null): string[] {
  const description = `content="${brand?.description ?? DESCRIPTION}"`;
  // A brand's card says what it shows; without one the picture is still the build's.
  const alt = `:alt" content="${brand?.card ? (brand.cardAlt ?? name) : CARD_ALT}"`;
  if (brand) return [`<title>${name}</title><!-- embed -->`, `<title>${name}</title>`, `:title" content="${name}"`, description, alt];
  return [
    `<title>Bun playground · ${name}</title>`,
    `<title>Bun Playground: Run Bun Online in Your Browser | ${name}</title>`,
    `:title" content="Bun Playground: run Bun in your browser · ${name}"`,
    description,
    alt,
  ];
}

/** The icon links a build has (`rel="icon"` …), and what a brand's logo parks them as: the page then has one icon, the logo. */
const ICON_RELS = ["icon", "apple-touch-icon", "manifest"];
const BRAND_ICON = / *<link rel="icon" data-brand [^>]*>\n/g;
const SHELL_LINE = /^var __SHELL__ = .*;\n/m;
const HOSTING_LINE = /^var __HOSTING__ = .*;\n/m;
const HEADERS_BEGIN = "# hosting/configure.ts: begin";
const HEADERS_END = "# hosting/configure.ts: end";

const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/**
 * The values pages and workers read (src/hosting.ts RuntimeHosting). `siteUrl` is the first editor origin under the
 * build's base: the page's canonical URL.
 */
export function runtimeHosting(h: Hosting, base = "/") {
  return {
    docsUrl: h.docsUrl,
    contentOrigin: h.contentOrigin ?? null,
    editorOrigins: h.editorOrigins,
    canary: h.canary,
    name: h.name,
    siteUrl: h.editorOrigins[0] + base,
    gallery: h.gallery ?? null,
    defaultProject: h.defaultProject ?? null,
    languages: h.languages ?? null,
    landing: h.landing,
    worker: h.worker,
    localRunner: h.localRunner,
    debugger: h.debugger,
    // The card's picture is a file configure() writes; hosting.js names it.
    brand: h.brand ? { ...h.brand, card: h.brand.card?.file ?? null } : null,
    theme: h.theme ?? null,
  };
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
  const next = runtimeHosting(hosting, base);
  const before = { ...BUILT, ...current(dist) };

  // The example folders the build has (vite.config.ts writes examples.json): a name that isn't one is a typo.
  const list = join(dist, "examples.json");
  if (existsSync(list)) {
    const folders = new Set<string>(JSON.parse(readFileSync(list, "utf8")));
    for (const name of [...(next.gallery ?? []), ...(next.defaultProject ? [next.defaultProject] : [])])
      if (!folders.has(name)) throw new Error(`${hosting.file ?? "hosting"}: no example "${name}" in this build (${[...folders].join(", ")})`);
  }

  // The hosting file by name only: hosting.js is public, and its path is the deployer's machine.
  const from = hosting.file ? ` from ${basename(hosting.file)}` : "";
  writeFileSync(join(dist, "hosting.js"), `// hosting/configure.ts${from}; read by src/hosting.ts.\nexport default ${JSON.stringify(next)};\n`);

  // The HTML's static parts, which load before any script: the docs links, the canonical and share-card URLs, the
  // site's name in the titles, and whether index.html's head script may show the landing page (data-landing).
  const swaps: [string, string][] = [
    [`href="${before.docsUrl}`, `href="${next.docsUrl}`],
    [`href="${before.siteUrl}`, `href="${next.siteUrl}`],
    [`content="${before.siteUrl}`, `content="${next.siteUrl}`],
    [`· ${before.name}`, `· ${next.name}`],
    [`| ${before.name}`, `| ${next.name}`],
    [`property="og:site_name" content="${before.name}"`, `property="og:site_name" content="${next.name}"`],
  ];
  // A brand's texts first: they hold the name, which the swaps above would otherwise change under them.
  const texts = pageTexts(before.name, before.brand).map((a, i) => [a, pageTexts(next.name, next.brand)[i]] as [string, string]);
  swaps.unshift(...texts);
  const changed = swaps.filter(([a, b]) => a !== b);
  for (const page of readdirSync(dist).filter((f) => f.endsWith(".html"))) {
    const file = join(dist, page);
    let html = readFileSync(file, "utf8");
    for (const [a, b] of changed) html = html.replaceAll(a, b);
    // index.html's head script reads both before the first paint: no landing page, and the brand's name as the title.
    html = html.replace(
      /<html([^>]*?)( data-landing="off")?( data-brand="[^"]*")?>/,
      (_, attrs) => `<html${attrs}${next.landing ? "" : ' data-landing="off"'}${next.brand ? ` data-brand="${next.name}"` : ""}>`,
    );
    // The share card: a brand's picture in place of the build's, whose URL stays in the tag for another configure.
    html = html.replace(CARD_TAG, (_, tag: string, url: string, kept?: string) => {
      const built = kept ?? url.slice(url.lastIndexOf("/") + 1);
      return next.brand?.card ? `${tag} content="${next.siteUrl}${next.brand.card}" data-built="${built}"` : `${tag} content="${next.siteUrl}${built}"`;
    });
    // The page's icon: a brand's logo in place of the build's icons and web manifest (runbun's), which stay in the
    // HTML under a rel no browser reads, so another configure can bring them back.
    html = html.replace(BRAND_ICON, "");
    for (const rel of ICON_RELS) html = next.brand ? html.replaceAll(`<link rel="${rel}" `, `<link rel="built-${rel}" `) : html.replaceAll(`<link rel="built-${rel}" `, `<link rel="${rel}" `);
    if (next.brand) html = html.replace("</head>", `  <link rel="icon" data-brand href="${next.brand.logo}" />\n  </head>`);
    writeFileSync(file, html);
  }
  // The brand's card, under a name from its contents; the one before it goes.
  const card = hosting.brand?.card;
  if (before.brand?.card && before.brand.card !== card?.file && /^brand-card-[0-9a-f]+\.png$/.test(before.brand.card)) rmSync(join(dist, before.brand.card), { force: true });
  if (card) writeFileSync(join(dist, card.file), card.data);
  // Search engines find the site under its own URL.
  for (const name of ["robots.txt", "sitemap.xml"]) {
    const file = join(dist, name);
    if (existsSync(file) && before.siteUrl !== next.siteUrl) writeFileSync(file, readFileSync(file, "utf8").replaceAll(before.siteUrl, next.siteUrl));
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
