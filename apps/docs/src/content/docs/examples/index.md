---
title: "Bun examples you can run in your browser"
description: "Runnable Bun examples: Bun.serve, routes, WebSockets, bun:sqlite, Bun.file, Bun.password, Elysia and Hono. Press Run and they execute in your browser tab."
sidebar:
  order: 0
  label: All examples
---

Each page has a short program and what it shows. Press **Run** and it executes right on the page: Bun's toolchain compiled to WebAssembly and its APIs as shims, in your browser, with nothing to install and no server. The ⋯ menu on an example opens it in the full [playground](https://runbun.dev/), where you can change it and share it.

## Servers

- [Bun.serve hello world](/examples/bun-serve/): the smallest HTTP server, a `fetch` handler
- [Routes and a JSON API](/examples/bun-serve-routes/): `routes`, path parameters, per-method handlers
- [WebSocket chat](/examples/bun-websocket/): `server.upgrade`, the `websocket` handlers, pub/sub

## Bun's built-ins

- [bun:sqlite](/examples/bun-sqlite/): an in-memory SQLite database with prepared statements
- [Bun.file and Bun.write](/examples/bun-file/): read and write text and JSON files
- [Bun.password](/examples/bun-password/): hash and verify passwords with argon2 or bcrypt

## Frameworks

- [Elysia](/examples/elysia/): a typed API with body validation
- [Hono](/examples/hono/): routes and middleware, served with `export default`

[Frameworks](/compatibility/frameworks/) lists more projects that run, including Vite and Astro dev servers.
