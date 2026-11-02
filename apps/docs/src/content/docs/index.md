---
title: Overview
description: What the playground is and how it runs your code.
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

Because the runtime is a set of shims, not every Bun or Node API is there yet. Check [Compatibility](/compatibility/) before porting a project, and the [Features](/guides/features/) tour for what the playground can do.
