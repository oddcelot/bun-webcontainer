---
title: Frameworks
description: "Frameworks and projects known to run on Bun in the browser, including Elysia, Hono, Vite, Astro and Lit SSR, each with a link that opens it in the playground."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Frameworks that run on Bun in the browser: Elysia, Hono, Vite, Astro | Run Bun"
sidebar:
  order: 5
---

These ship as examples in the playground (project gallery → Examples). Unless noted, they were checked in Chrome.

| Project | Status | Notes |
|---|---|---|
| [Elysia](https://runbun.dev/?example=elysia-demo) 1.4 | ✅ Works | Every route returns the same status and body as real Bun. |
| [Elysia 2 (rc)](https://runbun.dev/?example=elysia2-demo) | ✅ Works | Plugins, macros, guards, models and validation (422 problem+json), cookies, error classes, server-sent events, a WebSocket chat with pub/sub, and an HTML page that uses them. Every route returns the same status and body as real Bun. Elysia compiles handlers at runtime; its build-time AOT plugin (`elysia/plugin/aot/bun`) doesn't run, as `Bun.build` ignores `plugins`. |
| [Hono](https://runbun.dev/?example=hono) | ✅ Works | Routes, params, JSON bodies and the logger middleware. The [Bun starter template](https://runbun.dev/?repo=honojs/starter/tree/main/templates/bun) opens from GitHub too. |
| [Lit SSR + Elysia](https://runbun.dev/?example=lit-ssr-guestbook) | ✅ Works | Streams Lit SSR, hydrates, uses `bun:sqlite` and WebSockets. |
| [Solid 2 SSR](https://runbun.dev/?example=solid-ssr-dashboard) | ✅ Works | No framework: `Bun.serve` streams the page panel by panel (`renderToStream`), `Bun.build` bundles the script that hydrates it, and a Bun plugin compiles the JSX with `@solidjs/compiler`. Optimistic actions over `bun:sqlite`. |
| [Solid 2 + Vite](https://runbun.dev/?example=solid-vite-hmr) | ✅ Works | Vite 8 dev server with `@solidjs/vite-plugin`. Hot module replacement: a saved component is swapped in the running page and the state above it stays; an edit to the entry file reloads the page. |
| [Astro + Solid](https://runbun.dev/?example=astro-solid-demo) | ✅ Works | Astro 7 dev server with its default config: on-demand pages, a hydrated Solid island, an API route, the dev toolbar, and HMR (Solid edits swap in place, `.astro` edits reload the page). |
| [Vite](https://runbun.dev/?example=vite-demo) | ✅ Works | Vite 8 dev server, started from a script with `createServer()`. HMR works over the preview's WebSocket: CSS edits apply in place, other edits reload the page as Vite decides. |
| [Lit + Vite CLI](https://runbun.dev/?repo=oddcelot/lit-devtools/tree/main/examples/flame) | ✅ Works | `"dev": "vite"` with a `vite.config.ts`, from GitHub. Run starts Vite's CLI; the config's plugin parses with oxc-parser's wasm binding. |
| [Node built-ins demo](https://runbun.dev/?example=node-demo) | ✅ Works | Output matches real Bun. |
| [`bun.lock` demo](https://runbun.dev/?example=lockfile-demo) | ✅ Works | Nested installs from a lockfile. |

Elysia, installed and served from this page:

```json playground mode=preview group=elysia title="package.json"
{ "dependencies": { "elysia": "^1.4.0" } }
```

```ts playground mode=preview group=elysia title="index.ts"
import { Elysia, t } from "elysia";

new Elysia()
  .get("/", () => "Hello from Elysia")
  .get("/user/:id", ({ params }) => ({ id: params.id }))
  .post("/echo", ({ body }) => body, { body: t.Object({ message: t.String() }) })
  .listen(3000);
```

The Vite and Astro examples need cross-origin isolation, which this site doesn't have; open them on runbun.dev from the table.

## What usually blocks a framework

- **CLI scripts** beyond one command, for Run. Run starts `"dev": "bun <file>"` and a package's bin (`"dev": "vite"`). `bun run build` in the console also runs a script like `tsc && vite build` in Bun's shell, each command a child process. A server a child starts answers the preview when the program serves none itself; if a framework's CLI doesn't run here, start its dev server from a file instead (for example `createServer()` in Vite, `dev()` in Astro).
- **Native bindings** without a wasm fallback.
- **Tools that spawn something other than** `bun`, `node`, a `package.json` script or an installed bin (`git`, `esbuild`'s native binary), or that spawn synchronously (`execSync`) on a page that isn't cross-origin isolated.
- **Install scripts**, which never run.

Tried something? [Tell us](#page-feedback) whether it worked.
