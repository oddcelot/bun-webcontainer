// The hosting files (hosting/*.json, read by the build) and wrangler.jsonc (read by the Worker) name the same hosts:
// each wrangler env's vars and custom domains against the hosting file its moon task builds with. wrangler only reads
// its own config, so the two can drift; this catches it. Then hosting/configure.ts on a stand-in build. Part of
// `moon run playground:test`.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
for (const [env, file] of deploys) {
  const w = env ? wrangler.env[env] : wrangler;
  const h = loadHosting("production", { HOSTING: file });
  const where = `wrangler.jsonc ${env ? `env.${env}` : "(top level)"} vs ${file}`;
  const expect = (what: string, got: unknown, want: unknown) => {
    if (got !== want) problems.push(`${where}: ${what} is ${JSON.stringify(got)}, the hosting file says ${JSON.stringify(want)}`);
  };
  if (!h.contentOrigin) problems.push(`${where}: no contentOrigin, but the Worker serves a content host`);
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
if (defaults.contentOrigin || defaults.editorOrigins.join() !== "http://localhost:5173" || defaults.docsUrl !== "https://docs.runbun.dev/" || defaults.canary)
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
