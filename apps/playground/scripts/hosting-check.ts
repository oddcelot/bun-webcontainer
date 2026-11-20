// The hosting files (hosting/*.json, read by the build) and wrangler.jsonc (read by the Worker) name the same hosts:
// each wrangler env's vars and custom domains against the hosting file its moon task builds with. wrangler only reads
// its own config, so the two can drift; this catches it. Then hosting/configure.ts on a stand-in build. Part of
// `moon run playground:test`.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure } from "../hosting/configure";
import { fileURLToPath } from "node:url";
import { loadHosting } from "../hosting/load";

const root = fileURLToPath(new URL("..", import.meta.url));
const wrangler = Bun.JSONC.parse(readFileSync(root + "wrangler.jsonc", "utf8")) as {
  vars: Record<string, string>;
  routes: { pattern: string }[];
  env: Record<string, { vars: Record<string, string>; routes: { pattern: string }[] }>;
};

/** wrangler env → the hosting file moon.yml's deploy task builds it with. */
const deploys: [env: string, file: string][] = [
  ["", "hosting/runbun.dev.json"],
  ["canary", "hosting/canary.json"],
];

const problems: string[] = [];
// HOSTING_LOCAL=1: a deploy's file on a dev server runs project code on the dev server's own origin.
{
  const local = loadHosting("development", { HOSTING: "hosting/example.json", HOSTING_LOCAL: "1" });
  if (local.contentOrigin !== undefined || local.editorOrigins.join() !== "http://localhost:5173" || local.name !== "Solid Playground")
    problems.push(`HOSTING_LOCAL=1 kept the example's origins: ${local.contentOrigin}, ${local.editorOrigins}`);
  if (!loadHosting("development", { HOSTING: "hosting/example.json" }).contentOrigin) problems.push("hosting/example.json has no contentOrigin without HOSTING_LOCAL");
}
for (const [env, file] of deploys) {
  const w = env ? wrangler.env[env] : wrangler;
  const h = loadHosting("production", { HOSTING: file });
  const where = `wrangler.jsonc ${env ? `env.${env}` : "(top level)"} vs ${file}`;
  const expect = (what: string, got: unknown, want: unknown) => {
    if (got !== want) problems.push(`${where}: ${what} is ${JSON.stringify(got)}, the hosting file says ${JSON.stringify(want)}`);
  };
  if (!h.contentOrigin) problems.push(`${where}: no contentOrigin, but the Worker serves a content host`);
  if (!h.worker) problems.push(`${where}: no "worker": true, but wrangler.jsonc deploys the Worker there`);
  expect("vars.CONTENT_HOST", w.vars.CONTENT_HOST, h.contentOrigin && new URL(h.contentOrigin).host);
  expect("vars.EDITOR_ORIGIN", w.vars.EDITOR_ORIGIN, h.editorOrigins[0]);
  expect("vars.DOCS_ORIGIN", w.vars.DOCS_ORIGIN, new URL(h.docsUrl).origin);
  const routes = new Set(w.routes.map((r) => r.pattern));
  for (const host of [new URL(h.editorOrigins[0]).host, h.contentOrigin && new URL(h.contentOrigin).host])
    if (host && !routes.has(host)) problems.push(`${where}: no route for ${host}`);
}

// The loader's checks: what a self-hoster's file gets told.
const throws = (env: Record<string, string>, message: RegExp) => {
  try {
    loadHosting("production", env);
    problems.push(`loadHosting(${JSON.stringify(env)}) accepted it, expected ${message}`);
  } catch (e) {
    if (!message.test((e as Error).message)) problems.push(`loadHosting(${JSON.stringify(env)}): ${(e as Error).message}, expected ${message}`);
  }
};
throws({ HOSTING: "hosting/missing.json" }, /HOSTING=hosting\/missing\.json/);
throws({ VITE_CONTENT_ORIGIN: "https://run.example/sub" }, /must be an origin/);
throws({ VITE_CONTENT_ORIGIN: "https://example.com", VITE_EDITOR_ORIGINS: "https://example.com" }, /also an editor origin/);
const defaults = loadHosting("production", {});
if (!loadHosting("development", {}).worker) problems.push("the dev server's default has no worker (it answers the git proxy and sign-in)");
if (defaults.contentOrigin || defaults.editorOrigins.join() !== "http://localhost:5173" || defaults.docsUrl !== "https://docs.runbun.dev/" || defaults.canary || defaults.worker)
  problems.push(`defaults changed: ${JSON.stringify(defaults)}`);
const dev = loadHosting("development", { HOSTING: "hosting/runbun.dev.json", VITE_CONTENT_ORIGIN: "http://run.runbun.localhost:5199/", VITE_EDITOR_ORIGINS: "http://runbun.localhost:5199" });
if (dev.contentOrigin !== "http://run.runbun.localhost:5199" || dev.editorOrigins.join() !== "http://runbun.localhost:5199") problems.push(`env overrides: ${JSON.stringify(dev)}`);

// hosting/configure.ts on a stand-in build: configured twice (a copy moved to another host), its files must say the
// second host only, and sw.js's manifest must hash the files as they are now.
{
  const dist = mkdtempSync(join(tmpdir(), "hosting-configure-"));
  const want = (what: string, ok: boolean) => ok || problems.push(`configure: ${what}`);
  try {
    const page = [
      '<html lang="en">',
      "<title>Bun Playground | runbun.dev</title>",
      '<link rel="canonical" href="https://runbun.dev/" />',
      '<meta property="og:site_name" content="runbun.dev" />',
      '<meta property="og:image" content="https://runbun.dev/og.png?v=2" />',
      "<script>document.title = `Bun Playground · ${t} · runbun.dev`;</script>",
      '<a href="https://docs.runbun.dev/guides/">Guides</a>',
    ].join("\n");
    writeFileSync(join(dist, "index.html"), page);
    writeFileSync(join(dist, "sitemap.xml"), "<loc>https://runbun.dev/</loc>\n");
    writeFileSync(join(dist, "examples.json"), '["demo","solid-vite-hmr","starter-http"]\n');
    writeFileSync(join(dist, "_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n");
    writeFileSync(join(dist, "sw.js"), `var __SHELL__ = {"index.html":"stale"};\nself.addEventListener("fetch", () => {});\n`);
    const solid = join(dist, "..", `${dist.split("/").at(-1)}-solid.json`);
    writeFileSync(solid, JSON.stringify({ name: "Solid Playground", gallery: ["solid-vite-hmr", "starter-http"], defaultProject: "solid-vite-hmr", landing: false }));
    configure(dist, loadHosting("production", { HOSTING: "hosting/runbun.dev.json" }));
    const read = (f: string) => readFileSync(join(dist, f), "utf8");
    want("runbun.dev's own hosting leaves the HTML as built", read("index.html") === page);
    configure(dist, loadHosting("production", { HOSTING: solid, VITE_CONTENT_ORIGIN: "https://run.example.org", VITE_EDITOR_ORIGINS: "https://example.org", DOCS_URL: "https://docs.example.org/" }), "/play/");
    const sha = (f: string) => createHash("sha256").update(readFileSync(join(dist, f))).digest("hex").slice(0, 16);
    const html = read("index.html");
    want("index.html links the new docs", html.includes('href="https://docs.example.org/guides/"'));
    want("index.html is canonical at the new site, under the base", html.includes('href="https://example.org/play/"') && html.includes('content="https://example.org/play/og.png?v=2"'));
    want("index.html names the site", html.includes("<title>Bun Playground | Solid Playground</title>") && html.includes("· Solid Playground`") && html.includes('content="Solid Playground"'));
    want("index.html has no runbun.dev left", !html.includes("runbun.dev"));
    want("index.html starts in the playground", html.startsWith('<html lang="en" data-landing="off">'));
    want("sitemap.xml lists the new site", read("sitemap.xml") === "<loc>https://example.org/play/</loc>\n");
    const runtime = JSON.parse(/export default (.*);/.exec(read("hosting.js"))![1]);
    want("hosting.js has the gallery and default project", runtime.gallery.join() === "solid-vite-hmr,starter-http" && runtime.defaultProject === "solid-vite-hmr" && runtime.name === "Solid Playground");
    want("hosting.js names the hosting file, not its path", read("hosting.js").startsWith(`// hosting/configure.ts from ${solid.split("/").at(-1)};`));
    want("hosting.js has the new host", read("hosting.js").includes('"contentOrigin":"https://run.example.org"') && !read("hosting.js").includes("runbun.dev"));
    const headers = read("_headers");
    want("_headers keeps its own rules", headers.startsWith("/*\n  Cross-Origin-Opener-Policy: same-origin\n"));
    want("_headers names the new content origin under the base, once", headers.includes("https://run.example.org/play/host.html") && !headers.includes("runbun.dev") && headers.split("configure.ts: begin").length === 2);
    const sw = read("sw.js").split("\n");
    want("sw.js starts with the manifest", sw[0] === `var __SHELL__ = ${JSON.stringify({ "index.html": sha("index.html"), "hosting.js": sha("hosting.js") })};`);
    want("sw.js's second line is the editor origins", sw[1] === 'var __HOSTING__ = {"editorOrigins":["https://example.org"]};');
    want("sw.js keeps its code once", sw.slice(2).join("\n") === 'self.addEventListener("fetch", () => {});\n');
    configure(dist, loadHosting("production", {}));
    want("no content origin: no _headers rules", !read("_headers").includes("configure.ts: begin"));
    want("back to the defaults: the landing page again", read("index.html").startsWith('<html lang="en">\n'));
    // A brand (hosting/example.json), on the real pages: its name as their titles, its description, its logo as the
    // icon in place of runbun's; the defaults bring runbun's back, byte for byte.
    const app = fileURLToPath(new URL("..", import.meta.url));
    const pages = ["index.html", "embed.html", "configure.html"];
    for (const p of pages) writeFileSync(join(dist, p), readFileSync(join(app, p), "utf8"));
    // As built: the pages name runbun.dev, and no hosting.js says otherwise.
    rmSync(join(dist, "hosting.js"));
    writeFileSync(join(dist, "examples.json"), '["astro-solid-demo","demo","reactivescript","reactivescript-selects","solid-ssr-dashboard","solid-vite-hmr","starter-http"]\n');
    configure(dist, loadHosting("production", {}));
    const built = pages.map(read);
    configure(dist, loadHosting("production", { HOSTING: "hosting/example.json" }));
    const branded = read("index.html");
    want("a brand: index.html's titles are the site's name", branded.includes("<title>Solid Playground</title>") && branded.includes('property="og:title" content="Solid Playground"') && !branded.includes("<title>Bun Playground:") && !branded.includes("in your browser · "));
    want("a brand: index.html's head script gets the name", branded.startsWith('<!doctype html>\n<html lang="en" data-landing="off" data-brand="Solid Playground">'));
    want("a brand: its description", branded.split('content="Run SolidJS projects in your browser').length === 4);
    want("a brand: its logo is the only icon", branded.split('<link rel="icon" ').length === 2 && branded.includes('<link rel="icon" data-brand href="data:image/svg+xml;base64,') && !branded.includes('rel="manifest"'));
    want("a brand: embed.html's title", read("embed.html").includes("<title>Solid Playground</title>"));
    // Its share card: the picture copied in under a name from its contents, in the og: and twitter: tags with what it shows.
    const cardFile = /property="og:image" content="https:\/\/play\.example\.org\/(brand-card-[0-9a-f]{12}\.png)" data-built="og\.png\?v=\d+"/.exec(branded)?.[1];
    want("a brand: its card is the pages' picture", !!cardFile && existsSync(join(dist, cardFile)) && branded.includes(`name="twitter:image" content="https://play.example.org/${cardFile}"`) && !/content="[^"]*og\.png/.test(branded) && read("configure.html").includes(cardFile!));
    want("a brand: the card's alt text", branded.split('content="Solid Playground: run SolidJS projects in your browser, beside the Solid logo"').length === 3 && !branded.includes("pixel-art kitchen"));
    const brand = JSON.parse(/export default (.*);/.exec(read("hosting.js"))![1]);
    want("a brand: hosting.js has the logos, the theme and no Local Bun", brand.brand.logo.startsWith("data:image/svg+xml;base64,") && brand.brand.logoDark !== brand.brand.logo && brand.brand.home === "https://www.solidjs.com/" && brand.theme.families.join() === "solid-light" && brand.localRunner === false);
    configure(dist, loadHosting("production", { HOSTING: "hosting/example.json" }));
    want("a brand: configured twice, the same HTML", read("index.html") === branded);
    configure(dist, loadHosting("production", {}));
    want("a brand: the defaults bring the built pages back", pages.every((p, i) => read(p) === built[i]));
    want("a brand: the defaults take its card out", !!cardFile && !existsSync(join(dist, cardFile)));
    for (const [what, file] of [
      ["an unknown brand field", { brand: { logo: "x.svg", title: "x" } }],
      ["a logo that isn't an image", { brand: { logo: "example.json" } }],
      ["a logo that doesn't exist", { brand: { logo: "nope.svg" } }],
      ["a card that isn't a PNG", { brand: { logo: join(app, "hosting/brand/solid.svg"), card: join(app, "hosting/brand/solid.svg") } }],
      ["a card's alt text without a card", { brand: { logo: join(app, "hosting/brand/solid.svg"), cardAlt: "x" } }],
      ["a theme variable that isn't a custom property", { theme: { vars: { base: { color: "red" } } } }],
      ["a theme transition that isn't one", { theme: { transition: "fade" } }],
      ["an empty list of theme families", { theme: { families: [] } }],
      ["a first-visit theme family the host doesn't offer", { theme: { family: "github-light", families: ["solid-light"] } }],
    ] as const) {
      writeFileSync(solid, JSON.stringify(file));
      try {
        loadHosting("production", { HOSTING: solid });
        problems.push(`configure: ${what} was accepted`);
      } catch {}
    }
    writeFileSync(solid, JSON.stringify({ gallery: ["solid-vite-hrm"] }));
    try {
      configure(dist, loadHosting("production", { HOSTING: solid }));
      want("a misspelled gallery folder is refused", false);
    } catch (e) {
      want(`a misspelled gallery folder names the folders (${(e as Error).message})`, /no example "solid-vite-hrm".*solid-vite-hmr/.test((e as Error).message));
    }
    rmSync(solid, { force: true });
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

if (problems.length) {
  for (const p of problems) console.error(`hosting-check: ${p}`);
  process.exit(1);
}
console.log(`hosting-check: ${deploys.length} deploys match wrangler.jsonc; configure rewrites a build`);
