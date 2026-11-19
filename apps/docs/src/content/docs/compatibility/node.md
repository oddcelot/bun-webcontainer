---
title: Node built-ins
description: "The status of every node:* built-in in the browser playground, from node:fs and node:http to node:crypto and node:stream, each marked Works, Partial, Stub or Missing."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Node.js built-ins in the browser: node:fs, node:http and more | Run Bun"
# The per-item sections under the tables would swamp the outline: it lists the parts of the page.
tableOfContents:
  maxHeadingLevel: 2
sidebar:
  order: 3
---

Built-ins import with or without the `node:` prefix. Labels are explained on the [overview](/compatibility/).

| Module | Status | Notes |
|---|---|---|
| `assert`, `assert/strict` | 🟡 Partial | Common assertions (`strictEqual`, `deepStrictEqual`, `rejects`, …). |
| `async_hooks` | 🟡 Partial | `AsyncLocalStorage` and `AsyncResource` keep their context across `await`, timers and promises; `createHook` does nothing. [Details](#async_hooks) |
| `buffer` | ✅ Works | Includes `Blob`, `File`, `atob`, `btoa`, `isUtf8`, `isAscii`. |
| `child_process` | 🟡 Partial | `spawn`, `exec` and `execFile` run `bun`, `node`, shell lines and package bins; `fork` throws. [Details](#child_process) |
| `cluster` | ⚪ Stub | An EventEmitter whose `isPrimary` is `true`, with `schedulingPolicy` and the `SCHED_*` constants; `fork` throws. |
| `console` | 🟡 Partial | Output reaches the console pane in Bun's format, with Bun-style errors and stacks; no `Console` class. [Details](#console) |
| `constants` | ✅ Works | `os.constants` (`errno`, `signals`, `priority`, `dlopen`), `fs.constants` and `crypto.constants` in one object, as in Node and Bun, with Linux's values. |
| `crypto` | 🟡 Partial | Hashes, HMAC, ciphers, keys, signatures and `webcrypto` run in WebAssembly; some ciphers, curves and key types are missing. [Details](#crypto) |
| `dgram` | ⚪ Stub | `createSocket` returns a socket that closes, but `bind`, `send` and `connect` throw: a browser has no UDP. |
| `diagnostics_channel` | ✅ Works | Channels, `bindStore`/`runStores` and `tracingChannel` work; the `http` client publishes what Bun's does. [Details](#diagnostics_channel) |
| `dns`, `dns/promises` | 🟡 Partial | `lookup` resolves only `localhost`. |
| `domain` | ✅ Works | As Bun has it; a synchronous error becomes the domain's `error` event. [Details](#domain) |
| `events` | ✅ Works | `EventEmitter`, `once`, `on`, with `AbortSignal`. |
| `fs`, `fs/promises` | 🟡 Partial | Sync, callback and promise APIs over the project's files; no symlinks, and `chmod`/`chown` do nothing. [Details](#fs-fspromises) |
| `http` | 🟡 Partial | `createServer().listen(port)` serves the preview, as `Bun.serve` does; `http.request` follows the browser's CORS rules. [Details](#http) |
| `https` | 🟡 Partial | Like `http`, including `https.request`/`https.get` (the browser does the TLS); a server has no TLS. |
| `http2` | ⚪ Stub | |
| `inspector` | ⚪ Stub | `Session` answers `Runtime.enable` and `Profiler.enable` as Bun does; no profiler or debugger. [Details](#inspector) |
| `module` | 🟡 Partial | `builtinModules`, `isBuiltin` and `createRequire` work; `require()` of an ES module has limits. [Details](#module) |
| `net` | ⚪ Stub | `isIP*` works; no sockets. |
| `os` | 🟡 Partial | Fixed values: Linux, x64, `/home/user`, `/tmp`, and Linux's `constants`. `cpus()` and `networkInterfaces()` are empty. |
| `path`, `path/posix` | ✅ Works | POSIX only. `path.win32` behaves like POSIX; `path/win32` is missing. |
| `perf_hooks` | 🟡 Partial | `performance`, `PerformanceObserver`. `monitorEventLoopDelay` reports zeros. |
| `process` | 🟡 Partial | Reports Linux x64 and Node v24.3.0; the console is `stdin`, `stdout` and `stderr`, and exit works as in Bun. [Details](#process) |
| `punycode` | ✅ Works | |
| `querystring` | ✅ Works | |
| `readline`, `readline/promises` | 🟡 Partial | `createInterface`, `question` and `for await` work over `process.stdin`, with a terminal mode; no `completer`. [Details](#readline-readlinepromises) |
| `repl` | ⚪ Stub | Imports; `start` throws. |
| `sqlite` | 🟡 Partial | `node:sqlite`'s `DatabaseSync` and `StatementSync` run on the engine of `bun:sqlite`; no extensions. [Details](#sqlite) |
| `stream`, `stream/promises` | ✅ Works | Based on `readable-stream`. `Readable.toWeb`/`fromWeb` are basic. |
| `stream/web` | ✅ Works | The browser's web stream classes. |
| `string_decoder` | ✅ Works | |
| `sys` | 🟡 Partial | Same as `util`. |
| `test` | 🟡 Partial | `node:test` tests run under `bun test` through `bun:test`; `run({ files })` works; no `mock.module()`. [Details](#test) |
| `timers`, `timers/promises` | ✅ Works | `ref`, `unref` (an unref'd timer doesn't keep the program running), `hasRef`, `refresh`, promise timers with `AbortSignal`. |
| `tls` | ⚪ Stub | |
| `trace_events` | 🟡 Partial | `createTracing` and `getEnabledCategories` turn categories on and off as in Bun; no events are recorded. |
| `tty` | 🟡 Partial | `isatty`, `ReadStream` and `WriteStream` work for the main program while the console is its terminal. [Details](#tty) |
| `url` | ✅ Works | `URL`, `URLSearchParams`, `fileURLToPath`, `pathToFileURL`, `parse`. |
| `util`, `util/types` | 🟡 Partial | `format`, `inspect`, `promisify`, `parseArgs` and more work; no `MIMEType`, and `debuglog` does nothing. [Details](#util-utiltypes) |
| `v8` | 🟡 Partial | `serialize` and `deserialize` use Bun's byte format; heap statistics have Bun's shape; `Serializer` and snapshots throw. [Details](#v8) |
| `vm` | 🟡 Partial | `Script`, `createContext` and `runInContext` work, but a context is not a sandbox. [Details](#vm) |
| `wasi` | 🟡 Partial | `WASI` runs wasm32-wasi (preview 1) programs over the project's files; no symlinks or sockets. [Details](#wasi) |
| `worker_threads` | 🟡 Partial | `new Worker(file)` starts a thread with `postMessage`, `workerData` and `terminate()`; no `resourceLimits`. [Details](#worker_threads) |
| `zlib` | 🟡 Partial | gzip, deflate, Brotli and zstd in sync, callback and stream APIs; compressed bytes can differ from Node's. [Details](#zlib) |

Try a few of them:

```ts playground title="index.ts"
import { EventEmitter, once } from "node:events";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { format } from "node:util";

await mkdir("data", { recursive: true });
await writeFile(join("data", "hello.txt"), "hi from node:fs");
console.log(await readdir("data"), await readFile("data/hello.txt", "utf8"));

console.log(createHash("sha1").update("bun").digest("hex"), randomUUID().length);
console.log(gunzipSync(gzipSync(Buffer.from("zlib round trip"))).toString());

const emitter = new EventEmitter();
setTimeout(() => emitter.emit("ready", 42), 10);
const [value] = await once(emitter, "ready");
console.log(format("event said %d", value));
```

## Built-in details

Each section holds the detail behind a Notes cell above, in the table's row order.

### `async_hooks`

Works: `AsyncLocalStorage` (`run`, `exit`, `enterWith`, `disable`, `getStore`, `bind`, `snapshot`) and `AsyncResource` (`runInAsyncScope`, `bind`) keep their context across:

- `await`, `for await` and `try`/`catch`/`finally`
- timers, `setImmediate`, `queueMicrotask` and `process.nextTick`
- promise callbacks (`then`, `catch`, `finally`, `Promise.all`) and `fs` callbacks
- the handler of a `Bun.serve` or `http` server, which runs in the context the server was started in, as in Bun; that is how Hono's `contextStorage()` works

Differs from Node: the browser has no `AsyncContext`, so each `await` in the project's modules (`node_modules` too) gets a few characters of source that put the context back after it. That costs about 2% more code in files that await and a few nanoseconds per `await`; columns after an `await` on a line move in stack traces (lines don't).

Not supported:

- Code that doesn't go through the module loader (`eval`, `new Function`) loses the context at its `await`s, and so does an event the playground raises itself (a socket's `data`, the console's stdin).
- `createHook`, `executionAsyncId` and `executionAsyncResource` do nothing.

### `child_process`

Works:

- `spawn`, `exec` and `execFile` (with `util.promisify`) start child processes, with `stdio` as streams (`pipe`, `inherit`, `ignore`), `cwd`, `env`, `shell`, `timeout`, `signal`, exit codes, `kill` and the `exit`, `close`, `spawn` and `error` events.
- A command that isn't there emits `error` with code `ENOENT`.
- A child can run `bun` or `node` with a file, `bun run` with a `package.json` script or a file, an installed package's bin (`vite`, `tsc`), `sh -c` lines and the shell's builtins, which Bun's shell runs, and `bun test` (see [`Bun.spawn`](/compatibility/bun/#bunspawn)).
- Each child runs in a worker of its own, on the project's files as they are when it starts; what it writes reaches the others.
- A server a child starts answers the preview when the program serves none itself (a script that runs `bun server.ts`), and a preview WebSocket to its port reaches it.

Not supported: `fork` throws, because it needs an IPC channel.

Needs a cross-origin isolated page: `spawnSync`, `execSync` and `execFileSync` work only on one (runbun.dev, or an embed whose host page sends `COOP` and `COEP`), with `input`, `encoding`, `timeout`, `killSignal`, `maxBuffer` (1 MiB by default, as in Node; larger output needs a larger one) and `stdio`. The files the child writes are there when they return. Elsewhere they throw a `NotIsolatedError` (code `ERR_NOT_ISOLATED`): blocking the program until the child ends needs `SharedArrayBuffer` and `Atomics.wait`.

### `console`

Works:

- The global `console`: `log`, `info`, `warn`, `error`, `debug`, `dir`, `table` (drawn as Bun draws it), `trace`, `assert`, `count`/`countReset`, `time`/`timeLog`/`timeEnd` and `group`/`groupCollapsed`/`groupEnd` reach the console pane with Bun's text.
- Values print in Bun's format (`Bun.inspect`'s, two levels deep), without colors since stdout isn't a TTY.
- An uncaught error or unhandled rejection prints the same way, followed by `Bun v1.4.4-browser (Linux x64)`, and ends the program with code 1, as in Bun (see [`process`](#process)).

Errors print as Bun prints them: the source preview (the lines up to the error's, a caret under its column), `error: message` and the frames, in the files' own lines and columns (served ES modules and CommonJS carry a source map, and so does code `require()` runs).

`error.stack` reads as Bun's too, in Chromium browsers:

- frames named as Bun names them (`bar`, not V8's `Foo.bar`; `async fn` for an awaiting function)
- columns where Bun puts them (at `Error` of `new Error()`)
- a builtin's frame as `parse (native)` (a printed error leaves those out, as Bun does)
- the playground's own frames left out

In other browsers `error.stack` keeps the browser's URLs, and only printed errors read as Bun's.

Differs from Bun:

- What the engine decides stays V8's: error messages, a property read's column, and frames JSC drops for tail calls.
- Errors of asynchronous I/O (`fs.promises`, callbacks, `Bun.file` reads) have no `stack`, as in Bun, so they print as `[Error: ENOENT: …]`.
- A promise shows its state if one of the playground's APIs returned it (`fetch`, `Bun.file` reads, `Bun.write`, `Bun.sleep`, `fs.promises`, `timers/promises`) and `<pending>` otherwise: the state of one the program made (`new Promise`, `Promise.resolve`, an async function's result) isn't readable from JS.

Not supported: the `Console` class.

### `crypto`

Works:

- `createHash`/`createHmac` (md5, ripemd160, sha1, sha2, sha3, blake2), `hash`, `pbkdf2`, `scrypt` (sync and callback), `randomBytes`, `randomUUID`, `randomInt`, `getRandomValues`, `timingSafeEqual`, `webcrypto`/`subtle`.
- `createCipheriv`/`createDecipheriv` for AES (`cbc`, `ecb`, `ctr`, `cfb`, `ofb`, `gcm`) and `chacha20-poly1305`, with `setAutoPadding`, `setAAD`, `getAuthTag`/`setAuthTag`, output encodings and the stream interface; `getCiphers`.
- `KeyObject`, `createSecretKey`/`createPublicKey`/`createPrivateKey` (PEM, DER and JWK in; PKCS#1, PKCS#8, SPKI, SEC1 and JWK out), `generateKeyPair`/`generateKeyPairSync` and `generateKey`/`generateKeySync` (`rsa`, `ec` on P-256 and P-384, `ed25519`; `hmac`, `aes`).
- `sign`/`verify`, `createSign`/`createVerify` (RSA PKCS#1 v1.5 and PSS, ECDSA with `der` or `ieee-p1363`, Ed25519), `publicEncrypt`/`privateDecrypt` (OAEP; as in Bun, PKCS#1 v1.5 padding only encrypts).

How it runs: these run in a 0.6 MB WebAssembly module (RustCrypto) that loads the first time a program uses one, which pauses the program for a moment. `generateKeyPair` blocks like the sync form, and generating an RSA key takes about half a second at 2048 bits and over a second at 3072.

Not supported:

- A cipher other than those, passphrase-protected keys, other curves, RSA-PSS and X25519/Ed448 keys.
- `privateEncrypt`/`publicDecrypt`, `createECDH`, `createDiffieHellman`, `X509Certificate` and `hkdf`.
- `KeyObject.from` and `crypto.subtle` keys don't convert.

### `diagnostics_channel`

Works: channels, `subscribe`, `bindStore`/`runStores` with `AsyncLocalStorage`, and `tracingChannel` (`traceSync`, `tracePromise`, `traceCallback`).

The `http` client publishes what Bun's does: `http.client.request.created`, `.start`, `.error` and `http.client.response.finish`. Like Bun, the `http` server and `fetch` publish nothing.

### `domain`

Works as Bun has it: `create`, `run`, `bind`, `intercept`, `add`, `remove`, `enter`, `exit`, `active`. An error thrown synchronously becomes the domain's `error` event; asynchronous ones aren't caught, in Bun neither.

### `fs`, `fs/promises`

Works:

- Sync, callback and promise APIs over the project's files: read/write/append, `stat`, `readdir` (with `Dirent`), `mkdir`, `rm`, `rename`, `copyFile`, `cp`, file descriptors, `FileHandle`, read/write streams.
- `watch` (also recursive) and `watchFile` fire on changes.

Not supported:

- No symlinks or hard links.
- `chmod`/`chown` do nothing.
- `fs/promises` `watch` never yields.

### `http`

Works:

- `createServer().listen(port)` serves the [preview](/playground/preview/) on that port, as `Bun.serve` does: several at once; `listen(0)` or no port gets a free one, which `server.address().port` gives; a port already served is an `EADDRINUSE` `"error"` event. Streamed responses, cookies and WebSocket `upgrade` work.
- `http.request`/`http.get` are a `ClientRequest` over `fetch` and an `IncomingMessage` streaming the body (`timeout`, `signal`, `auth`, `abort()`; `agent` is accepted and ignored). They reach this program's own servers on `localhost` and, for other hosts, follow the browser's CORS rules.
- axios works with its default adapter (`http`, over this), as `import` or `require`: there is no `XMLHttpRequest` global in the worker, as in Bun.

Differs from Node:

- Redirects from this program's own servers come back as the redirect, as in Node; other hosts' are followed (the browser doesn't hand them over).
- The request body is sent when `end()` is called.
- Every network failure is `ECONNREFUSED` (the browser doesn't say why).

Not supported: a child process's server isn't reachable.

### `inspector`

`Session` connects and answers `Runtime.enable`, `Profiler.enable` and their `disable` as Bun does (also `inspector/promises`); other methods fail with Bun's "wasn't found" error.

Not supported: no profiler or debugger. `open()` throws, `url()` is `undefined`.

### `module`

Works:

- `builtinModules`, `isBuiltin`.
- `createRequire` loads built-ins, project files and installed packages with Bun's resolver, computed specifiers too, and has `require.resolve`, `require.cache` and `require.main`.
- `require()` of an ES module loads it synchronously, with limits (see [Toolchain](/compatibility/toolchain/#commonjs-and-require)).

### `process`

Works:

- Reports Linux x64 and Node v24.3.0.
- `env`, `cwd`, `chdir`, `nextTick`, `hrtime`, `memoryUsage`, `uptime`, `getBuiltinModule` (`node:` and `bun:` modules, `undefined` for others).
- `stdout`/`stderr` go to the console. `argv` is `["bun", entry]`.
- `kill(pid, signal)` signals a child process or the program itself: a listener for the signal gets it, else the program ends by it (`SIGKILL` always ends a child).

**`stdin`** is what you type in the console while the program reads it (a `data` or `readable` listener, `for await`, `readline`, `Bun.stdin`), and in a child process what the parent writes. It is a Readable that ends at end of input (<kbd>Ctrl</kbd>+<kbd>D</kbd>), with `setEncoding`, `pause` and `resume` (a paused or ended `stdin` lets the program end).

**Terminal:**

- In the main program `stdin`, `stdout` and `stderr` are a terminal while the console is its terminal: `isTTY` true, `columns` and `rows` the console's size with a `resize` event, `getColorDepth()` 24, `hasColors()`, `cursorTo`, `moveCursor`, `clearLine`, `clearScreenDown`.
- `stdin.setRawMode(true)` delivers every key as the bytes a terminal sends, at once and without echo, <kbd>Ctrl</kbd>+<kbd>C</kbd> and <kbd>Ctrl</kbd>+<kbd>D</kbd> included (`isRaw`).
- In a child process or a test run they are pipes (`isTTY` is false and `setRawMode` does nothing).

**Exit:**

- `exit(code)` ends the program as in Bun: `exit` listeners run, nothing after it does, servers and timers stop, and the console and status show the exit code.
- An uncaught error or unhandled rejection does the same with code 1 unless an `uncaughtException`/`unhandledRejection` listener takes it (a listener that throws ends it with code 7).
- An unhandled rejection gives `exit` listeners `process.exitCode` (0 when unset) and still ends with code 1, as in Bun.
- A program that runs out of work ends as in Bun: `beforeExit` fires with `process.exitCode` (again each time its listeners start more work), then `exit`, and the status shows the code.

**What keeps the program running:** timers, servers, `fs.watch`, WebSocket clients and the playground's own pending promises (`fetch`, `Bun.sleep`, `Bun.file` reads, `fs.promises`, `Bun.password`), unless `unref`'d; so do running child processes. The browser's other async APIs (`crypto.subtle`, `WebAssembly.instantiate`, a literal `import()`) don't, so a program counts as idle only after 50 ms with nothing pending.

### `readline`, `readline/promises`

Works:

- `createInterface({ input, output })` (or `(input, output)`) over `process.stdin` or any readable: the `line`, `close`, `pause` and `resume` events, `question(query, cb)`, `prompt()`, `setPrompt`/`getPrompt`, `write`, `close()` and `for await (const line of rl)`; `readline/promises` `question()` returns a promise.
- Lines split at `\n`, `\r\n` or `\r`, the unterminated rest comes at the end of input, then `close`.
- On a pipe (`terminal` false) it splits lines and the console echoes what you type.
- When `output` is the console's `process.stdout` (or `terminal: true`) it is Node's terminal mode: the interface sets raw mode, edits the line itself (cursor keys, Home/End, word and line deletion, history with Up and Down), draws the echo and prompt with escape sequences and turns <kbd>Ctrl</kbd>+<kbd>C</kbd> into `SIGINT`.
- `emitKeypressEvents(process.stdin)` emits Node's `keypress` events (`str`, `{ sequence, name, ctrl, meta, shift }`).
- `clearLine`, `cursorTo`, `moveCursor` and `clearScreenDown` write their escape sequences to the stream and return `true`, as Node does.

Not supported: `completer` (Tab inserts a tab) and the `Readline` class.

### `sqlite`

`node:sqlite` only, as in Bun (bare `sqlite` is the npm package). It runs over the same SQLite engine as [`bun:sqlite`](/compatibility/bun/#bun-modules), with file databases kept in the project as files, WAL mode included.

Works:

- `DatabaseSync` (`open`, `close`, `exec`, `prepare`, `function`, `aggregate`, `serialize`, `deserialize`, `createTagStore`, `setAuthorizer`, `enableDefensive`, `location`, `isOpen`, `isTransaction`, `limits`, the `readOnly`, `enableForeignKeyConstraints`, `readBigInts`, `returnArrays`, `defensive`, `limits`, `timeout` and parameter options).
- `StatementSync` (`run`, `get`, `all`, `iterate`, `sourceSQL`, `expandedSQL`, named and positional parameters, `setReadBigInts`, `setReturnArrays`, `setAllowBareNamedParameters`, `setAllowUnknownNamedParameters`) and `backup`.
- `columns()` gives each column's name, declared type and the database, table and column it comes from.
- Sessions (`createSession`, `changeset`, `patchset`, `applyChangeset` with `filter` and `onConflict`) work.
- `timeout` waits that long for a lock another connection of the program holds.
- Aggregates can be window functions (`inverse`).

Types and quoting:

- Double-quoted strings are identifiers only, as in Node and Bun, unless `enableDoubleQuotedStringLiterals`.
- Numbers bind as a REAL and BigInts as exact 64-bit INTEGERs, as in Bun, and a user function's results are typed the same way.

Differs from Bun: the build's maximums differ for three limits: `length` is 1000000000 (Bun: 2147483645), `functionArg` 1000 (127) and `variableNumber` 32766 (500000).

Not supported: extensions.

### `test`

`node:test` only (bare `test` is the npm package). As in Bun, its tests run under `bun test` in the console, through [`bun:test`](/compatibility/bun/#buntest).

Works:

- `test`/`it`, `describe`/`suite` with `skip`, `todo` and `only` (which runs like any test, as without `--test-only`), `before`, `after`, `beforeEach`, `afterEach`, done callbacks.
- Subtests (`t.test`, run inside their parent, which fails if one does, with the first failure as its `cause`), `t.skip()`, `t.todo()`, `t.plan()` (with `wait`), `t.assert`, `getTestContext`.
- `mock` (`fn`, `method`, `getter`, `setter`, `property`, `timers` on bun:test's fake timers; `t.mock` is restored after its test).

`run({ files })` runs each file in a `bun test` child process, as Bun does, and returns its `TestsStream` (a Readable of `{ type, data }`, each also an event):

- `test:enqueue`, `test:dequeue`, `test:pass` and `test:fail` for each test and subtest (skips and todos as passes carrying their directive, skipped suites as `suite`s)
- `test:stdout` and `test:stderr` with the files' output
- a file that fails to load as a failed test of the file's name
- a `test:summary` per file, then `test:plan`, the `test:diagnostic` totals and the run's `test:summary`
- the options `setup`, `cwd`, `env`, `argv`, `execArgv` and `signal`

Not supported:

- The options Bun hasn't implemented (`watch`, `coverage`, `only`, name patterns, `concurrency`, no `files`) throw its `ERR_NOT_IMPLEMENTED`.
- `mock.module()` or snapshots, which Bun lacks too.

### `tty`

Works:

- `isatty(0)`, `isatty(1)` and `isatty(2)` are true for the main program while the console is its terminal, false in a child process or a test run.
- `ReadStream` (`isRaw`, `setRawMode`) and `WriteStream` (`columns`, `rows`, `getWindowSize`, `getColorDepth`, `hasColors`, cursor and line helpers).
- The console draws the cursor and line-clearing sequences programs emit (`ESC[nA/B/C/D`, `ESC[2K`, `ESC[G`, `ESC[J`, `ESC[?25l/h`, `\r`), so `@clack/prompts` updates in place.

### `util`, `util/types`

Works:

- `format`, `inspect` (Bun's port of Node's, with its options), `promisify`, `callbackify`, `inherits`, `deprecate`, `types`, `isDeepStrictEqual`, `parseEnv`, `parseArgs`, `styleText` (no colors).

Differs from Node:

- In `inspect`, a promise shows its state only if one of the playground's APIs returned it (see [`console`](#console)), a Map or Set iterator shows no entries and a Proxy shows as its target.

Not supported: no `MIMEType`; `debuglog` does nothing.

### `v8`

Works:

- `serialize` and `deserialize` write and read the same bytes as Bun (JavaScriptCore's structured-clone format, Buffers in Bun's envelope), so data moves between the two. A whole number JavaScriptCore keeps as a double (`1.5 * 2`) can come out as an integer instead.
- `getHeapStatistics`, `getHeapSpaceStatistics` and `getHeapCodeStatistics` have Bun's shape, with the heap sizes Chrome reports.

Not supported: `Serializer`, `Deserializer` and heap snapshots throw (the first two in Bun too).

### `vm`

Works: `runInThisContext`, `Script`, `createContext`, `runInContext`, `runInNewContext`, `isContext`, `compileFunction` (with `contextExtensions` and `parsingContext`), `constants`.

**A context is not a sandbox**: the worker has one realm, so a context is the object you pass plus a fresh set of the standard globals (`Array`, `JSON`, `Math`, `Promise` and so on, no `process`, `Bun`, `fetch` or timers), and the code can reach the worker through any prototype (`({}).constructor.constructor("return process")()`). Don't run code you don't trust with it.

Scope and globals:

- Top-level `var` and function declarations land on the context object and a name that isn't there is a `ReferenceError`, as in Node.
- `let`, `const` and `class` stay local to one run, `this` and `globalThis` are the context, but a function's own `this` is the worker's.
- `[] instanceof Array` is true across contexts (false in Node).

Options and errors:

- `filename` appears in stack traces.
- `timeout`, `breakOnSigint`, `importModuleDynamically` and `cachedData` are ignored (a script runs to its end).
- `createCachedData()` returns an empty `Buffer`, `measureMemory()` resolves with zeros and the module classes (`SourceTextModule` and the like) throw.
- A syntax error's `stack` starts with the file name but has no line or caret.

### `wasi`

Works:

- `WASI` runs wasm32-wasi (preview 1) programs over the project's files: `args`, `env`, `preopens` (a path in the program → a project directory, which it can't leave), `wasiImport`, `start` and `getImports`, clocks and `random_get`.
- What it writes to stdout and stderr goes to the console (or to `sendStdout`/`sendStderr`).
- stdin comes from `getStdin` (without it, stdin is empty: the console can't be read synchronously).
- `proc_exit` ends the program with its code, as Bun's does. Node's `returnOnExit: true` makes `start` return the code instead.
- `getImportObject` and `initialize` work too (Bun has neither).
- Files a program writes appear when it closes them or ends.

Not supported: no symlinks or sockets; `poll_oneoff` doesn't wait.

### `worker_threads`

Works:

- `new Worker(file)` (a path from the working directory or a `file:` URL, or code with `eval: true`) starts a thread in a worker of its own, on the project's files as they are when it starts.
- `workerData`, `argv`, `env` (a copy of `process.env` by default), `postMessage` both ways with transfers, `parentPort`, `isMainThread`, `threadId`, `getEnvironmentData`, the `online`, `message`, `error` and `exit` events, `terminate()` and `ref`/`unref`.
- An uncaught error in the thread is its `error` event and ends it with code 1.
- A thread listening on `parentPort` keeps running until it closes the port or is terminated, as in Bun.
- What it prints goes to the program's output (`worker.stdout` with `stdout: true`).
- `MessageChannel` and `BroadcastChannel` are the browser's. The global Web `Worker` runs on the same threads: see [Bun APIs](/compatibility/bun/#importmeta-and-globals).

Not supported: `SHARE_ENV` gives a copy, not a shared `env`; no `resourceLimits`, `stdin` or `receiveMessageOnPort`.

### `zlib`

Works: gzip, deflate (zlib and raw), `unzip`, Brotli and zstd: sync, callback and stream APIs, `crc32`, `constants`.

Differs from Node:

- Brotli and zstd run in WebAssembly and compress a stream when it ends, so `flush()` emits nothing early.
- zstd reads only the compression level (`ZSTD_c_compressionLevel`) of its parameters, and writes no checksum or dictionary.
- The compressed bytes can differ from Node's but decompress anywhere.
