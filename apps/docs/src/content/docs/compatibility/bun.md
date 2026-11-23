---
title: Bun APIs
description: "The status of every Bun API in the browser playground: Bun.serve, Bun.file, Bun.build, Bun.password, bun:sqlite, bun:test and more, each marked Works, Partial, Stub or Missing."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Bun API compatibility in the browser: Bun.serve, bun:sqlite, bun:test | Run Bun"
# The per-item sections under the tables would swamp the outline: it lists the parts of the page.
tableOfContents:
  maxHeadingLevel: 2
sidebar:
  order: 2
---

Reported version: `Bun.version` is `1.4.4-browser`. Labels are explained on the [overview](/compatibility/).

## The `Bun` global

| API | Status | Notes |
|---|---|---|
| `Bun.serve` | 🟡 Partial | `fetch`, `routes`, WebSockets, streaming. See [below](#bunserve). |
| `Bun.file` | 🟡 Partial | A `Blob` with the usual read methods plus `exists`, `write`, `writer`, `delete`. No file descriptors. [Details](#bunfile) |
| `Bun.write` | 🟡 Partial | Destination is a path, `file:` URL, `BunFile`, `Bun.stdout` or `Bun.stderr` (file descriptors aren't). Accepts strings, `BunFile`, `Blob`, `Response`, `ArrayBuffer`, typed arrays. Creates parent folders. |
| `Bun.build` | 🟡 Partial | Bun's real bundler, as wasm, loaded on first use. Most options work; `compile` doesn't. [Details](#bunbuild) |
| `Bun.env` | ✅ Works | Same object as `process.env`; starts as `{ NODE_ENV: "development" }`. `.env` files aren't loaded. |
| `Bun.version`, `Bun.revision` | ✅ Works | `Bun.revision` is the Bun commit the wasm crates are built from. |
| `Bun.semver` | ✅ Works | `order` and `satisfies`, from Bun's own semver code. |
| `Bun.sleep`, `Bun.sleepSync` | ✅ Works | `sleepSync` blocks the program's worker (`Atomics.wait`). |
| `Bun.nanoseconds` | ✅ Works | Browser clock resolution. |
| `Bun.randomUUIDv7` | ✅ Works | Time-ordered UUIDs as Bun makes them: a counter that goes up within the same millisecond, `"hex"`, `"base64"`, `"base64url"` or `"buffer"`, and a timestamp (number or `Date`). |
| `Bun.inspect`, `Bun.deepEquals`, `Bun.escapeHTML` | ✅ Works | Bun's own formats, including `Bun.inspect.table`. Promise state shows only for the playground's own promises. [Details](#buninspect-bundeepequals-bunescapehtml) |
| `Bun.main`, `Bun.argv` | ✅ Works | `Bun.main` is the entry's path; `Bun.argv` is `["bun", main]`, as `process.argv`. |
| `Bun.stdout`, `Bun.stderr` | 🟡 Partial | Work as `Bun.write` destinations and print to the console. `writer()` buffers until flushed. [Details](#bunstdout-bunstderr) |
| `Bun.which` | ⚪ Stub | Returns `null`: there are no executables. |
| `Bun.gc` | ⚪ Stub | Does nothing. |
| `Bun.$` | 🟡 Partial | Bun's shell: its parser as wasm and an interpreter with Bun's builtins over the project's files. [Details](#bun) |
| `Bun.spawn` | 🟡 Partial | Starts a child process: `bun`, `node`, `bun run`, installed bins, `sh -c`, `bun test`. No `ipc`. [Details](#bunspawn) |
| `Bun.spawnSync` | 🟡 Partial | Needs a cross-origin isolated page; elsewhere it throws `NotIsolatedError`. Runs the same commands as `Bun.spawn`. [Details](#bunspawnsync) |
| `Bun.CryptoHasher` | ✅ Works | md5, ripemd160, sha1, sha2, sha3, blake2; HMAC with a key; `copy`, static `hash`. No md4 or shake. |
| `Bun.hash` | ✅ Works | Matches Bun's output for every seed and input. A `Blob` isn't accepted. [Details](#bunhash) |
| `Bun.password` | ✅ Works | argon2id, argon2i, argon2d and bcrypt through Bun's own code, as wasm. Hashes verify in Bun too. [Details](#bunpassword) |
| `Bun.Glob` | ✅ Works | Bun's own matcher and walker over the project's files. Default `cwd` is `/`. [Details](#bunglob) |
| `Bun.Transpiler` | 🟡 Partial | Bun's parser and printer as wasm, loaded on first use. Macros never run. [Details](#buntranspiler) |
| `Bun.resolveSync`, `Bun.resolve` | ✅ Works | Bun's resolver over the project's files; throws a `ResolveMessage` when nothing matches. [Details](#bunresolvesync-bunresolve) |
| `Bun.stdin` | 🟡 Partial | What you type in the console while the program reads it, ending at <kbd>Ctrl</kbd>+<kbd>D</kbd>. No `slice` or `writer()`. [Details](#bunstdin) |
| `Bun.S3Client`, `Bun.s3` | 🟡 Partial | S3, R2, MinIO and other S3-compatible stores over `fetch`, signed as Bun signs. The bucket needs CORS rules. [Details](#buns3client-buns3) |
| `Bun.sql`, `SQL` | 🟡 Partial | Postgres runs in the tab on PGlite, kept in the project's browser storage. One connection; no network databases. [Details](#bunsql-sql) |
| `Bun.redis` | ❌ Missing | It speaks Redis's TCP protocol, which a browser can't open. |
| `Bun.connect`, `Bun.listen`, `Bun.udpSocket`, `Bun.dns` | ❌ Missing | No raw sockets in the browser. |
| `Bun.gzipSync`, `Bun.gunzipSync`, `Bun.deflateSync`, `Bun.inflateSync` | 🟡 Partial | `level` is the only option read. Deflate is raw, as in Bun. |
| `Bun.zstdCompress`, `Bun.zstdCompressSync`, `Bun.zstdDecompress`, `Bun.zstdDecompressSync` | ✅ Works | A pure-Rust zstd as wasm. Output bytes can differ from Bun's, but each side decompresses the other's. [Details](#bunzstdcompress-bunzstdcompresssync-bunzstddecompress-bunzstddecompresssync) |
| `Bun.YAML`, `Bun.TOML` | ✅ Works | `parse` is Bun's own parser as wasm, with Bun's values and errors. `stringify` gives Bun's output. [Details](#bunyaml-buntoml) |
| `Bun.JSONC`, `Bun.JSON5` | ✅ Works | Bun's own parsers as wasm, with Bun's errors. No `JSONC.stringify`, as in Bun. [Details](#bunjsonc-bunjson5) |
| `Bun.JSONL` | ✅ Works | `parse` and `parseChunk` as Bun's: one value per line, with Bun's handling of bad lines. [Details](#bunjsonl) |
| `Bun.XML` | ✅ Works | `parse` and `stringify` are Bun's own, with Bun's errors, loaded with the transpiler's wasm. [Details](#bunxml) |
| `Bun.markdown` | ✅ Works | Bun's Markdown parser and renderers as wasm: `html`, `ansi`, `render` and `react`. [Details](#bunmarkdown) |
| `Bun.Cookie`, `Bun.CookieMap` | ✅ Works | A port of Bun's: parsing, `set`/`delete`/`get`, `toSetCookieHeaders`, `toJSON`, iteration, `serialize`, with Bun's validation and errors. Route handlers get one as [`req.cookies`](#bunserve). |
| `Bun.FileSystemRouter` | ✅ Works | A port of Bun's router over the project's files, with `match()` and `reload()`. [Details](#bunfilesystemrouter) |
| `Bun.plugin` | 🟡 Partial | Runtime plugins with `onResolve` and `onLoad`; register them in a preload file. No `xml` or `md` loader. [Details](#bunplugin) |
| `Bun.mmap` | ❌ Missing | |
| `HTMLRewriter` | 🟡 Partial | Bun's own `lol-html` as wasm, loaded on first use. A string or buffer handler can't return a promise. [Details](#htmlrewriter) |

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

## `Bun` global details

The rest of the table rows above, in the same order.

### `Bun.file`
- A `Blob`: `size`, `type`, `slice`, `stream`, `text`, `json`, `bytes`, `arrayBuffer`, plus `exists`, `name`, `lastModified`, `write`, `writer`, `delete`.
- In a `FormData` it is a `File` named by its path, as in Bun.
- Reads are live, but `new Response(file)` sends the file as it was when `Bun.file()` was called.
- No file descriptors.

### `Bun.build`
Bun's real bundler, as wasm (~7.5 MB, loaded on first use).

Supported options:

- `entrypoints`, `outdir`, `root`, `target`, `format`, `minify`, `splitting`, `sourcemap`, `naming`, `publicPath`
- `external`, `packages`, `define`, `drop`, `loader`
- `env`: `"inline"`, a `"PUBLIC_*"` prefix or `"disable"`; the values come from `process.env`, plus any `.env` file in the project
- `conditions`, `banner`, `footer`, `throw`
- `plugins` (see [Bundler](/compatibility/toolchain/#bundler))

Not supported: `compile`.

### `Bun.inspect`, `Bun.deepEquals`, `Bun.escapeHTML`
- `inspect` is Bun's format with its `depth`, `colors`, `sorted` and `compact` options, and `Bun.inspect.table`.
- Request, Response, Blob/File, FormData, URL, URLSearchParams, Headers, MessageEvent/ErrorEvent and React elements print as in Bun (Headers sorted).
- Keys print strings first, then symbols.

Differs from Bun: a promise shows its state if one of the playground's APIs returned it (`fetch`, `Bun.file` reads, `Bun.write`, `Bun.sleep`, `fs.promises`) and `<pending>` otherwise, e.g. `Promise.resolve(1)` or an async function's result: their state isn't readable from JS.

### `Bun.stdout`, `Bun.stderr`
- Work as `Bun.write` destinations and print to the console.
- `writer()` is a FileSink as in Bun: `write` buffers, and the bytes go out on `flush()`, `end()` or once the current task is done.
- No file descriptor.

### `Bun.$`
Bun's shell: its own parser (as wasm), then an interpreter with Bun's builtins over the project's files.

Builtins: `echo`, `cd`, `pwd`, `ls`, `cat`, `touch`, `mkdir`, `rm`, `mv`, `cp`, `which`, `export`, `exit`, `true`, `false`, `yes`, `seq`, `dirname`, `basename`.

Work as in Bun:

- Pipes, `&&`/`\|\|`/`;`, subshells, `if`, `[[ ]]`
- Redirects (to files and to buffers)
- `$VAR`, `$(…)`, `~`, `{a,b}` and `*`/`**` globs
- `.text()`, `.json()`, `.lines()`, `.quiet()`, `.nothrow()`, `.cwd()`, `.env()`, `ShellError`, `$.escape` and `$.braces`

Other commands run as child processes (see `Bun.spawn`), with their output in the pipeline; one that isn't there is `command not found`.

### `Bun.spawn`
Starts a child process.

Supported options:

- `stdin`, `stdout` and `stderr` as `"pipe"` (a FileSink for stdin, ReadableStreams for output), `"inherit"` or `"ignore"`
- stdin fed from bytes, a Blob or `Bun.file`, a Response or a ReadableStream
- `exited`, `exitCode`, `signalCode`, `killed`, `kill`, `ref`/`unref`, `onExit`, `cwd`, `env`, `timeout`, `signal`

A command that isn't there throws `ENOENT`.

What a child can run:

- `bun` or `node` with a file
- `bun run` with a `package.json` script or a file
- an installed package's bin (`vite`, `tsc`)
- `sh -c` lines and the shell's builtins, which Bun's shell runs
- `bun test` (also as a package.json `"test": "bun test"` with `bun run test`): the test files under its `cwd`, or the ones its arguments name, with the flags the console's `bun test` takes (see [`bun:test`](#buntest)). `--coverage` counts what it loads and prints the table to stderr. Its report goes to stderr without colors, the version line to stdout, and it exits with 1 when a test failed.

Processes:

- Each child runs in a worker of its own, on the project's files as they are when it starts; what it writes reaches the others.
- One that can't start (the tab out of memory for another process) exits with code 1 and says why on stderr.

Servers:

- A server a child starts answers the preview when the program serves none itself (a script that runs `bun server.ts`) or when it is picked in the status bar's port list, and a preview WebSocket to its port reaches it.
- A child's server on a port another process of the program already serves throws `EADDRINUSE`, as in Bun.

Not supported: `ipc` and `resourceUsage`.

### `Bun.spawnSync`
- Only on a cross-origin isolated page: runbun.dev, or an embed whose host page sends `COOP` and `COEP` (see [Browsers](/compatibility/browsers/)).
- Elsewhere it throws a `NotIsolatedError` (code `ERR_NOT_ISOLATED`): blocking the program until the child ends needs `SharedArrayBuffer` and `Atomics.wait`.
- Runs the same commands as `Bun.spawn` and returns `stdout` and `stderr` as Buffers of any size, `exitCode`, `signalCode`, `success` and `exitedDueToTimeout`.
- Options: `cwd`, `env`, stdin from bytes (a string throws, as in Bun), `stdout`/`stderr` as `"pipe"`, `"inherit"` or `"ignore"`, `timeout`, `killSignal` and `maxBuffer`.
- The files the child writes are there when it returns.
- No `resourceUsage`.

### `Bun.hash`
- Algorithms: `wyhash` (the default), `adler32`, `crc32`, `cityHash32`, `cityHash64`, `xxHash32`, `xxHash64`, `xxHash3`, `murmur32v2`, `murmur32v3`, `murmur64v2` and `rapidhash`.
- Matches Bun's output for every seed and input, with the same number or BigInt return types.
- Strings, buffers and views are accepted; a `Blob` is not (it cannot be read synchronously).

### `Bun.password`
- `hash`, `hashSync`, `verify`, `verifySync` with argon2id (the default), argon2i, argon2d and bcrypt, through the argon2 and bcrypt code Bun uses (as wasm).
- Hashes made here verify in Bun and the other way round.
- `hash` and `verify` run in a worker of their own, so the program keeps running while they work (about a quarter second for a hash with the defaults). The worker stops 10 seconds after its last job and frees argon2's memory.
- `hashSync` and `verifySync` run on the program's thread, as in Bun, and block it.

### `Bun.Glob`
- Bun's own matcher and walker (`bun_glob`, as wasm) over the project's files.
- `match`, `scan`, `scanSync` with `cwd`, `dot`, `absolute`, `onlyFiles`, `followSymlinks`, `throwErrorOnBrokenSymlink`.
- The default `cwd` is `process.cwd()` (`/`).

### `Bun.Transpiler`
Bun's own parser and printer, as wasm (~3 MB, loaded on first use).

- `transformSync`, `transform`, `scan`, `scanImports` give Bun's output for the `js`, `jsx`, `ts` and `tsx` loaders.
- `transformSync`/`transform`/`scan` also take the `json`, `jsonc`, `json5`, `toml`, `yaml`, `xml`, `text` and `md` loaders per call (`md` is Bun's Markdown renderer: the HTML as the default export).
- `define` works as in Bun, with its defaults: `process.env.NODE_ENV` and `process.env.BUN_ENV` from `process.env.NODE_ENV`, else `"development"`; `process.browser` from `target`.
- `exports` (`eliminate`, `replace`), `minify`, `minifyWhitespace`, `inline`, `trimUnusedImports`, `treeShaking` and `deadCodeElimination` work as in Bun.
- `tsconfig` reads `experimentalDecorators`, `emitDecoratorMetadata`, `jsx`, `jsxFactory` and `jsxFragmentFactory` (`jsxImportSource` too, though the runtime transpiler never imports the JSX runtime).
- `target: "bun"` prints as Bun does for its own runtime: syntax minified, strings ASCII-escaped, `using` kept, `var {require}=import.meta;` in an ES module that uses `require`.

Not supported: macros never run (`macro` is ignored with a warning).

### `Bun.resolveSync`, `Bun.resolve`
- Bun's resolver over the project's files; returns the file's path (`/src/x.ts`), `node:fs` for built-ins.
- `from` is a directory, as in Bun.
- Throws a `ResolveMessage` (`Cannot find module …`, `code: "ERR_MODULE_NOT_FOUND"`) when nothing matches.

### `Bun.stdin`
- What you type in the console while the program reads it: `stream()`, `text()`, `json()`, `bytes()` and `arrayBuffer()` settle at the end of input (<kbd>Ctrl</kbd>+<kbd>D</kbd> in the console; see [the console](/playground/console/#console-input)).
- The same source as `process.stdin` and `for await (const line of console)`.
- No `slice`, `writer()` or `size` (it is `Infinity`).

### `Bun.S3Client`, `Bun.s3`
S3, R2, MinIO and anything S3-compatible over `fetch`, signed with SigV4 as Bun signs.

Supported:

- `file(key)` (an `S3File`: `text`, `json`, `bytes`, `arrayBuffer`, `stream`, `formData`, `slice`, `exists`, `stat`, `delete`, `write`, `writer`, `presign`, `bucket`)
- `write`, `exists`, `size`, `stat`, `list`, `delete`/`unlink`
- `presign` (synchronous, `expiresIn`, `method`, `acl`, `storageClass`, `contentDisposition`, `type`) and the static versions on the environment's credentials
- Options as Bun reads them: `accessKeyId`, `secretAccessKey`, `sessionToken`, `region`, `endpoint`, `bucket`, `virtualHostedStyle`, `acl`, `storageClass`, `requestPayer`, `partSize`, `queueSize`, `retry`
- `Bun.s3`, `s3://` URLs in `Bun.file`, `Bun.write` and `fetch(…, { s3 })` read `S3_*` and `AWS_*` variables (set them in `runbun.json`'s `env`)
- Presigned URLs and signed requests are byte for byte Bun's
- A stream or `writer()` past `partSize` is a multipart upload

**The browser calls the endpoint directly, so the bucket's CORS rules must allow this page's origin, the methods used (`GET`, `PUT`, `POST`, `DELETE`, `HEAD`) and the request headers `Authorization`, `Content-Type`, `Range` and `x-amz-*` (`Content-Disposition` and `Content-Encoding` too, if used), and expose `ETag`**; a failure there reads as `NetworkError`.

Differs from Bun:

- `new Response(s3file)` is empty, as in Bun.
- No `image()`.
- A negative `slice` start works only without an end.

### `Bun.sql`, `SQL`
Postgres runs in the tab on [PGlite](https://pglite.dev) (Postgres compiled to WebAssembly), so a `postgres://` URL, with any host, names a database in the browser.

Storage:

- One database per database name, kept in the project's browser storage (`.runbun/pglite/<name>.tar.zst`) and written back when the program ends, on `process.exit` too.
- It stays out of shares, zip downloads and a linked folder on disk.
- `pglite://<name>` names the same database (playground only), and `pglite://:memory:` one that isn't kept.
- `Bun.sql` reads `DATABASE_URL`, `POSTGRES_URL`, `PGURL` and the `PG*` variables as Bun does (set them in `runbun.json`'s `env`).
- `new SQL("sqlite://...")` runs on `bun:sqlite`.

The API follows Bun's:

- tagged templates with parameters, `count`/`command`, `.values()`, `.raw()`, `.simple()`
- `sql(object)` and `sql(array)` for inserts, updates and `IN`
- `sql.array`, `sql.json`, `sql.unsafe`, `sql.file`
- `sql.begin` (rolled back when the callback throws) with `savepoint`, `sql.reserve()`, `sql.close()`
- the `bigint` option and `SQL.PostgresError` with `code`, `errno`, `severity`, `detail` and the rest

Download: the first query downloads PGlite, about 5.3 MB compressed (Postgres 3.2 MB, its data files 1.9 MB), which the browser then caches; a program that doesn't use SQL never fetches it.

Differences:

- There is one connection, so a query made while a transaction is open runs inside it and `sql.begin` calls queue.
- `.raw()` gives each value's text as a Buffer.
- An `int4[]` is an array, where Bun sometimes gives an `Int32Array`.
- `mysql://` and `mariadb://` fail on the first query (no network).
- `beginDistributed`, `.cursor()` and `LISTEN` aren't supported.
- A worker thread has its own database instance, so threads writing the same database overwrite each other.

### `Bun.zstdCompress`, `Bun.zstdCompressSync`, `Bun.zstdDecompress`, `Bun.zstdDecompressSync`
- A pure-Rust zstd (WebAssembly, loaded on the first call): `level` 1 to 22, several frames and skippable frames, Bun's `ERR_ZSTD` errors for bad input.
- The compressed bytes can differ from Bun's (another encoder), but each side decompresses the other's.
- `CompressionStream` and `DecompressionStream` take `"zstd"` and `"brotli"` too.

### `Bun.YAML`, `Bun.TOML`
- `parse` is Bun's own YAML and TOML parser (`bun_parsers`, as wasm), with Bun's values and errors.
- YAML aliases stay shared, and several documents give an array.
- TOML dates and times are `Temporal` values.
- `stringify` gives Bun's output.

### `Bun.JSONC`, `Bun.JSON5`
- `JSONC.parse` and `JSON5.parse` are Bun's own parsers (`bun_parsers`, as wasm), with Bun's values and errors (`JSONC Parse error: …`).
- `JSON5.stringify` gives Bun's output (no replacer, no `toJSON`, as in Bun).
- There is no `JSONC.stringify`, as in Bun.

### `Bun.JSONL`
`parse` and `parseChunk` (strings, typed arrays, `start`/`end` offsets) as Bun's: one value per line.

- `parse` keeps the values before a bad line and throws only if the first is bad.
- `parseChunk` reports `read` (bytes for a buffer), `done` and `error`, telling a value cut off at the end of the chunk from a wrong one as JavaScriptCore does.

### `Bun.XML`
- `parse` is Bun's own XML parser (`bun_parsers`, in the transpiler's wasm, loaded on first use): the compact object or, with `{ compact: false }`, the node tree, with Bun's errors.
- A buffer or Blob gets BOM, UTF-16 and encoding-declaration detection; a string is parsed as text.
- `stringify` gives Bun's output and errors for both shapes (a Proxy is an object, as in Bun).
- Very deep nesting runs out of stack at a different depth than in Bun (both throw `RangeError: Maximum call stack size exceeded.`).

### `Bun.markdown`
Bun's Markdown parser and renderers (`bun_md`, in the transpiler's wasm, loaded on first use).

- `html` and `ansi` (themes, wrapping at `columns`; `light` defaults from `COLORFGBG`, which the playground doesn't set) give Bun's output, with Bun's options.
- `render` calls the callbacks with Bun's children and metadata, in Bun's order.
- `react` returns React elements (`react.transitional.element`, or `react.element` with `reactVersion` 18 or lower) with the components given.

### `Bun.FileSystemRouter`
- A port of Bun's router over the project's files (`style: "nextjs"`, `dir`, `origin`, `assetPrefix`, `fileExtensions`).
- `routes`, `match()` of a path, URL, `Request` or `Response` (exact, dynamic, catch-all and optional catch-all routes in Bun's order, `params`, `query`, `src`, `scriptSrc`) and `reload()`.

### `Bun.plugin`
Runtime plugins for the program's imports and requires.

Supported:

- `onResolve` and `onLoad` with `filter` and `namespace` (async hooks and `setup` too)
- `build.module`
- the `js`, `jsx`, `ts`, `tsx`, `object`, `json`, `toml` and `yaml` loaders
- `Bun.plugin.clearAll()`, with Bun's errors (an async hook under `require()` throws as in Bun)

As in Bun, a plugin applies to what is imported after it is registered, and a preloaded one to the program's entry file too. So either:

- register it in a file `bunfig.toml`'s `preload` names, or `bun --preload <file>` (`-r`) on the command line (in the working directory, as in Bun: `preload` runs before a program's entry, then the command line's; with `bun run`, `bunfig.toml`'s replace those, as in Bun 1.4); `[test] preload` runs before `bun test`'s files; Web Workers and `worker_threads` get neither, or
- import the plugin's users with `import()` or from a module loaded after it.

Differs from Bun: `json` and `toml` contents are parsed as data (Bun 1.4.4 runs them as JavaScript).

Not supported: no `xml` or `md` loader.

### `HTMLRewriter`
Bun's own `lol-html` (`HTMLRewriter` is a global, as in Bun), compiled to wasm and loaded on first use.

- `on` (selectors, `element`, `comments` and `text` handlers) and `onDocument` (`doctype`, `comments`, `text`, `end`), and the wrappers with all their methods and Bun's errors (`HTMLRewriterError`).
- `transform` takes a `Response` (a `Response` back, rewritten as its body is read; async handlers are awaited, the rewrite waits on them), a string (a string back) or an `ArrayBuffer`, typed array or `DataView` (an `ArrayBuffer` back), and not a `Blob`, as in Bun.

Differs from Bun: a handler on a string or buffer input cannot return a promise. Bun still allows one that settles within a microtask; here it fails the rewrite with a `TypeError` (pass a `Response` instead).

## `Bun.serve`

Servers answer requests from the [preview](/playground/preview/), not from the network.

| Feature | Status | Notes |
|---|---|---|
| `fetch(req, server)` | ✅ Works | |
| `routes` | ✅ Works | Exact paths, `:param`, trailing `*`, per-method handlers and static `Response`s. No globs mid-path. [Details](#routes) |
| HTML imports in `routes` | ✅ Works | `import page from "./index.html"` is bundled with Bun's bundler and rebuilt on file change. No HMR. [Details](#html-imports-in-routes) |
| `bun ./index.html` | 🟡 Partial | Bun's HTML dev server for one page, served at every path. No HMR, one file only. [Details](#bun-indexhtml) |
| WebSockets | ✅ Works | `server.upgrade`, handlers, `publish` and `subscribe` work; the program can connect to its own servers. [Details](#websockets) |
| `server.publish`, `subscriberCount`, `pendingWebSockets` | ✅ Works | |
| `server.reload`, `server.stop` | ✅ Works | |
| `server.url`, `port`, `hostname` | ✅ Works | `port: 0` picks a port from 40001. |
| A port in use | ✅ Works | Throws Bun's `EADDRINUSE` error for a port the program or its children already serve. [Details](#a-port-in-use) |
| `export default { fetch }` | ✅ Works | Served automatically, as in Bun (Hono, Elysia). |
| Streaming responses, Server-Sent Events | ✅ Works | The head goes out with the stream's first chunk, as from Bun. [Details](#streaming-responses-server-sent-events) |
| Response headers | ✅ Works | Adds what Bun adds: `content-length` for known lengths and default content types. No `etag` on static routes. [Details](#response-headers) |
| `req.cookies` | ✅ Works | A `Bun.CookieMap` in `routes` handlers; changes go out as Set-Cookie headers. [Details](#reqcookies) |
| Cookies | ✅ Works | Kept in the browser's own cookie store under the preview's path, visible to `document.cookie` and DevTools. [Details](#cookies) |
| TLS | ❌ Missing | |
| `server.ref`/`unref` | ✅ Works | A server keeps the program running until it stops, unless `unref`'d. |
| `error` | ✅ Works | Called with the error (`this` the server) when a `fetch` or route handler throws or rejects; its Response is sent. `server.reload({ error })` swaps it. |
| `development` | ✅ Works | On unless `development: false` or `NODE_ENV` is `production`; unhandled errors answer 500 with the stack. [Details](#development) |
| `maxRequestBodySize` | ✅ Works | 128 MiB by default; a larger body gets a 413 and the handler never runs. [Details](#maxrequestbodysize) |
| `server.requestIP` | ✅ Works | Reports what Bun does for a client on the same machine; the port is made up. [Details](#serverrequestip) |
| `unix` | 🟡 Partial | The server has no port and no preview (`server.url` is `unix://<path>`); the program reaches it with `fetch(url, { unix: path })`. No socket file is made. |
| `idleTimeout`, `server.timeout` | ⚪ Stub | `idleTimeout` is validated as in Bun, but nothing times out. [Details](#idletimeout-servertimeout) |
| `reusePort` | ⚪ Stub | Accepted; changes nothing. |

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

## `Bun.serve` details

The rest of the table rows above, in the same order.

### `routes`
- Exact paths, `:param` (in `req.params`), trailing `*`, per-method handlers, static `Response`s.
- A HEAD to a route with only `GET` gets its response without the body.
- Globs in the middle of a path (`/a/*/b`) don't match.

### HTML imports in `routes`
- `import page from "./index.html"` is bundled with Bun's bundler.
- Assets are served under `/_bun/`, with inline source maps, so DevTools shows the original source.
- Rebuilt after any file change. No HMR.
- `bunfig.toml`'s `[serve.static] plugins` apply to the bundle (their `onLoad`/`onResolve` hooks, e.g. Solid's Babel transform for `.jsx`).

### `bun ./index.html`
- Bun's HTML dev server for one page: it is bundled like an HTML import and served at every path (default port 3000, `--port <n>`), with the startup line Bun prints.
- Run starts it for a project with no program and a root `index.html`, or whose `dev`/`start` script is `bun ./index.html`.
- No HMR, and one file only: several files or a glob are not served.

### WebSockets
- `server.upgrade(req, { data, headers })`. Of `headers`, only Set-Cookie has an effect: the page's socket never sees the others.
- `open`/`message`/`close`/`drain`, `send`, `publish`, `subscribe`, `cork`, `close`. `ping`/`pong` do nothing.
- The preview page connects, and so does the program itself: `new WebSocket("ws://localhost:<port>")` to one of its own servers connects in-process, as Bun's client does (binary messages as Buffers by default, `binaryType` `"arraybuffer"` or `"blob"`).
- A child process's server isn't reachable that way.

### A port in use
- A server on a port the program or one of its child processes already serves throws Bun's error (`code` `EADDRINUSE`, `syscall` `listen`, "Failed to start server. Is port 3000 in use?").
- Two processes that start a server on the same port at the same moment can both get it; the preview then goes to the one started first.

### Streaming responses, Server-Sent Events
- The head goes out with the stream's first chunk (or its end), as from Bun: until then the client waits.
- A stream that fails before then drops the connection, so a `fetch` from the program rejects (`ECONNRESET`) and the preview page gets a network error.
- A later failure ends the body with that error.
- An HTML page streams into the preview as well: a server-rendered page sent in parts (streamed SSR) shows in parts.

### Response headers
What Bun adds:

- `content-length` for a body of known length (a string, bytes, a Blob or `Bun.file`, not a stream)
- `text/plain;charset=utf-8` for a string
- `application/octet-stream` for bytes and a stream of another body
- for HEAD, only the content type a handler set itself

No `etag` on static routes.

### `req.cookies`
- A `Bun.CookieMap` over the request's Cookie header, in `routes` handlers (a `fetch` handler's request has none, as in Bun).
- What a handler sets or deletes in it by the time it returns goes out as Set-Cookie headers after the response's own.
- On a WebSocket upgrade, the Set-Cookie headers of `upgrade`'s `headers` option and what the handler set or deleted before calling `server.upgrade(req)` go to the cookie jar, as Bun sends them on the 101.
- A handler that returns a Response instead of upgrading sends that Response's Set-Cookie headers and its `req.cookies` changes, which go to the jar too.

### Cookies
- Kept in the browser's own cookie store under the preview's path (`/__preview/@<tab>/`), so a preview page's scripts read them with `document.cookie`, cookies those scripts set reach the server, and DevTools lists them under Application → Cookies.
- HttpOnly cookies are kept in the page's memory instead, out of the scripts' reach, so DevTools doesn't show them.
- Cookies with a narrower `Path` (`/admin`, as a script on `/admin/page` sets one by default) reach the server for requests under it, with the scripts' changes.
- The preview's path changes with every tab and reload, so the next preview to serve a request deletes the cookies a closed tab's preview had.
- In an embed on another site the browser refuses the preview's cookies: the server's are kept in the page's memory, and those scripts set don't reach the server.
- `cookies` in the console lists them all, `cookies clear` deletes them.

### `development`
- On unless `development: false` or `NODE_ENV` is `production`.
- When nothing handles an error, a development server prints it, then `GET - /path failed`, and answers 500 with an HTML page showing the stack (Bun's has its error overlay); otherwise it prints the error and answers 500 "Something went wrong!".
- A handler that returns something other than a Response gets Bun's "Expected a Response object" error and its default answer (200 "Welcome to Bun!", or 204).

### `maxRequestBodySize`
- 128 MiB by default; a larger body gets a 413 with `Connection: close` and the handler never runs.
- Counted for preview requests and the program's own `fetch` (with the default `redirect: "follow"`).

### `server.requestIP`
- What Bun reports for a client on the same machine: `{ address: "::1", family: "IPv6", port }` for the preview and `localhost`, `::ffff:127.0.0.1` for `127.0.0.1`.
- `null` over a unix socket or for a request the server didn't get.
- The port is made up.

### `idleTimeout`, `server.timeout`
- `idleTimeout` is checked as in Bun (an integer up to 255), but nothing times out.
- Bun closes a request its handler leaves idle for 10 seconds; the playground waits.

## `bun:*` modules

| Module | Status | Notes |
|---|---|---|
| `bun:sqlite` | 🟡 Partial | Built on SQLite's official WebAssembly build; most of Bun's API works. `loadExtension` throws. [Details](#bunsqlite) |
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

### `bun:sqlite`
Built on SQLite's official WebAssembly build ([`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm)), loaded the first time a program imports `bun:sqlite` or `node:sqlite`.

Supported:

- `Database`: `query` with Bun's cache of the 20 last used statements, `prepare` with parameters and prepare flags, `run`, `transaction` with `.immediate` and nested savepoints, `serialize`, `Database.deserialize`, `Database.open`, `inTransaction`, `handle`, `close` and `close(true)`, `Symbol.dispose`
- Its options `strict`, `readonly`, `create` and `safeIntegers`
- Statements with `all`, `get`, `values`, `raw`, `run`, a lazy `iterate` (it steps as the loop asks for rows), `as(Class)`, `safeIntegers()`, `columnNames`, `columnTypes`, `declaredTypes`, `paramsCount`, `reader`, `readonly`, `native`, `finalize`, `toString()` and `toJSON()`
- User-defined functions: `db.function` and `db.aggregate` (window functions with `inverse` too)
- Update hooks: `onInsert`, `onUpdate` and `onDelete`
- `fileControl` reaches the database file as on Linux (`SQLITE_FCNTL_PERSIST_WAL`, `SQLITE_FCNTL_DATA_VERSION`, ...), and `constants` has every `SQLITE_OPEN_*`, `SQLITE_PREPARE_*` and `SQLITE_FCNTL_*` Bun has
- A BigInt binds as an exact 64-bit INTEGER

As in Bun, `close()` finalizes the `query()` statements while `prepare()` ones keep working until finalized. `Database.setCustomSQLite` returns `false`, as on Linux, where Bun's SQLite is built in.

Errors are `SQLiteError` with SQLite's extended result code as `code` and `errno` (`SQLITE_CONSTRAINT_PRIMARYKEY`, `SQLITE_CONSTRAINT_TRIGGER`, ...) and its `byteOffset` into the SQL.

File databases:

- A file database is a file of the project that SQLite reads and writes in place, with its `-journal`, or `-wal` and `-shm` in WAL mode (`pragma journal_mode = wal` works), next to it as on Linux.
- `node:fs` and `Bun.file` see it as of SQLite's last commit, and it is saved with the project.
- Several connections to one file in a program share its locks, so they see each other's commits and get `SQLITE_BUSY` as natively; two processes (a child process and its parent) writing one database aren't coordinated.
- A database still open when the program ends is closed then, as Bun does: an open transaction rolls back.

Differs from Bun:

- An async function given to `transaction` commits once it returns its promise: Bun rolls back one that rejected before its first `await`, which JavaScript can't see.
- A new database made with `ATTACH` has 8 KiB pages (the WebAssembly build's default) where Bun's has 4 KiB.
- `loadExtension` throws, as a Bun build without extension loading does: a browser cannot load native code.

### `bun:test`

- ✅ `test`/`it`/`describe` with `.skip`, `.only`, `.todo`, `.each`, `.if`, `.skipIf`, `.todoIf`, `.failing` (passes when the test throws, fails with Bun's message when it doesn't), and `.concurrent`/`.serial` (accepted; tests run one after another)
- ✅ `beforeAll`, `beforeEach`, `afterEach`, `afterAll`, `setDefaultTimeout`. As in Bun, a `beforeAll` or `afterAll` that throws fails as a test of its own, `<describe> > (unnamed)`; after a failed `beforeAll` the rest of its `describe` doesn't run, its `afterAll` hooks do. A `beforeEach` that throws fails the test, and its `afterEach` hooks still run
- ✅ `bunfig.toml`'s `[test] preload`: run once before the test files (a runtime plugin it registers serves their imports); its hooks are global, as in Bun (`beforeEach`/`afterEach` around every test, `beforeAll`/`afterAll` once). The top-level `preload` is for runs, not `bun test`, as in Bun 1.4
- ✅ `mock()`, `spyOn()`, `jest.fn`, `jest.spyOn`
- ✅ `expect` with `.not`, `.resolves`, `.rejects`, asymmetric matchers (`anything`, `any`, `objectContaining`, `arrayContaining`, `stringContaining`, `stringMatching`) and the common matchers (`toBe`, `toEqual`, `toStrictEqual`, `toThrow`, `toMatchObject`, `toHaveProperty`, `toHaveBeenCalledWith`, …), plus Bun's extras (`toBeEmpty`, `toBeOneOf`, `toSatisfy`, `toStartWith`, `toEndWith`, `toInclude`, `toBeArray`, `toBeString`, `toBeNumber`, `toBeFunction`, `toHaveReturned*`, …)
- ✅ `expect.extend` (custom matchers with `this.isNot`, `this.promise`, `this.equals` and `this.utils`' `stringify`, `printReceived`, `printExpected`, `matcherHint`; async matchers and the `expect.<name>()` asymmetric form work too), `expect.assertions(n)` and `expect.hasAssertions()`
- ✅ Fake timers: `jest.useFakeTimers()` (also `{ now }`) and `useRealTimers`, `advanceTimersByTime`, `advanceTimersToNextTimer`, `runOnlyPendingTimers`, `runAllTimers`, `clearAllTimers`, `getTimerCount`, `isFakeTimers` and `now`, on `jest` and `vi`.
  - `setTimeout`, `setInterval`, `Date` and `Bun.sleep` run on the fake clock; `setImmediate`, `process.nextTick` and `performance.now` stay real.
  - As in Bun, the timers stay faked into the next test until `useRealTimers()`.
  - `runAllTimers` stops with an error after 100000 timers (Bun loops on an interval nothing clears).
- ✅ `setSystemTime(date | ms)` from `bun:test` or `jest`: `Date` is frozen at that time (or moves from it with fake timers); no argument restores the real time
- ✅ Snapshots: `toMatchSnapshot` (with a hint and property matchers) writes `__snapshots__/<file>.snap` in the project in Bun's format, byte for byte, and `toMatchInlineSnapshot` compares and fills in the call's snapshot in the test file.
  - New snapshots are written unless the `CI` environment variable is set (in `runbun.json`'s `env`), where they fail as in Bun; `bun test -u` (`--update-snapshots`) rewrites the ones that differ.
  - Serializing follows Bun's for plain values, arrays, Map, Set, Date, RegExp, errors, class instances and typed arrays; odd built-ins (`Math`, `Promise`, getters) can print differently.
  - The `snapshots:` totals line is approximate.
- 🟡 `mock.module(specifier, factory)` and `jest.mock`: imports and requires that come after the call get what the factory returns (project files, packages, and `import`s of built-ins like `node:os`, from `import()` or from modules loaded afterwards). The factory runs at the call, not at the first import as in Bun. A module that is imported already can't be mocked (Bun swaps its live bindings; here the call throws and says so), which includes anything a literal `require("./x")` or a static `import` at the top of the test file pulled in: call `mock.module` first and use `await import()`.
- 🟡 Coverage: `bun test --coverage` (with `--coverage-reporter text|lcov` and `--coverage-dir`) and `bunfig.toml`'s `[test]` `coverage`, `coverageReporter`, `coverageDir`, `coverageThreshold`, `coverageSkipTestFiles` and `coveragePathIgnorePatterns`.
  - It prints Bun's table (`% Funcs`, `% Lines`, uncovered lines) and writes `coverage/lcov.info` in the project.
  - A file below `coverageThreshold` fails the run: Bun prints nothing more and exits with 1, here the status says "Coverage below threshold".
  - The browser has no coverage API, so for such a run the project's files are served with counters where Bun's JavaScriptCore counts (its basic blocks), and lines map back to the file through the transpiler's source map as in Bun: on the files we compared, the table and `lcov.info` are those of Bun 1.4.4, byte for byte.
  - Known differences: a file the coverage parser can't read is left out of the report; a newer Bun can count differently.
  - With Local Bun on, native Bun counts (`@runbun/connect` 0.4.0 or newer) and its `lcov.info` comes back into the project.
- ✅ A failed `toEqual`, `toStrictEqual`, snapshot or `toBe` of two strings shows Bun's diff: the whole value, its object keys sorted, with `-` lines for what was expected and `+` lines for what was received (over 2 KiB, 5 lines of context around each change under `@@` headers; a line over 2 KiB loses its middle).
  - In the console it is coloured as Bun colours it on a terminal, with the characters that changed within a line highlighted.
  - A spawned `bun test` writes it plain, as Bun does to a pipe.
- An uncaught error or unhandled rejection fails the test running at the time (whichever test's code threw it), as in Bun, and the run goes on.
- Unknown matchers throw "is not supported here".
- `bun test` (in the console or spawned) takes file filters, `-u` / `--update-snapshots`, the coverage flags above, `-t` / `--test-name-pattern` (tests whose name, with their `describe` blocks', matches; the rest count as filtered out), `--timeout`, `--bail[=<n>]`, `--rerun-each`, `--todo` (a `test.todo` with a body runs, and fails if it passes) and `--only`, with Bun's messages for bad values; no other flags.
  - As in Bun, in a file with `.only` tests the others neither run nor count, and a test that runs past its timeout fails with "this test timed out".
  - With Local Bun on, they go to native Bun through `@runbun/connect` (a runner older than this refuses them and says to update).

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
| `import.meta.resolve` | ✅ Works | A package resolves to its `file:///<path>` URL; browser code gets the browser's own. [Details](#importmetaresolve) |
| `import(expr)` with a computed path | ✅ Works | |
| `fetch("file:///…")` | ✅ Works | Reads project files; `http://localhost:<port>` reaches the program's own servers and those of its child processes and threads. Other URLs go to the network. [Details](#fetchfile) |
| `Headers#toJSON` | ✅ Works | As in Bun: a plain object of lower-cased names, values joined with `, `, Set-Cookie as an array. |
| `new Request()` headers | ✅ Works | `request.headers` keeps Cookie, Host, Origin, Referer and Content-Length, as in Bun. `fetch()` sends only what browsers allow. [Details](#new-request-headers) |
| `Response.redirect` | ✅ Works | As in Bun, the Location is the URL as given (a relative one stays relative). |
| `formData()` | ✅ Works | On a multipart body, as in Bun, a file part's type comes from its file name's extension (`a.txt` is `text/plain;charset=utf-8`), not from the part's Content-Type. |
| `XMLHttpRequest` | ✅ Works | Not defined, as in Bun (the browser's worker has it, the playground removes it so libraries such as axios pick their Node code, `node:http`). Use `fetch`. |
| `console` as an `AsyncIterable` | ✅ Works | Yields what you type, a line at a time, and ends at <kbd>Ctrl</kbd>+<kbd>D</kbd>. [Details](#console-as-an-asynciterable) |
| `prompt`, `confirm`, `alert` | 🟡 Partial | Print the question and take the next line you type. They need a cross-origin isolated page. [Details](#prompt-confirm-alert) |
| `process`, `Buffer`, `global`, timers | ✅ Works | See [Node built-ins](/compatibility/node/). |
| `Worker` | 🟡 Partial | Bun's Web Worker runs a project file in a worker of its own. `blob:`, `data:` and `http(s):` URLs throw. [Details](#worker) |

### `import.meta.resolve`
- As in Bun: a package resolves to its file's `file:///<path>` URL (or throws a `ResolveMessage`), a built-in to `node:x`, and a path is joined to the module's URL as written.
- Server code only; browser code (HTML imports) gets the browser's own, which returns the served URL.

### `fetch("file:///…")`
- Reads project files. Relative URLs throw.
- `http://localhost:<port>` (and `127.0.0.1`) reaches a server this program started, `Bun.serve` or `http.createServer`, or one a child process or `worker_threads` thread of it started, and follows its redirects as Bun does (`redirect: "manual"` and `"error"` too; `response.url` and `redirected` are set).
- A child process's server isn't reachable.
- Other URLs go to the network, subject to CORS.

### `new Request()` headers
- As in Bun, `request.headers` keeps Cookie, Host, Origin, Referer and Content-Length (a browser drops them), through `clone()` and `new Request(request)` too, so `app.handle(new Request(url, { headers: { cookie } }))` sees its cookies.
- `fetch()` still sends only what the browser allows.

### `console` as an `AsyncIterable`
- `for await (const line of console)` yields what you type in the console, a line at a time without its newline, and ends at <kbd>Ctrl</kbd>+<kbd>D</kbd>.
- As in Bun, input that ends with a newline ends with an empty line.

### `prompt`, `confirm`, `alert`
- Print the question (`Name? `, `Sure? [y/N] `, `Hi [Enter] `) and take the next line you type, as Bun does on a terminal.
- They block the program until you answer, which needs a cross-origin isolated page (runbun.dev, or an embed whose host page sends `COOP` and `COEP`, see [Browsers](/compatibility/browsers/)).
- Elsewhere they throw a `NotIsolatedError` (code `ERR_NOT_ISOLATED`), like `Bun.spawnSync`. Use `readline` or `for await (const line of console)` there.

### `Worker`
Bun's Web Worker: `new Worker(new URL("./w.ts", import.meta.url))` or `new Worker("./w.ts")` (from the working directory, as in Bun) runs a project file in a worker of its own, on the project's files as they are when it starts, with Bun's `argv`, `env` (a copy of `process.env` by default), `workerData` and `ref` options.

Messaging:

- `postMessage` both ways with transfers, `onmessage` and `addEventListener` on both sides.
- The `open`, `message`, `error` and `close` events (`close` carries the exit code), `terminate()` and `ref`/`unref`.
- Inside, `self.postMessage`, `self.onmessage` and `self.addEventListener("message")` talk to the `Worker`, and so does `parentPort`.
- A worker listening for messages keeps running until it ends itself or is terminated.

Ending:

- `process.exit()` in a worker ends only that worker.
- An uncaught error is the `Worker`'s `error` event (an `ErrorEvent` with the error's text in `message` and `error` null, as in Bun) and ends it with code 1.
- As in Bun 1.4, a worker has no `self.close`.
- After `terminate()`, `close` has code 0 (Bun gives 0, now and then 1).

Not supported: only project files: `blob:`, `data:` and `http(s):` URLs throw; `preload` and `smol` are ignored.
