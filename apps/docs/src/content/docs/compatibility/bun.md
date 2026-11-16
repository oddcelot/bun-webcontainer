---
title: Bun APIs
description: "The status of every Bun API in the browser playground: Bun.serve, Bun.file, Bun.build, Bun.password, bun:sqlite, bun:test and more, each marked Works, Partial, Stub or Missing."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Bun API compatibility in the browser: Bun.serve, bun:sqlite, bun:test | Run Bun"
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
| `Bun.build` | 🟡 Partial | Bun's real bundler, as wasm (~7.5 MB, loaded on first use). Supports `entrypoints`, `outdir`, `target`, `format`, `minify`, `splitting`, `sourcemap`, `naming`, `publicPath`, `external`, `define`, `conditions`, `banner`, `footer`, `throw`. `plugins` throw (they can't run in the wasm bundler); `loader`, `env`, `packages`, `drop`, `compile`, `root` aren't supported. |
| `Bun.env` | ✅ Works | Same object as `process.env`; starts as `{ NODE_ENV: "development" }`. `.env` files aren't loaded. |
| `Bun.version`, `Bun.revision` | ✅ Works | `Bun.revision` is the Bun commit the wasm crates are built from. |
| `Bun.semver` | ✅ Works | `order` and `satisfies`, from Bun's own semver code. |
| `Bun.sleep`, `Bun.sleepSync` | ✅ Works | `sleepSync` blocks the program's worker (`Atomics.wait`). |
| `Bun.nanoseconds` | ✅ Works | Browser clock resolution. |
| `Bun.inspect`, `Bun.deepEquals`, `Bun.escapeHTML` | ✅ Works | `inspect` is Bun's format with its `depth`, `colors`, `sorted` and `compact` options, and `Bun.inspect.table`. Request, Response, Blob/File, FormData, URL, URLSearchParams, Headers, MessageEvent/ErrorEvent and React elements print as in Bun (Headers sorted). A promise shows its state if one of the playground's APIs returned it (`fetch`, `Bun.file` reads, `Bun.write`, `Bun.sleep`, `fs.promises`) and `<pending>` otherwise, e.g. `Promise.resolve(1)` or an async function's result: their state isn't readable from JS. Keys print strings first, then symbols. |
| `Bun.main`, `Bun.argv` | ✅ Works | `Bun.main` is the entry's path; `Bun.argv` is `["bun", main]`, as `process.argv`. |
| `Bun.stdout`, `Bun.stderr` | 🟡 Partial | Work as `Bun.write` destinations and print to the console. No `writer()`. |
| `Bun.which` | ⚪ Stub | Returns `null`: there are no executables. |
| `Bun.gc` | ⚪ Stub | Does nothing. |
| `Bun.$` | 🟡 Partial | Bun's shell: its own parser (as wasm), then an interpreter with Bun's builtins over the project's files: `echo`, `cd`, `pwd`, `ls`, `cat`, `touch`, `mkdir`, `rm`, `mv`, `cp`, `which`, `export`, `exit`, `true`, `false`, `yes`, `seq`, `dirname`, `basename`. Pipes, `&&`/`\|\|`/`;`, subshells, `if`, `[[ ]]`, redirects (to files and to buffers), `$VAR`, `$(…)`, `~`, `{a,b}` and `*`/`**` globs work as in Bun, as do `.text()`, `.json()`, `.lines()`, `.quiet()`, `.nothrow()`, `.cwd()`, `.env()`, `ShellError`, `$.escape` and `$.braces`. Other commands run as child processes (see `Bun.spawn`), with their output in the pipeline; one that isn't there is `command not found`. |
| `Bun.spawn` | 🟡 Partial | Starts a child process: `stdin`, `stdout` and `stderr` as `"pipe"` (a FileSink for stdin, ReadableStreams for output), `"inherit"` or `"ignore"`, and stdin fed from bytes, a Blob or `Bun.file`, a Response or a ReadableStream. `exited`, `exitCode`, `signalCode`, `killed`, `kill`, `ref`/`unref`, `onExit`, `cwd`, `env`, `timeout`, `signal`. A command that isn't there throws `ENOENT`. What a child can run: `bun` or `node` with a file, `bun run` with a `package.json` script or a file, an installed package's bin (`vite`, `tsc`), and `sh -c` lines and the shell's builtins, which Bun's shell runs. Each child runs in a worker of its own, on the project's files as they are when it starts; what it writes reaches the others. One that can't start (the tab out of memory for another process) exits with code 1 and says why on stderr. A server a child starts answers the preview when the program serves none itself (a script that runs `bun server.ts`) or when it is picked in the status bar's port list, and a preview WebSocket to its port reaches it. A child's server on a port another process of the program already serves throws `EADDRINUSE`, as in Bun. No `ipc` or `resourceUsage`. |
| `Bun.spawnSync` | 🟡 Partial | Only on a cross-origin isolated page: runbun.dev, or an embed whose host page sends `COOP` and `COEP` (see [Browsers](/compatibility/browsers/)). Elsewhere it throws a `NotIsolatedError` (code `ERR_NOT_ISOLATED`): blocking the program until the child ends needs `SharedArrayBuffer` and `Atomics.wait`. Runs the same commands as `Bun.spawn` and returns `stdout` and `stderr` as Buffers of any size, `exitCode`, `signalCode`, `success` and `exitedDueToTimeout`, with `cwd`, `env`, stdin from bytes (a string throws, as in Bun), `stdout`/`stderr` as `"pipe"`, `"inherit"` or `"ignore"`, `timeout`, `killSignal` and `maxBuffer`. The files the child writes are there when it returns. No `resourceUsage`. |
| `Bun.CryptoHasher` | ✅ Works | md5, ripemd160, sha1, sha2, sha3, blake2; HMAC with a key; `copy`, static `hash`. No md4 or shake. |
| `Bun.hash` | 🟡 Partial | `wyhash` (the default), `adler32`, `crc32`, `xxHash32`, `xxHash64`, `murmur32v2`, `murmur32v3`, `murmur64v2`, all matching Bun's output. `cityHash32`, `cityHash64`, `xxHash3` and `rapidhash` throw. |
| `Bun.password` | ✅ Works | `hash`, `hashSync`, `verify`, `verifySync` with argon2id (the default), argon2i, argon2d and bcrypt, through the argon2 and bcrypt code Bun uses (as wasm). Hashes made here verify in Bun and the other way round. `hash` and `verify` run in a worker of their own, so the program keeps running while they work (about a quarter second for a hash with the defaults); the worker stops 10 seconds after its last job and frees argon2's memory. `hashSync` and `verifySync` run on the program's thread, as in Bun, and block it. |
| `Bun.Glob` | ✅ Works | Bun's own matcher and walker (`bun_glob`, as wasm) over the project's files: `match`, `scan`, `scanSync` with `cwd`, `dot`, `absolute`, `onlyFiles`, `followSymlinks`, `throwErrorOnBrokenSymlink`. The default `cwd` is `process.cwd()` (`/`). |
| `Bun.Transpiler` | 🟡 Partial | Bun's own parser and printer, as wasm (~3 MB, loaded on first use): `transformSync`, `transform`, `scan`, `scanImports` give Bun's output for the `js`, `jsx`, `ts` and `tsx` loaders, and `transformSync`/`transform`/`scan` also take the `json`, `jsonc`, `json5`, `toml`, `yaml`, `xml`, `text` and `md` loaders per call (`md` is Bun's Markdown renderer: the HTML as the default export). `define` works as in Bun, with its defaults (`process.env.NODE_ENV` and `process.env.BUN_ENV` from `process.env.NODE_ENV`, else `"development"`; `process.browser` from `target`), and so do `exports` (`eliminate`, `replace`), `minify`, `minifyWhitespace`, `inline`, `trimUnusedImports`, `treeShaking` and `deadCodeElimination`. `tsconfig` reads `experimentalDecorators`, `emitDecoratorMetadata`, `jsx`, `jsxFactory` and `jsxFragmentFactory` (`jsxImportSource` too, though the runtime transpiler never imports the JSX runtime). `target: "bun"` prints as Bun does for its own runtime: syntax minified, strings ASCII-escaped, `using` kept, `var {require}=import.meta;` in an ES module that uses `require`. Macros never run (`macro` is ignored with a warning). |
| `Bun.resolveSync`, `Bun.resolve` | ✅ Works | Bun's resolver over the project's files; returns the file's path (`/src/x.ts`), `node:fs` for built-ins. `from` is a directory, as in Bun. Throws a `ResolveMessage` (`Cannot find module …`, `code: "ERR_MODULE_NOT_FOUND"`) when nothing matches. |
| `Bun.stdin` | ❌ Missing | |
| `Bun.sql`, `Bun.redis`, `Bun.s3` | ❌ Missing | |
| `Bun.connect`, `Bun.listen`, `Bun.udpSocket`, `Bun.dns` | ❌ Missing | No raw sockets in the browser. |
| `Bun.gzipSync`, `Bun.gunzipSync`, `Bun.deflateSync`, `Bun.inflateSync` | 🟡 Partial | `level` is the only option read. Deflate is raw, as in Bun. |
| `Bun.zstd*` | ❌ Missing | |
| `Bun.YAML`, `Bun.TOML` | ✅ Works | `parse` is Bun's own YAML and TOML parser (`bun_parsers`, as wasm), with Bun's values and errors: YAML aliases stay shared, several documents give an array, TOML dates and times are `Temporal` values. `stringify` gives Bun's output. |
| `Bun.JSONC`, `Bun.JSON5` | ✅ Works | `JSONC.parse` and `JSON5.parse` are Bun's own parsers (`bun_parsers`, as wasm), with Bun's values and errors (`JSONC Parse error: …`). `JSON5.stringify` gives Bun's output (no replacer, no `toJSON`, as in Bun); there is no `JSONC.stringify`, as in Bun. |
| `Bun.JSONL` | ✅ Works | `parse` and `parseChunk` (strings, typed arrays, `start`/`end` offsets) as Bun's: one value per line, `parse` keeps the values before a bad line and throws only if the first is bad; `parseChunk` reports `read` (bytes for a buffer), `done` and `error`, telling a value cut off at the end of the chunk from a wrong one as JavaScriptCore does. |
| `Bun.XML` | ✅ Works | `parse` is Bun's own XML parser (`bun_parsers`, in the transpiler's wasm, loaded on first use): the compact object or, with `{ compact: false }`, the node tree, with Bun's errors; a buffer or Blob gets BOM, UTF-16 and encoding-declaration detection, a string is parsed as text. `stringify` gives Bun's output and errors for both shapes (a Proxy is an object, as in Bun); very deep nesting runs out of stack at a different depth than in Bun (both throw `RangeError: Maximum call stack size exceeded.`). |
| `Bun.markdown` | ✅ Works | Bun's Markdown parser and renderers (`bun_md`, in the transpiler's wasm, loaded on first use): `html` and `ansi` (themes, wrapping at `columns`; `light` defaults from `COLORFGBG`, which the playground doesn't set) give Bun's output, with Bun's options. `render` calls the callbacks with Bun's children and metadata, in Bun's order; `react` returns React elements (`react.transitional.element`, or `react.element` with `reactVersion` 18 or lower) with the components given. |
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
| HTML imports in `routes` | ✅ Works | `import page from "./index.html"` is bundled with Bun's bundler. Assets are served under `/_bun/`, with inline source maps, so DevTools shows the original source. Rebuilt after any file change. No HMR. |
| WebSockets | ✅ Works | `server.upgrade(req, { data, headers })` (of `headers`, only Set-Cookie has an effect: the page's socket never sees the others), `open`/`message`/`close`/`drain`, `send`, `publish`, `subscribe`, `cork`, `close`. `ping`/`pong` do nothing. Only the preview page can connect. |
| `server.publish`, `subscriberCount`, `pendingWebSockets` | ✅ Works | |
| `server.reload`, `server.stop` | ✅ Works | |
| `server.url`, `port`, `hostname` | ✅ Works | `port: 0` picks a port from 40001. |
| A port in use | ✅ Works | A server on a port the program or one of its child processes already serves throws Bun's error (`code` `EADDRINUSE`, `syscall` `listen`, "Failed to start server. Is port 3000 in use?"). Two processes that start a server on the same port at the same moment can both get it; the preview then goes to the one started first. |
| `export default { fetch }` | ✅ Works | Served automatically, as in Bun (Hono, Elysia). |
| Streaming responses, Server-Sent Events | ✅ Works | |
| `req.cookies` | ✅ Works | A `Bun.CookieMap` over the request's Cookie header, in `routes` handlers (a `fetch` handler's request has none, as in Bun). What a handler sets or deletes in it by the time it returns goes out as Set-Cookie headers after the response's own; on a WebSocket upgrade, the Set-Cookie headers of `upgrade`'s `headers` option and what the handler set or deleted before calling `server.upgrade(req)` go to the cookie jar, as Bun sends them on the 101; a handler that returns a Response instead of upgrading sends that Response's Set-Cookie headers and its `req.cookies` changes, which go to the jar too. |
| Cookies | ✅ Works | Kept in the browser's own cookie store under the preview's path (`/__preview/@<tab>/`), so a preview page's scripts read them with `document.cookie`, cookies those scripts set reach the server, and DevTools lists them under Application → Cookies. HttpOnly cookies are kept in the page's memory instead, out of the scripts' reach, so DevTools doesn't show them. Cookies with a narrower `Path` (`/admin`, as a script on `/admin/page` sets one by default) reach the server for requests under it, with the scripts' changes. The preview's path changes with every tab and reload, so the next preview to serve a request deletes the cookies a closed tab's preview had. In an embed on another site the browser refuses the preview's cookies: the server's are kept in the page's memory, and those scripts set don't reach the server. `cookies` in the console lists them all, `cookies clear` deletes them. |
| TLS | ❌ Missing | |
| `server.ref`/`unref` | ✅ Works | A server keeps the program running until it stops, unless `unref`'d. |
| `error`, `idleTimeout`, `maxRequestBodySize`, `unix`, `reusePort` | ❌ Missing | A throwing handler returns a plain-text 500; the error prints as Bun's development server prints it, then `GET - /path failed`. |
| `server.requestIP`, `server.timeout` | ❌ Missing | |

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

- ✅ `test`/`it`/`describe` with `.skip`, `.only`, `.todo`, `.each`, `.if`, `.skipIf`, `.todoIf`, `.failing` (passes when the test throws, fails with Bun's message when it doesn't), and `.concurrent`/`.serial` (accepted; tests run one after another)
- ✅ `beforeAll`, `beforeEach`, `afterEach`, `afterAll`, `setDefaultTimeout`
- ✅ `mock()`, `spyOn()`, `jest.fn`, `jest.spyOn`
- ✅ `expect` with `.not`, `.resolves`, `.rejects`, asymmetric matchers (`anything`, `any`, `objectContaining`, `arrayContaining`, `stringContaining`, `stringMatching`) and the common matchers (`toBe`, `toEqual`, `toStrictEqual`, `toThrow`, `toMatchObject`, `toHaveProperty`, `toHaveBeenCalledWith`, …), plus Bun's extras (`toBeEmpty`, `toBeOneOf`, `toSatisfy`, `toStartWith`, `toEndWith`, `toInclude`, `toBeArray`, `toBeString`, `toBeNumber`, `toBeFunction`, `toHaveReturned*`, …)
- ✅ `expect.extend` (custom matchers with `this.isNot`, `this.promise`, `this.equals` and `this.utils`' `stringify`, `printReceived`, `printExpected`, `matcherHint`; async matchers and the `expect.<name>()` asymmetric form work too), `expect.assertions(n)` and `expect.hasAssertions()`
- ✅ Fake timers: `jest.useFakeTimers()` (also `{ now }`) and `useRealTimers`, `advanceTimersByTime`, `advanceTimersToNextTimer`, `runOnlyPendingTimers`, `runAllTimers`, `clearAllTimers`, `getTimerCount`, `isFakeTimers` and `now`, on `jest` and `vi`. `setTimeout`, `setInterval`, `Date` and `Bun.sleep` run on the fake clock; `setImmediate`, `process.nextTick` and `performance.now` stay real. As in Bun, the timers stay faked into the next test until `useRealTimers()`. `runAllTimers` stops with an error after 100000 timers (Bun loops on an interval nothing clears).
- ✅ `setSystemTime(date | ms)` from `bun:test` or `jest`: `Date` is frozen at that time (or moves from it with fake timers); no argument restores the real time
- ✅ Snapshots: `toMatchSnapshot` (with a hint and property matchers) writes `__snapshots__/<file>.snap` in the project in Bun's format, byte for byte, and `toMatchInlineSnapshot` compares and fills in the call's snapshot in the test file. New snapshots are written unless the `CI` environment variable is set (in `runbun.json`'s `env`), where they fail as in Bun; `bun test -u` (`--update-snapshots`) rewrites the ones that differ. Serializing follows Bun's for plain values, arrays, Map, Set, Date, RegExp, errors, class instances and typed arrays; odd built-ins (`Math`, `Promise`, getters) can print differently. The `snapshots:` totals line is approximate.
- ❌ `mock.module`, `jest.mock`, coverage
- An uncaught error or unhandled rejection fails the test running at the time (whichever test's code threw it), as in Bun, and the run goes on.
- Unknown matchers throw "is not supported here".
- `bun test` takes name filters and `-u` / `--update-snapshots`, no other flags.

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
| `Headers#toJSON` | ✅ Works | As in Bun: a plain object of lower-cased names, values joined with `, `, Set-Cookie as an array. |
| `new Request()` headers | ✅ Works | As in Bun, `request.headers` keeps Cookie, Host, Origin, Referer and Content-Length (a browser drops them), through `clone()` and `new Request(request)` too, so `app.handle(new Request(url, { headers: { cookie } }))` sees its cookies. `fetch()` still sends only what the browser allows. |
| `process`, `Buffer`, `global`, timers | ✅ Works | See [Node built-ins](/compatibility/node/). |
| `Worker` | 🟡 Partial | Bun's Web Worker: `new Worker(new URL("./w.ts", import.meta.url))` or `new Worker("./w.ts")` (from the working directory, as in Bun) runs a project file in a worker of its own, on the project's files as they are when it starts, with Bun's `argv`, `env` (a copy of `process.env` by default), `workerData` and `ref` options. `postMessage` both ways with transfers, `onmessage` and `addEventListener` on both sides, the `open`, `message`, `error` and `close` events (`close` carries the exit code), `terminate()` and `ref`/`unref`. Inside, `self.postMessage`, `self.onmessage` and `self.addEventListener("message")` talk to the `Worker`, and so does `parentPort`; a worker listening for messages keeps running until it ends itself or is terminated. `process.exit()` in a worker ends only that worker. An uncaught error is the `Worker`'s `error` event (an `ErrorEvent` with the error's text in `message` and `error` null, as in Bun) and ends it with code 1. As in Bun 1.4, a worker has no `self.close`. After `terminate()`, `close` has code 0 (Bun gives 0, now and then 1). Only project files: `blob:`, `data:` and `http(s):` URLs throw; `preload` and `smol` are ignored. |
