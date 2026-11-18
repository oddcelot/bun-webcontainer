# Bun playground

In-browser "Bun" playground: user code runs in a module Web Worker with a shimmed `Bun` global and Node built-ins,
over an in-memory file system, with Bun's own transpiler, bundler and semver compiled to WebAssembly.

What users can and can't do (Bun and Node APIs, toolchain, frameworks, browsers) is documented at
https://docs.runbun.dev/compatibility/ (sources in `../docs`). This README covers how the playground works.

## Run

    bun install
    bun run dev        # copies the crates' .wasm into public/, starts Vite on :5173
    bunx tsc --noEmit
    bun run og         # regenerate public/og.png, public/badge.svg and the favicons (Satori + resvg; outputs are committed)

Open http://localhost:5173 (Chrome; Memory64 wasm needed). The demo is a Bun fullstack app: `Bun.serve({ routes })` with an HTML import (`import homepage from "./index.html"`) whose `client.ts` imports `canvas-confetti` (installed automatically on load). Run restarts the worker and reloads the preview; the bar above the preview sends any method, path and body to the running server (HTML GETs load in the iframe, anything else shows status, headers and pretty-printed body); "bun install" installs `package.json` deps into the VFS, or exactly what `bun.lock` lists when there is one. The header's example picker (or `?example=<name>`) loads a project from `examples/` (the [runbun-examples](https://github.com/oddcelot/runbun-examples) submodule) and installs it; "Open folder" loads one from disk (skipping `node_modules`). `?repo=owner/repo` (also `owner/repo@ref`, or a github.com URL with `/tree/<ref>/<dir>`; "Open GitHub repo" in the header) loads a public GitHub repo: one GitHub API call lists the files, which come from raw.githubusercontent.com (no token, so 60 loads per hour per IP; at most 500 files). Try `examples/lockfile-demo`, which needs nested installs and prints `width: 13` like real Bun, or `examples/elysia-demo` (Elysia 1.4: every route matches real Bun's status and body), or `examples/elysia2-demo` (Elysia 2.0.0-rc.0 with typebox 1.x: hook-before-handler routes, `status()`, generator `sse()`, problem+json 404/422; status and body match real Bun). `examples/node-demo` exercises the `node:*` built-ins (output matches real Bun). `examples/vite-demo` runs an idiomatic Vite 8 dev server (`createServer` + `listen` + `printUrls`): the preview iframe shows the page Vite serves (`index.html` through `transformIndexHtml`, `/main.ts` transformed) and the console shows Vite's URLs. HMR connects over the preview's WebSocket: CSS edits apply in place, other edits reload the page as Vite decides.

The gallery's "Lit SSR guestbook" (`examples/lit-ssr-guestbook`, copied from [lit-devtools' Elysia example](https://github.com/oddcelot/lit-devtools/tree/main/examples/elysia)) runs its `bun --watch src/dev.ts` (Run takes the file a `bun` dev/start script names when there is no `module`/`main`/index file): Elysia 1.4 streams Lit components rendered with `@lit-labs/ssr`, the page hydrates them, signatures go to `bun:sqlite` and arrive in every open preview over a WebSocket, and the Lit DevTools drawer works. What that takes, and what any project gets: the worker resolves packages with Bun's runtime conditions (`bun`, `node`, `development`) while pages get the browser's; `bun:wrap` and tsconfig's `experimentalDecorators` give TypeScript's legacy decorators as Bun emits them; `bun:sqlite` is SQLite's official wasm build (file databases are written back to the project when the worker stops); `Bun.build` runs Bun's own bundler (wasm, see below); `Bun.serve` takes `websocket` handlers and `server.upgrade()` for WebSockets from preview pages (to the page's host or `localhost:<port>`), with topics and `publish`, and may run several servers (the preview shows the first on a fixed port); links, form posts and redirects to absolute paths stay inside the preview. Peer dependencies are installed like Bun does.

The picker's "Astro + Solid" (`examples/astro-solid-demo`) runs an Astro 7 dev server through `dev()` from `astro` (what `astro dev` does). `src/pages/index.astro` is rendered on demand (`prerender = false`) with the current count from server-side state (`src/lib/count.ts`); its Solid `Counter` island (`client:load`) starts from that count, hydrates in the preview, and changes it through the API route `src/pages/api/count.ts` (`GET`/`POST`, also on demand; no adapter needed in dev). Reload the preview to see the server render the new count. `ServerCard`, a Solid component used without a `client:` directive, is rendered to HTML on the server only: the page loads no JavaScript for it. The `.astro` files compile with `@astrojs/compiler-rs`'s wasm build; Vite optimizes `solid-js` for the page with rolldown's wasm. The config is Astro's default plus the Solid integration: HMR, the dev toolbar and the file watcher all work (Solid edits swap in place, `.astro` edits reload the page). What it takes, and what any project gets:

- napi-rs packages load their `-wasm32-wasi` binding: install keeps optional dependencies whose only restriction is `cpu: wasm32` (`"none"` in bun.lock), and the worker resolves those packages to their `browser` entry.
- `fetch("file:///...")` reads the VFS, as Bun's fetch reads files; computed `import(expr)` in served worker modules goes through `__dynamicImport`, which loads `file:` URLs, paths and built-ins (Vite's module runner imports externals by file URL; a host package's installed entry file is served as the host package).
- rolldown's wasm sees the VFS: its in-memory fs gets a copy, kept up to date, and files it writes (Vite's optimized deps) come back into the VFS. Vite 8 resolves every import through rolldown's resolver, so before this only files its JS load fallback found by URL worked, and the dep optimizer couldn't run.
- CommonJS runs as in Node: a body runs when first required (served at `/__vfs/__cjs/<path>`; ES importers get a facade that requires it), so require cycles see partial exports; a require that can't resolve throws when called instead of failing the importer; re-exports (`Object.keys(_x).forEach`, `__exportStar`, `module.exports = require(...)`) add named exports. `createRequire(import.meta.url)` also hoists plain `require("x")`, relative JSON, and resolves literal `require.resolve`.
- `fetch()` with a relative URL is invalid in the worker, as in Bun (code rendered on the server, like a Solid resource, would otherwise fetch from the playground app).
- Import specifiers and `import.meta` are rewritten in code only, not inside strings or templates (code generators like Astro's have `import ... from` in template literals).

## Architecture

    src/main.ts           startup: loads the project, SW registration, runner, install; hands the UI a session and actions
    src/ui/               the interface in Solid 2 (see .claude/skills/solid): App.tsx lays out the page; session.ts (status,
                          run/install actions, console counts), workspace.ts (open tabs) and previews.ts (preview tabs) are
                          the stores main.ts creates; context.ts is what the components get from it
    @runbun/vfs           in-memory Map FS (read/write/list/exists/mkdir) and the `bun_sys` host imports over it (packages/vfs)
    src/share.ts          share links (the UI is ui/ShareMenu.tsx): copy the link (the project's text files, no node_modules, deflated into #code=), a README badge (Markdown) or HTML; opening the link restores them
    src/github.ts         ?repo=: public GitHub repo -> VFS (API tree listing + raw.githubusercontent.com)
    src/demo.ts           seed project (index.ts, util.ts, package.json)
    src/runner.ts         owns the worker; bridges SW messages and worker RPC
    src/moduleServer.ts   VFS path -> JS: transpile TS/JSX, rewrite relative + bare specifiers to /__vfs/...
    src/resolver.ts       Bun's resolver (wasm64, crates/resolve-wasm) over the page VFS
    src/transpiler/       Bun's transpiler as wasm64 (crates/transpile-wasm): transpile(source, path) => Promise<string>
    src/editors/          pierre.ts: @pierre/diffs File + edit-mode Editor behind the CodeEditor interface
    src/preview.ts        requests to the running server for the preview (ui/Preview.tsx: request bar, tabs, one iframe each)
    src/ui/Tabs.tsx       open files as tabs above the editor; open ones get a dot in the file tree
    src/ui/FileTree.tsx   @pierre/trees file tree over the VFS (search, icons); selecting a file opens it
    src/console.ts        the console's xterm.js terminal (lazy; fit, links, graphemes addons) with a line-editing prompt; ui/Console.tsx attaches it
    src/shell.ts          its commands: bun run/<file>/install/add/remove, ls, cat, clear, help
    src/theme.ts          color mode (system/light/dark) + a theme family (picker: ui/ThemePicker.tsx) (light and dark variant; @pierre/theming controller): the active variant colors the editor, tree (themeToTreeStyles) and chrome (CSS variables)
    src/install.ts        no lockfile: registry fetch, semver pick (wasm), flat node_modules
    src/lockfile.ts       bun.lock (text format; tested with lockfileVersion 2 from Bun 1.4.4): locked versions, nested node_modules, sha512 integrity check
    src/semver.ts         loader for public/bun_semver_wasm.wasm (wasm64, BigInt pointers)
    src/fmt.ts            `bun fmt` as wasm64 (crates/fmt-wasm), loaded on first use: format(path, text) => { text } | { error }
    src/worker/runtime.ts worker: the `Bun` global (serve, file, write, build, hash, CryptoHasher, gzipSync, ...), console forwarding, worker-side VFS copy
    src/worker/hash.ts    Bun.hash: JS ports of Bun's wyhash, xxHash and murmur, checked against Bun
    src/persist.ts        OPFS write-behind persistence of projects
    src/worker/node/      Node built-ins (fs on the worker VFS, path, url, util, events, buffer, crypto, zlib, stream, process, http/https/net, ...) + `builtins` registry, which also holds `bun`, `bun:sqlite`, `bun:test`
    src/worker/hostPackages.ts  host packages (see below)
    src/sw.ts             service worker (built to /sw.js; swPage.ts is what it injects into preview pages): /__vfs/*, /__preview/*, and absolute requests made by the preview page (so `fetch("/api/x")` reaches Bun.serve)

Data flow:

- Module: worker `import("/__vfs/index.ts")` -> SW -> (MessageChannel) page -> `serveModule` (transpile + import rewrite) -> SW -> worker.
- Preview: iframe `/__preview/x` -> SW -> page -> port transferred to worker -> `routes` match (exact, `:param`, `*`; HTML imports are bundled with Bun's bundler, chunks and assets served from `/_bun/`), else user `fetch(Request)` -> Response serialized back on the same port.
- VFS: `start` carries the whole page VFS; the worker keeps its own copy, so `Bun.file`/`Bun.write`/`node:fs` are synchronous. Writes, mkdirs, removes and renames are mirrored to the page with fire-and-forget messages, and page edits (editor, file tree, installs) are sent to a running worker as `vfs` messages. `console.*` and `process.stdout` -> postMessage -> console pane.
- Node built-ins: the worker sets `globalThis.__nodeBuiltins`; the module server maps `node:x` and bare built-in names to `/__vfs/__node/x`, a wrapper re-exporting that object (names taken from the same registry on the page).

- Host packages: `rolldown` (+ `/experimental`, `/filter`, `/parseAst`, `/plugins`, `/utils`) comes from the playground's own `@rolldown/browser` (wasm, needs cross-origin isolation), not from the user's `node_modules` copy, whose native binding cannot load. The module server maps those specifiers to `/__vfs/__host/<spec>`, a wrapper over `globalThis.__hostPackage(spec)` (set by `src/worker/hostPackages.ts`, cached dynamic import served by the host Vite). Export names come from the `virtual:host-package-names` Vite plugin (vite.config.ts), computed in Node from the native `rolldown` so the page never instantiates the wasm binding; a console warning is logged once if the installed rolldown version differs. vite.config.ts also aliases the browser entry points, excludes the wasm/emnapi packages from pre-bundling and makes emnapi ignore the worker's Node-like `process`.
- `node:http`/`https`/`net` (`http.ts`, `net.ts`): `createServer().listen()` succeeds without a socket and registers the server as the worker's preview handler (same hook as `Bun.serve`, `node/serve.ts`); each preview `Request` becomes an `IncomingMessage`/`ServerResponse` pair, and the response streams once headers are sent. `listen` picks a port only for bookkeeping; the preview is always `/__preview/`. `http.request`/`get` throw. A socket-less `ws` stand-in (`ws.ts`) is what `ws` gives, installed or not, as in Bun; `bunPackages.ts` has Bun's other ones (`undici`, `node-fetch`, …).
- `import.meta.require("x")` (Bun's sync require, used by Vite): literal specifiers of installed packages become static imports, built-ins and `bun:x` come from the registry, anything else throws at call time.
- `createRequire(import.meta.url)` in ES modules (Vite's bundles, napi-rs loaders): literal `__require("x")`/`require("x")` specifiers that resolve (relative ones only for JSON) are hoisted into static imports and served by that require; literal `require.resolve("x")` becomes the resolved path.

Specifiers are resolved by Bun's resolver compiled to wasm (`src/resolver.ts`, from `crates/resolve-wasm`), reading the page VFS through the same `bun_sys` host imports as the worker (`@runbun/vfs/sysHost`, packages/vfs/sysHost.ts). Its directory, package.json and tsconfig caches persist; VFS events invalidate the directories they touch, and `vfs.clear()` starts a fresh instance. `import.meta.url`/`dirname`/`filename` become `file:///<vfs path>` values; worker code also gets `dir`, `file`, `path`, `env` and `main`.

## Verification

Checked in Chrome with headless Playwright or the chrome-devtools MCP. Browser support is tracked at
https://docs.runbun.dev/compatibility/browsers/.

## Known limitations

User-facing gaps are listed at https://docs.runbun.dev/compatibility/ and kept in step with the code. Internal ones:

- Import rewriting is regex-based over a tokenizer that skips strings, templates, comments and regex literals (a heuristic: `/` after `)` counts as division).
- Pierre editor: a `VirtualizedFile` with a `Virtualizer` on the pane, so only the lines in view (and a margin) are in the DOM; the read-only reveal (go to definition into a lib file) scrolls by `getLinePosition`, not by a rendered row. Completions, hovers, signature help and go to definition come from the tsrs language service (`src/typecheck/`). Undo history is kept per file (EditStateManager, keyed per file so a rename keeps it) and starts afresh when the file changes outside the editor.
- The bundler wasm (~7.5 MB) is fetched on first use and instantiated fresh per bundle, single-threaded. HTML imports are bundled on first request, cached, and dropped on any file change; if bundling fails the page falls back to the unbundled `/__vfs/` module server.
- The preview SW drops `If-None-Match`/`If-Modified-Since` (nothing is cached, and a 304 would arrive empty).
- Several tabs and embeds share one service worker; modules and previews are routed by the owning page (`/__vfs/@<client id>/`, `/__preview/@<client id>/`). Two tabs on the same project save only from the first (a Web Lock per project). A hard refresh (bypassing the SW) leaves the page uncontrolled; reload normally.

## Deploying

`bun run build` writes a static site to `dist/` (the prebuild step copies both `.wasm` files from the
local Rust builds, so build them first). Any static HTTPS host works. For a sub-path, build with
`bunx vite build --base=/sub/path/`; the service worker derives its paths from its own URL.

The Docs link goes to `DOCS_URL` when it's set at build or dev time, else to http://localhost:4321/ (`astro dev`) in
dev and https://docs.runbun.dev/ in builds. For a canary or preview deploy, build both sites with the same pair:
`DOCS_URL=https://docs.canary.example PLAYGROUND_URL=https://canary.example bun run build` (here and in `../docs`).
The canary does that: `moon run playground:deploy-canary docs:deploy-canary` builds both into `dist-canary/` with
https://canary.runbun.dev/ and https://docs-canary.runbun.dev/, marks them `noindex` (`scripts/canary-dist.ts`), shows a "Canary build" notice that links production (`CANARY=1`:
`src/canary.ts` here, `src/components/Banner.astro` in the docs; not in `/embed`), and deploys them with
`wrangler deploy --env canary` (workers `bun-playground-canary` and `bun-playground-docs-canary`, its own short-link
KV namespace `runbun-links-canary`).
When the default ports are taken, set them for local dev too.
Browsers missing a requirement (WebAssembly Memory64, which Safari 27 and every iOS browser still lack; a secure context; service workers; module workers) still get the editor, examples and sharing, with a banner listing what passed and what failed; Run, Install and the preview request bar are disabled.

The page must be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: credentialless`). `public/_headers` sets them on Cloudflare (Pages, and Workers
static assets) and Netlify; hosts that can't send headers (GitHub Pages) need a COOP/COEP service-worker workaround.

Cloudflare Workers: `wrangler.jsonc` deploys `dist/` as static assets: `moon run playground:build && bunx wrangler deploy --env=""` (the empty env is production; `--env canary` is the canary). Build with moon, not a bare `bun run build`: the moon task sets `VITE_CONTENT_ORIGIN` and `VITE_EDITOR_ORIGINS`, which put project code on https://run.runbun.dev (a build without them runs it on the editor's origin). The same Worker and assets answer on run.runbun.dev (run-canary.runbun.dev for the canary), created as custom domains by `wrangler deploy`: there `/api/*` and `/s/*` are refused and the editor's pages redirect to https://runbun.dev (`CONTENT_HOST`, `EDITOR_ORIGIN` in `wrangler.jsonc`). The editor origins include http://127.0.0.1:7357, the local runner's page (`packages/connect`).
It serves only on the custom domain https://runbun.dev: `workers_dev` and `preview_urls` are off, so search engines
don't find a duplicate copy of the site (the same goes for the docs and both canaries).
A small Worker (`worker/index.ts`) runs first only on `/api/*`, `/s/*` and the editor's HTML pages (so the content host can redirect them), for opt-in short links: `POST /api/short`
stores a share payload in the `LINKS` KV namespace under a content-hash id (rate-limited per IP by `CREATE_LIMIT`,
capped at ~64 KB packed) and `GET /s/<id>` redirects to `/#code=…`. `POST /api/feedback` (the playground's Feedback
dialog and the docs' page rating, which it allows by CORS from `DOCS_ORIGIN`) stores a row in the `FEEDBACK` D1
database (schema in `worker/migrations/`; `FEEDBACK_LIMIT` per IP); `bun scripts/feedback.ts` lists them and the
ratings per page. Everything else is the static site. It fits the Workers Free plan (1,000 new links a day, KV's write
limit; D1 allows 100,000 rows written a day). `bun run typecheck:worker` regenerates its types; locally,
`bunx wrangler dev --local` runs it (pass `--compatibility-date` if your workerd is older than `wrangler.jsonc`'s).
A fork deploying under its own account should drop or replace the `routes` entry and create its own KV namespace
(`bunx wrangler kv namespace create runbun-links`) and D1 database (`bunx wrangler d1 create runbun-feedback`, then
`bunx wrangler d1 migrations apply FEEDBACK --remote`).
