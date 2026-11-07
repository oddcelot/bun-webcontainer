import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import solid from "@solidjs/vite-plugin";
import UnoCSS from "unocss/vite";
import { rolldown } from "rolldown";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";
import { BUN_VERSION } from "./src/worker/bunVersion";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

/**
 * With VITE_CONTENT_ORIGIN set (src/contentOrigin.ts), this server also answers as the content origin, whose documents
 * (host.html, previews) the editor frames under its COEP: they need CORP cross-origin to be embeddable.
 */
const contentOrigin = !!process.env.VITE_CONTENT_ORIGIN;
const served = contentOrigin ? { ...isolation, "Cross-Origin-Resource-Policy": "cross-origin" } : isolation;

const require = createRequire(import.meta.url);
const browserDist = require.resolve("@rolldown/browser/package.json").replace(/package\.json$/, "dist/");

/** Host packages (see src/worker/hostPackages.ts): export names per specifier, taken from the native rolldown (same API as @rolldown/browser) so the page never instantiates the wasm binding. */
function hostPackageNames(): Plugin {
  const id = "virtual:host-package-names";
  return {
    name: "host-package-names",
    resolveId: (s) => (s === id ? "\0" + id : undefined),
    async load(s) {
      if (s !== "\0" + id) return;
      const names: Record<string, string[]> = {};
      for (const sub of ["", "/experimental", "/filter", "/parseAst", "/plugins", "/utils"]) {
        const m = await import(/* @vite-ignore */ "rolldown" + sub);
        names["rolldown" + sub] = Object.keys(m).filter((k) => k !== "default");
        if ("default" in m) names["rolldown" + sub].push("default");
      }
      const version = require("rolldown/package.json").version;
      return `export default ${JSON.stringify(names)}; export const version = ${JSON.stringify(version)};`;
    },
  };
}

/** emnapi picks its Node code paths (`worker.once`, ...) when `process.versions.node` is a string, and the worker's `process` shim says so. */
function emnapiNotNode(): Plugin {
  return {
    name: "emnapi-not-node",
    enforce: "pre",
    transform(code, id) {
      if (/@emnapi\/(core|wasi-threads)\/dist\/[^/]+\.js/.test(id)) return code.replace(/typeof process === 'object' && process !== null &&/g, "false &&");
    },
  };
}

/**
 * The docs site the playground links to: `DOCS_URL` when set (a canary or preview deploy), else the local docs dev
 * server (`astro dev`) while developing and docs.runbun.dev in builds. The app reads it as `import.meta.env.DOCS_URL`.
 */
function docsUrl(mode: string): string {
  const url = process.env.DOCS_URL || (mode === "development" ? "http://localhost:4321/" : "https://docs.runbun.dev/");
  return url.endsWith("/") ? url : url + "/";
}

/** index.html's static parts (for crawlers and no-JS visitors) link the same docs as the app, and name the Bun release. */
function docsLink(url: string): Plugin {
  return {
    name: "docs-link",
    transformIndexHtml: (html) => html.replaceAll('href="https://docs.runbun.dev/', `href="${url}`).replaceAll("%BUN_VERSION%", BUN_VERSION),
  };
}

/**
 * The embed (embed.html, src/embed/) at `/embed`, its configurator (configure.html) at `/configure`, and the
 * <bun-playground> element at `/embed.js`: in dev and preview these paths are rewritten (Cloudflare serves /embed from
 * embed.html itself); builds emit the element as dist/embed.js. `/about` is index.html, which shows its landing page
 * there (worker/index.ts serves it on Cloudflare).
 */
function embedRoutes(): Plugin {
  const rewrite = (req: { url?: string }) => {
    const [path, rest = ""] = (req.url ?? "").split(/(?=[?#])/);
    if (path.endsWith("/embed") || path.endsWith("/configure")) req.url = path + ".html" + rest;
    else if (path.endsWith("/embed.js")) req.url = path.replace(/embed\.js$/, "embed-element/index.ts") + rest;
    else if (path.endsWith("/about")) req.url = path.replace(/about$/, "") + rest;
  };
  return {
    name: "embed-routes",
    configureServer: (server) => void server.middlewares.use((req, _res, next) => (rewrite(req), next())),
    configurePreviewServer: (server) => void server.middlewares.use((req, _res, next) => (req.url = (req.url ?? "").replace(/\/(embed|configure)(?=$|[?#])/, "/$1.html").replace(/\/about(?=$|[?#])/, "/"), next())),
  };
}

/**
 * The service worker (src/sw.ts) at `<base>sw.js`, the URL boot.ts registers: one classic script (an IIFE, no imports,
 * no hash in the name), so installs from before it was TypeScript update in place. Bundled by rolldown on its own,
 * apart from the app's graph: `vite build` emits it into the output dir (dist/sw.js), and the dev server answers
 * `/sw.js` with a fresh bundle per request (the browser re-checks the worker script on every page load). It finds
 * its base from its own URL, so any `--base` works.
 *
 * Builds put the shell manifest in front of it: every file the build ships (public/ included), path → SHA-256, which
 * sw.ts caches by. Each deploy changes sw.js, so browsers install the new worker; dev has no manifest.
 */
function serviceWorker(): Plugin {
  let publicDir = "";
  const entry = fileURLToPath(new URL("src/sw.ts", import.meta.url));
  const page = fileURLToPath(new URL("src/swPage.ts", import.meta.url));
  async function bundle(): Promise<string> {
    const build = await rolldown({ input: entry, platform: "browser", resolve: { alias: { "#sw-page": page } }, logLevel: "warn" });
    try {
      const { output } = await build.generate({ format: "iife", minify: false });
      return output[0].code;
    } finally {
      await build.close();
    }
  }
  const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 16);
  // Not part of the app: Cloudflare's header rules, and source maps.
  const skip = (path: string) => path === "_headers" || path.endsWith(".map");
  return {
    name: "service-worker",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle: {
      // After the HTML and every other output is in the bundle.
      order: "post",
      async handler(_, out) {
        const shell: Record<string, string> = {};
        if (publicDir)
          for (const e of readdirSync(publicDir, { recursive: true, withFileTypes: true })) {
            if (!e.isFile()) continue;
            const path = relative(publicDir, join(e.parentPath, e.name)).split("\\").join("/");
            if (!skip(path)) shell[path] = hash(readFileSync(join(e.parentPath, e.name)));
          }
        for (const [path, f] of Object.entries(out)) if (!skip(path)) shell[path] = hash(f.type === "chunk" ? f.code : f.source);
        const manifest = `var __SHELL__ = ${JSON.stringify(shell)};\n`;
        this.emitFile({ type: "asset", fileName: "sw.js", source: manifest + (await bundle()) });
      },
    },
    configureServer(server) {
      const url = `${server.config.base}sw.js`;
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split("?")[0];
        if (path !== url && path !== "/sw.js") return next();
        try {
          const code = await bundle();
          for (const [k, v] of Object.entries(served)) res.setHeader(k, v);
          res.setHeader("content-type", "text/javascript; charset=utf-8");
          res.setHeader("cache-control", "no-cache");
          res.end(code);
        } catch (e) {
          next(e);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  define: {
    "import.meta.env.DOCS_URL": JSON.stringify(docsUrl(mode)),
    // CANARY=1 (playground:deploy-canary) shows the canary badge (src/canary.ts).
    "import.meta.env.CANARY": JSON.stringify(process.env.CANARY === "1"),
  },
  plugins: [UnoCSS(), solid(), hostPackageNames(), emnapiNotNode(), docsLink(docsUrl(mode)), embedRoutes(), serviceWorker()],
  build: {
    target: "esnext",
    rollupOptions: {
      input: { index: "index.html", embed: "embed.html", configure: "configure.html", host: "host.html", element: "embed-element/index.ts" },
      // The element has a stable URL that host pages load (it imports nothing, so it's a single file).
      output: { entryFileNames: (chunk) => (chunk.name === "element" ? "embed.js" : "assets/[name]-[hash].js") },
    },
  },
  // In builds, worker bundles (the runtime and rolldown's wasi worker) only get worker.plugins.
  worker: { format: "es", plugins: () => [emnapiNotNode()] },
  // Vite's default `localhost` bind may be ::1 only. As a content origin (src/contentOrigin.ts: run.runbun.localhost next to
  // the editor at runbun.localhost) the server listens on 127.0.0.1, which every *.localhost name reaches (browsers resolve
  // them to loopback and try IPv4); Vite's Host check is told to accept those names.
  server: { headers: served, ...(contentOrigin && { host: "127.0.0.1", allowedHosts: ["localhost", ".localhost"] }) },
  preview: { headers: served },
  optimizeDeps: { exclude: ["@rolldown/browser", "@napi-rs/wasm-runtime", "@emnapi/core", "@emnapi/runtime", "@emnapi/wasi-threads"] },
  resolve: {
    // @runbun/embed publishes built files; `runbun-source` (no other package uses it) resolves its sources here.
    conditions: ["runbun-source", ...defaultClientConditions],
    alias: [
      { find: /^@rolldown\/browser\/utils$/, replacement: browserDist + "utils-index.browser.mjs" },
      { find: /^(\.\.?\/)rolldown-binding\.wasi\.cjs$/, replacement: browserDist + "rolldown-binding.wasi-browser.js" },
    ],
  },
}));
