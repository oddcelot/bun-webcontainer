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
| `Bun.file` | 🟡 Partial | A `Blob`: `size`, `type`, `slice`, `stream`, `text`, `json`, `bytes`, `arrayBuffer`, plus `exists`, `name`, `lastModified`, `write`, `writer`, `delete`. Reads are live, but `new Response(file)` sends the file as it was when `Bun.file()` was called. No file descriptors. |
| `Bun.write` | 🟡 Partial | Destination is a path, `file:` URL, `BunFile`, `Bun.stdout` or `Bun.stderr` (file descriptors aren't). Accepts strings, `BunFile`, `Blob`, `Response`, `ArrayBuffer`, typed arrays. Creates parent folders. |
| `Bun.build` | 🟡 Partial | Bun's real bundler, as wasm (~7.5 MB, loaded on first use). Supports `entrypoints`, `outdir`, `target`, `format`, `minify`, `splitting`, `sourcemap`, `naming`, `publicPath`, `external`, `define`, `conditions`, `banner`, `footer`, `throw`. `plugins` are ignored with a warning; `loader`, `env`, `packages`, `drop`, `compile`, `root` aren't supported. |
| `Bun.env` | ✅ Works | Same object as `process.env`; starts as `{ NODE_ENV: "development" }`. `.env` files aren't loaded. |
| `Bun.version`, `Bun.revision` | ✅ Works | `Bun.revision` is the Bun commit the wasm crates are built from. |
| `Bun.semver` | ✅ Works | `order` and `satisfies`, from Bun's own semver code. |
| `Bun.sleep`, `Bun.sleepSync` | ✅ Works | `sleepSync` blocks the program's worker (`Atomics.wait`). |
| `Bun.nanoseconds` | ✅ Works | Browser clock resolution. |
| `Bun.inspect`, `Bun.deepEquals`, `Bun.escapeHTML` | ✅ Works | `inspect` is Bun's format with its `depth`, `colors`, `sorted` and `compact` options, and `Bun.inspect.table`. Request, Response, Blob/File, FormData, URL, URLSearchParams, Headers, MessageEvent/ErrorEvent and React elements print as in Bun (Headers sorted). A promise shows `<pending>` whatever its state. Keys print strings first, then symbols. |
| `Bun.main`, `Bun.argv` | ✅ Works | `Bun.main` is the entry's path; `Bun.argv` is `["bun", main]`, as `process.argv`. |
| `Bun.stdout`, `Bun.stderr` | 🟡 Partial | Work as `Bun.write` destinations and print to the console. No `writer()`. |
| `Bun.which` | ⚪ Stub | Returns `null`: there are no executables. |
| `Bun.gc` | ⚪ Stub | Does nothing. |
| `Bun.spawn`, `Bun.spawnSync`, `Bun.$` | ❌ Missing | No processes in the browser. |
| `Bun.CryptoHasher` | ✅ Works | md5, ripemd160, sha1, sha2, sha3, blake2; HMAC with a key; `copy`, static `hash`. No md4 or shake. |
| `Bun.hash` | 🟡 Partial | `wyhash` (the default), `adler32`, `crc32`, `xxHash32`, `xxHash64`, `murmur32v2`, `murmur32v3`, `murmur64v2`, all matching Bun's output. `cityHash32`, `cityHash64`, `xxHash3` and `rapidhash` throw. |
| `Bun.password` | ✅ Works | `hash`, `hashSync`, `verify`, `verifySync` with argon2id (the default), argon2i, argon2d and bcrypt, through the argon2 and bcrypt code Bun uses (as wasm). Hashes made here verify in Bun and the other way round. `hash` and `verify` run in a worker of their own, so the program keeps running while they work (about a quarter second for a hash with the defaults); the worker stops 10 seconds after its last job and frees argon2's memory. `hashSync` and `verifySync` run on the program's thread, as in Bun, and block it. |
| `Bun.Glob` | ✅ Works | Bun's own matcher and walker (`bun_glob`, as wasm) over the project's files: `match`, `scan`, `scanSync` with `cwd`, `dot`, `absolute`, `onlyFiles`, `followSymlinks`, `throwErrorOnBrokenSymlink`. The default `cwd` is `process.cwd()` (`/`). |
| `Bun.Transpiler` | 🟡 Partial | Bun's own parser and printer, as wasm (~3 MB, loaded on first use): `transformSync`, `transform`, `scan`, `scanImports` give Bun's output for the `js`, `jsx`, `ts` and `tsx` loaders, and `transformSync`/`transform`/`scan` also take the `json`, `jsonc`, `json5`, `toml`, `yaml`, `xml` and `text` loaders per call. `define` works as in Bun, with its defaults (`process.env.NODE_ENV` and `process.env.BUN_ENV` from `process.env.NODE_ENV`, else `"development"`; `process.browser` from `target`), and so do `exports` (`eliminate`, `replace`), `minify`, `minifyWhitespace`, `inline`, `trimUnusedImports`, `treeShaking` and `deadCodeElimination`. `tsconfig` reads `experimentalDecorators`, `emitDecoratorMetadata`, `jsx`, `jsxFactory` and `jsxFragmentFactory` (`jsxImportSource` too, though the runtime transpiler never imports the JSX runtime). Macros never run (`macro` is ignored with a warning); `target: "bun"` minifies syntax as in Bun but prints as for the browser; the `md` loader throws. |
| `Bun.resolveSync`, `Bun.resolve` | ✅ Works | Bun's resolver over the project's files; returns the file's path (`/src/x.ts`), `node:fs` for built-ins. `from` is a directory, as in Bun. Throws a `ResolveMessage` (`Cannot find module …`, `code: "ERR_MODULE_NOT_FOUND"`) when nothing matches. |
| `Bun.stdin` | ❌ Missing | |
| `Bun.sql`, `Bun.redis`, `Bun.s3` | ❌ Missing | |
| `Bun.connect`, `Bun.listen`, `Bun.udpSocket`, `Bun.dns` | ❌ Missing | No raw sockets in the browser. |
| `Bun.gzipSync`, `Bun.gunzipSync`, `Bun.deflateSync`, `Bun.inflateSync` | 🟡 Partial | `level` is the only option read. Deflate is raw, as in Bun. |
| `Bun.zstd*` | ❌ Missing | |
| `Bun.YAML`, `Bun.TOML` | ✅ Works | `parse` is Bun's own YAML and TOML parser (`bun_parsers`, as wasm), with Bun's values and errors: YAML aliases stay shared, several documents give an array, TOML dates and times are `Temporal` values. `stringify` gives Bun's output. |
| `Bun.JSONC`, `Bun.JSON5` | ✅ Works | `JSONC.parse` and `JSON5.parse` are Bun's own parsers (`bun_parsers`, as wasm), with Bun's values and errors (`JSONC Parse error: …`). `JSON5.stringify` gives Bun's output (no replacer, no `toJSON`, as in Bun); there is no `JSONC.stringify`, as in Bun. |
| `Bun.JSONL`, `Bun.XML`, `Bun.markdown` | ❌ Missing | |
| `Bun.Cookie`, `Bun.CookieMap` | ✅ Works | A port of Bun's: parsing, `set`/`delete`/`get`, `toSetCookieHeaders`, `toJSON`, iteration, `serialize`, with Bun's validation and errors. Route handlers get one as [`req.cookies`](#bunserve). |
| `Bun.plugin`, `Bun.FileSystemRouter`, `Bun.mmap` | ❌ Missing | |
| `HTMLRewriter` | ❌ Missing | |

Try a few of them:

```ts playground title="index.ts"
await Bun.write("notes.txt", "written with Bun.write\n");
const file = Bun.file("notes.txt");
console.log(file.size, await file.text());

console.log(Bun.semver.satisfies("1.2.3", "^1.0.0"), Bun.semver.order("1.0.0", "2.0.0"));
console.log(new Bun.CryptoHasher("sha256").update("bun").digest("hex"));
console.log(Bun.hash("bun"));

const zipped = Bun.gzipSync("hello hello hello hello");
console.log(zipped.length, "bytes:", new TextDecoder().decode(Bun.gunzipSync(zipped)));
console.log(Bun.inspect({ deep: { map: new Map([["a", 1]]) } }));
```

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
| `req.cookies` | 🟡 Partial | A `Bun.CookieMap` over the request's Cookie header, in `routes` handlers (a `fetch` handler's request has none, as in Bun). What a handler sets or deletes in it by the time it returns goes out as Set-Cookie headers after the response's own. Not sent on a WebSocket upgrade, which Bun does. |
| Cookies | ✅ Works | Kept in a cookie jar on the page. `cookies` in the console lists them. |
| TLS | ❌ Missing | |
| `error`, `idleTimeout`, `maxRequestBodySize`, `unix`, `reusePort` | ❌ Missing | A throwing handler returns a plain-text 500; the error prints as Bun's development server prints it, then `GET - /path failed`. |
| `server.requestIP`, `server.timeout`, `server.ref`/`unref` | ❌ Missing | |

Routes with parameters, JSON and a streamed response. Send requests from the bar above the preview:

```ts playground mode=preview title="index.ts"
const server = Bun.serve({
  routes: {
    "/": new Response("Try /hello/you, /json or /stream"),
    "/hello/:name": (req) => new Response(`Hello, ${req.params.name}!`),
    "/json": () => Response.json({ ok: true, at: Date.now() }),
    "/stream": () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            for (const word of ["streamed ", "one ", "chunk ", "at a time"]) {
              controller.enqueue(new TextEncoder().encode(word));
              await Bun.sleep(300);
            }
            controller.close();
          },
        }),
      ),
  },
});

console.log(`Listening on ${server.url}`);
```

## `bun:*` modules

| Module | Status | Notes |
|---|---|---|
| `bun:sqlite` | 🟡 Partial | Built on sql.js. `Database` with `query`, `prepare`, `run`, `transaction`, `serialize`, `close`; statements with `all`, `get`, `values`, `run`, `iterate`. File databases are saved to the project. Missing: `Statement.as()`, `Database.deserialize`, `loadExtension`, `safeIntegers`, `SQLiteError`. |
| `bun:test` | 🟡 Partial | Run with `bun test` in the console. See [below](#buntest). |
| `bun:ffi`, `bun:jsc` | ❌ Missing | |
| `bun` | ✅ Works | `import { serve } from "bun"` and the default export are the `Bun` global. |

```ts playground title="index.ts"
import { Database } from "bun:sqlite";

const db = new Database(":memory:");
db.run("create table todos (id integer primary key, title text, done integer)");

const insert = db.prepare("insert into todos (title, done) values (?, ?)");
const addAll = db.transaction((rows: [string, number][]) => rows.forEach((r) => insert.run(...r)));
addAll([["write docs", 1], ["ship embeds", 0]]);

console.log(db.query("select * from todos where done = ?").all(0));
```

### `bun:test`

- ✅ `test`/`it`/`describe` with `.skip`, `.only`, `.todo`, `.each`, `.if`, `.skipIf`, `.todoIf`
- ✅ `beforeAll`, `beforeEach`, `afterEach`, `afterAll`, `setDefaultTimeout`
- ✅ `mock()`, `spyOn()`, `jest.fn`, `jest.spyOn`
- ✅ `expect` with `.not`, `.resolves`, `.rejects`, asymmetric matchers (`anything`, `any`, `objectContaining`, `arrayContaining`, `stringContaining`, `stringMatching`) and the common matchers (`toBe`, `toEqual`, `toStrictEqual`, `toThrow`, `toMatchObject`, `toHaveProperty`, `toHaveBeenCalledWith`, …), plus Bun's extras (`toBeEmpty`, `toBeOneOf`, `toSatisfy`, `toStartWith`, `toEndWith`, `toInclude`, `toBeArray`, `toBeString`, `toBeNumber`, `toBeFunction`, `toHaveReturned*`, …)
- ❌ Snapshots, fake timers, `setSystemTime`, `mock.module`, `jest.mock`, `expect.extend`, `expect.assertions`, coverage, `test.concurrent`, `test.failing`
- Unknown matchers throw "is not supported here".
- `bun test` takes name filters but no flags.

Type `bun test` in the console to run this one:

```ts playground mode=console autorun=false title="math.test.ts"
import { describe, expect, mock, test } from "bun:test";

const add = (a: number, b: number) => a + b;

describe("add", () => {
  test("sums", () => expect(add(1, 2)).toBe(3));
  test.each([[1, 1, 2], [2, 3, 5]])("%d + %d = %d", (a, b, sum) => expect(add(a, b)).toBe(sum));
  test("mocks", () => {
    const fn = mock(add);
    fn(2, 2);
    expect(fn).toHaveBeenCalledWith(2, 2);
  });
});
```

## `import.meta` and globals

| API | Status | Notes |
|---|---|---|
| `import.meta.url`, `dirname`, `filename` | ✅ Works | `file:///<path>` in the project. |
| `import.meta.require` | ✅ Works | Any specifier, computed ones too: project files, installed packages, data files and built-ins load synchronously (see [CommonJS and `require`](/compatibility/toolchain/#commonjs-and-require)). |
| `import.meta.dir`, `file`, `path`, `main`, `env` | ✅ Works | `env` is `process.env`. In browser code (HTML imports), only `url`, `dirname` and `filename` are filled in. |
| `import.meta.resolve` | ✅ Works | As in Bun: a package resolves to its file's `file:///<path>` URL (or throws a `ResolveMessage`), a built-in to `node:x`, and a path is joined to the module's URL as written. Server code only; browser code (HTML imports) gets the browser's own, which returns the served URL. |
| `import(expr)` with a computed path | ✅ Works | |
| `fetch("file:///…")` | ✅ Works | Reads project files. Relative URLs throw. Other URLs go to the network, subject to CORS. |
| `process`, `Buffer`, `global`, timers | ✅ Works | See [Node built-ins](/compatibility/node/). |
