---
title: Overview
description: "runbun.dev runs Bun in your browser: Bun's Rust crates compiled to wasm64, JavaScript shims for the runtime APIs and a virtual file system. How it works, what it's for and where to start."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Run Bun docs: the Bun playground that runs in your browser"
---

The playground runs a Bun project entirely in your browser:

- **Bun's own code, compiled to wasm64.** The transpiler, bundler and semver come from Bun's Rust crates that don't depend on JavaScriptCore, built for 64-bit WebAssembly (Memory64).
- **JS shims for the runtime.** `Bun.*`, `bun:*` and `node:*` APIs are implemented in JavaScript on top of the browser's engine.
- **A virtual file system.** Your project lives in memory and is saved to the browser's storage.
- **A service worker** serves your modules and the preview of `Bun.serve` and `node:http` servers.

Try it: this server runs in your browser when you click Run.

```ts playground mode=preview title="index.ts"
const server = Bun.serve({
  routes: {
    "/": () => new Response("<h1>Hello from Bun.serve</h1><a href='/api/time'>/api/time</a>", { headers: { "content-type": "text/html" } }),
    "/api/time": () => Response.json({ now: new Date().toISOString(), bun: Bun.version }),
  },
});

console.log(`Listening on ${server.url}`);
```

## What it's for

- **Trying Bun without installing it.** Open [runbun.dev](https://runbun.dev/), edit the demo or pick an example, and press Run. There's no account and nothing to install.
- **Sharing a reproduction.** A share link carries the whole project in its URL, so a bug report can be one link. [Reproduce a bug with an agent](/guides/agent-repro/) shows how to make one, by hand or with a coding agent.
- **Runnable examples in docs and posts.** The [`<bun-playground>` element](/guides/embedding/), or [`@runbun/astro`](/guides/astro/) in an Astro site, turns a code block into one that runs in the reader's browser. The [examples](/examples/) on this site are built that way.
- **Checking a package or a framework.** `bun install` fetches packages from npm, and [frameworks](/compatibility/frameworks/) like Elysia, Hono, Vite and Astro run with their dev servers.

[Use cases](/guides/use-cases/) has a recommendation for each of these, and more: what to start from and what to use.

## What it isn't

runbun.dev is not Bun itself. Your code runs in the browser's JavaScript engine, not in Bun's JavaScriptCore, and the runtime APIs are reimplemented on top of it. A browser has no processes and no raw sockets, so `Bun.spawn`, `Bun.connect` and native `.node` addons are missing (`Bun.$` runs Bun's builtins, not other programs), and everything else is marked API by API in [Compatibility](/compatibility/). Running code needs WebAssembly Memory64, which Chrome, Edge, Firefox and Safari Technology Preview have and Safari doesn't yet ([Browsers](/compatibility/browsers/)). [Bun APIs](/compatibility/bun/) names the Bun release the playground is built from.

runbun is an independent project, not affiliated with or endorsed by Oven or Bun. For what to start from, see [Use cases](/guides/use-cases/); for what the playground can do, take the [Features](/guides/features/) tour.
