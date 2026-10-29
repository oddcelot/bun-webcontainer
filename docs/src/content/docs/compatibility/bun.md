---
title: Bun APIs
description: Which parts of the Bun global, bun:* modules and import.meta work in the playground.
sidebar:
  order: 2
---

Reported version: `Bun.version` is `1.4.4-browser`. Labels are explained on the [overview](/compatibility/).

## The `Bun` global

| API | Status | Notes |
|---|---|---|
| `Bun.serve` | 🟡 Partial | `fetch`, `routes`, WebSockets, streaming. See [below](#bunserve). |
| `Bun.file` | 🟡 Partial | `exists`, `text`, `json`, `bytes`, `arrayBuffer`, `name`. Not a `Blob`: no `size`, `type`, `stream`, `slice`, `writer`, `delete`. |
| `Bun.write` | 🟡 Partial | Destination is a path, `file:` URL, `BunFile`, `Bun.stdout` or `Bun.stderr` (file descriptors aren't). Accepts strings, `BunFile`, `Blob`, `Response`, `ArrayBuffer`, typed arrays. Creates parent folders. |
| `Bun.build` | 🟡 Partial | Bun's real bundler, as wasm (~10 MB, loaded on first use). Supports `entrypoints`, `outdir`, `target`, `format`, `minify`, `splitting`, `sourcemap`, `naming`, `publicPath`, `external`, `define`, `conditions`, `banner`, `footer`, `throw`. `plugins` are ignored with a warning; `loader`, `env`, `packages`, `drop`, `compile`, `root` aren't supported. |
| `Bun.env` | ✅ Works | Same object as `process.env`; starts as `{ NODE_ENV: "development" }`. `.env` files aren't loaded. |
| `Bun.version` | ✅ Works | `Bun.revision` is missing. |
| `Bun.semver` | ✅ Works | `order` and `satisfies`, from Bun's own semver code. |
| `Bun.sleep` | ✅ Works | `sleepSync` is missing. |
| `Bun.nanoseconds` | ✅ Works | Browser clock resolution. |
| `Bun.inspect`, `Bun.deepEquals`, `Bun.escapeHTML` | ✅ Works | `inspect` is `node:util`'s, without colors. |
| `Bun.main`, `Bun.argv` | ✅ Works | `Bun.main` is the entry's path; `Bun.argv` is `["bun", main]`, as `process.argv`. |
| `Bun.stdout`, `Bun.stderr` | 🟡 Partial | Work as `Bun.write` destinations and print to the console. No `writer()`. |
| `Bun.which` | ⚪ Stub | Returns `null`: there are no executables. |
| `Bun.gc` | ⚪ Stub | Does nothing. |
| `Bun.spawn`, `Bun.spawnSync`, `Bun.$` | ❌ Missing | No processes in the browser. |
| `Bun.password`, `Bun.hash`, `Bun.CryptoHasher` | ❌ Missing | Use `node:crypto` or `crypto.subtle`. |
| `Bun.Glob`, `Bun.Transpiler` | ❌ Missing | |
| `Bun.resolveSync`, `Bun.stdin` | ❌ Missing | |
| `Bun.sql`, `Bun.redis`, `Bun.s3` | ❌ Missing | |
| `Bun.connect`, `Bun.listen`, `Bun.udpSocket`, `Bun.dns` | ❌ Missing | No raw sockets in the browser. |
| `Bun.gzipSync`, `Bun.deflateSync`, `Bun.zstd*` | ❌ Missing | |
| `Bun.CookieMap`, `Bun.YAML`, `Bun.TOML`, `Bun.plugin`, `Bun.FileSystemRouter`, `Bun.mmap` | ❌ Missing | |
| `HTMLRewriter` | ❌ Missing | |

## `Bun.serve`

Servers answer requests from the [preview](/guides/features/#preview), not from the network.

| Feature | Status | Notes |
|---|---|---|
| `fetch(req, server)` | ✅ Works | |
| `routes` | ✅ Works | Exact paths, `:param` (in `req.params`), trailing `*`, per-method handlers, static `Response`s. Globs in the middle of a path (`/a/*/b`) don't match. |
| HTML imports in `routes` | ✅ Works | `import page from "./index.html"` is bundled with Bun's bundler. Assets are served under `/_bun/`. Rebuilt after any file change. No HMR. |
| WebSockets | ✅ Works | `server.upgrade(req, { data })`, `open`/`message`/`close`/`drain`, `send`, `publish`, `subscribe`, `cork`, `close`. `ping`/`pong` do nothing. Only the preview page can connect. |
| `server.publish`, `subscriberCount`, `pendingWebSockets` | ✅ Works | |
| `server.reload`, `server.stop` | ✅ Works | |
| `server.url`, `port`, `hostname` | ✅ Works | `port: 0` picks a port from 40001. |
| `export default { fetch }` | ✅ Works | Served automatically, as in Bun (Hono, Elysia). |
| Streaming responses, Server-Sent Events | ✅ Works | |
| Cookies | ✅ Works | Kept in a cookie jar on the page. `cookies` in the console lists them. |
| TLS | ❌ Missing | |
| `error`, `idleTimeout`, `maxRequestBodySize`, `unix`, `reusePort` | ❌ Missing | A throwing handler returns a plain-text 500. |
| `server.requestIP`, `server.timeout`, `server.ref`/`unref` | ❌ Missing | |

## `bun:*` modules

| Module | Status | Notes |
|---|---|---|
| `bun:sqlite` | 🟡 Partial | Built on sql.js. `Database` with `query`, `prepare`, `run`, `transaction`, `serialize`, `close`; statements with `all`, `get`, `values`, `run`, `iterate`. File databases are saved to the project. Missing: `Statement.as()`, `Database.deserialize`, `loadExtension`, `safeIntegers`, `SQLiteError`. |
| `bun:test` | 🟡 Partial | Run with `bun test` in the console. See [below](#buntest). |
| `bun:ffi`, `bun:jsc` | ❌ Missing | |
| `bun` | ✅ Works | `import { serve } from "bun"` and the default export are the `Bun` global. |

### `bun:test`

- ✅ `test`/`it`/`describe` with `.skip`, `.only`, `.todo`, `.each`, `.if`, `.skipIf`, `.todoIf`
- ✅ `beforeAll`, `beforeEach`, `afterEach`, `afterAll`, `setDefaultTimeout`
- ✅ `mock()`, `spyOn()`, `jest.fn`, `jest.spyOn`
- ✅ `expect` with `.not`, `.resolves`, `.rejects`, asymmetric matchers (`anything`, `any`, `objectContaining`, `arrayContaining`, `stringContaining`, `stringMatching`) and the common matchers (`toBe`, `toEqual`, `toStrictEqual`, `toThrow`, `toMatchObject`, `toHaveProperty`, `toHaveBeenCalledWith`, …), plus Bun's extras (`toBeEmpty`, `toBeOneOf`, `toSatisfy`, `toStartWith`, `toEndWith`, `toInclude`, `toBeArray`, `toBeString`, `toBeNumber`, `toBeFunction`, `toHaveReturned*`, …)
- ❌ Snapshots, fake timers, `setSystemTime`, `mock.module`, `jest.mock`, `expect.extend`, `expect.assertions`, coverage, `test.concurrent`, `test.failing`
- Unknown matchers throw "is not supported here".
- `bun test` takes name filters but no flags.

## `import.meta` and globals

| API | Status | Notes |
|---|---|---|
| `import.meta.url`, `dirname`, `filename` | ✅ Works | `file:///<path>` in the project. |
| `import.meta.require` | 🟡 Partial | String literals only (`import.meta.require("x")`). |
| `import.meta.dir`, `file`, `path`, `main`, `env` | ✅ Works | `env` is `process.env`. In browser code (HTML imports), only `url`, `dirname` and `filename` are filled in. |
| `import.meta.resolve` | ❌ Missing | The browser's own returns the served URL, not a project path. |
| `import(expr)` with a computed path | ✅ Works | |
| `fetch("file:///…")` | ✅ Works | Reads project files. Relative URLs throw. Other URLs go to the network, subject to CORS. |
| `process`, `Buffer`, `global`, timers | ✅ Works | See [Node built-ins](/compatibility/node/). |
