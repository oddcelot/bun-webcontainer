---
title: Frameworks
description: Frameworks and projects known to run in the playground.
sidebar:
  order: 5
---

These ship as examples in the playground (project picker → Examples). Unless noted, they were checked in Chrome.

| Project | Status | Notes |
|---|---|---|
| [Elysia](https://runbun.dev/?example=elysia-demo) 1.4 | ✅ Works | Every route returns the same status and body as real Bun. |
| [Elysia 2 (rc)](https://runbun.dev/?example=elysia2-demo) | ✅ Works | Plugins, macros, guards, models and validation (422 problem+json), cookies, error classes, server-sent events, a WebSocket chat with pub/sub, and an HTML page that uses them. Every route returns the same status and body as real Bun. Elysia compiles handlers at runtime; its build-time AOT plugin (`elysia/plugin/aot/bun`) doesn't run, as `Bun.build` ignores `plugins`. |
| [Hono](https://runbun.dev/?repo=honojs/starter/tree/main/templates/bun) | ✅ Works | Bun starter template, from GitHub. Installs and serves `Hello Hono!`. |
| [Lit SSR + Elysia](https://runbun.dev/?repo=oddcelot/lit-devtools/tree/main/examples/elysia) | ✅ Works | Streams Lit SSR, hydrates, uses `bun:sqlite` and WebSockets. |
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

- **CLI scripts** beyond one command. `"dev": "bun <file>"` and a package's bin (`"dev": "vite"`) run; `tsc && vite`, pipes, variables and `npx` don't. Start the dev server from a file instead (for example `createServer()` in Vite, `dev()` in Astro).
- **Native bindings** without a wasm fallback.
- **Child processes** (`child_process`, `Bun.spawn`).
- **Install scripts**, which never run.

Tried something? [Tell us](#page-feedback) whether it worked.
