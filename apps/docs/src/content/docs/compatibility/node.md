---
title: Node built-ins
description: Which node:* modules work in the playground.
sidebar:
  order: 3
---

Built-ins import with or without the `node:` prefix. Labels are explained on the [overview](/compatibility/).

| Module | Status | Notes |
|---|---|---|
| `assert`, `assert/strict` | 🟡 Partial | Common assertions (`strictEqual`, `deepStrictEqual`, `rejects`, …). |
| `async_hooks` | 🟡 Partial | `AsyncLocalStorage` keeps its store only synchronously; it's lost across `await` and timers. `createHook` does nothing. |
| `buffer` | ✅ Works | Includes `Blob`, `File`, `atob`, `btoa`, `isUtf8`, `isAscii`. |
| `child_process` | ⚪ Stub | No processes in the browser. |
| `cluster` | ⚪ Stub | `isPrimary` is `true`; `fork` throws. |
| `console` | 🟡 Partial | The global `console`: `log`, `info`, `warn`, `error`, `debug`, `dir`, `table` (drawn as Bun draws it), `trace`, `assert`, `count`/`countReset`, `time`/`timeLog`/`timeEnd` and `group`/`groupCollapsed`/`groupEnd` reach the console pane with Bun's text. Values print in Bun's format (`Bun.inspect`'s, two levels deep), without colors since stdout isn't a TTY. Errors print as Bun prints them: the source preview (the lines up to the error's, a caret under its column), `error: message` and the frames, in the files' own lines and columns (ES modules carry a source map; CommonJS frames point into the transpiled code). The caret sits where V8 puts the column (`new` of `new Error()`, where Bun points at `Error`), and the playground's own frames are left out. An uncaught error or unhandled rejection prints the same way, followed by `Bun v1.4.4-browser (Linux x64)`; the program keeps running where Bun would exit. A promise shows `<pending>` whatever its state. No `Console` class. |
| `constants` | ⚪ Stub | Empty object. |
| `crypto` | 🟡 Partial | `createHash`/`createHmac` (md5, ripemd160, sha1, sha2, sha3, blake2), `hash`, `pbkdf2`, `scrypt` (sync and callback), `randomBytes`, `randomUUID`, `randomInt`, `getRandomValues`, `timingSafeEqual`, `webcrypto`/`subtle`. No ciphers, `sign`/`verify`, `KeyObject`, `generateKey*`. |
| `dgram` | ❌ Missing | |
| `diagnostics_channel` | ⚪ Stub | Subscribers never receive messages. |
| `dns`, `dns/promises` | 🟡 Partial | `lookup` resolves only `localhost`. |
| `domain` | ❌ Missing | |
| `events` | ✅ Works | `EventEmitter`, `once`, `on`, with `AbortSignal`. |
| `fs`, `fs/promises` | 🟡 Partial | Sync, callback and promise APIs over the project's files: read/write/append, `stat`, `readdir` (with `Dirent`), `mkdir`, `rm`, `rename`, `copyFile`, `cp`, file descriptors, `FileHandle`, read/write streams. `watch` (also recursive) and `watchFile` fire on changes. No symlinks or hard links; `chmod`/`chown` do nothing; `fs/promises` `watch` never yields. |
| `http` | 🟡 Partial | `createServer().listen()` serves the [preview](/guides/features/#preview): streamed responses, cookies, WebSocket `upgrade`. `http.request`/`http.get` throw; use `fetch`. |
| `https` | 🟡 Partial | Like `http`; no TLS. |
| `http2` | ⚪ Stub | |
| `inspector` | ⚪ Stub | |
| `module` | 🟡 Partial | `builtinModules`, `isBuiltin`. `createRequire` loads built-ins, project files and installed packages with Bun's resolver, computed specifiers too, and has `require.resolve`, `require.cache` and `require.main`; `require()` of an ES module loads it synchronously, with limits (see [Toolchain](/compatibility/toolchain/#commonjs-and-require)). |
| `net` | ⚪ Stub | `isIP*` works; no sockets. |
| `os` | 🟡 Partial | Fixed values: Linux, x64, `/home/user`, `/tmp`. `cpus()` and `networkInterfaces()` are empty. |
| `path`, `path/posix` | ✅ Works | POSIX only. `path.win32` behaves like POSIX; `path/win32` is missing. |
| `perf_hooks` | 🟡 Partial | `performance`, `PerformanceObserver`. `monitorEventLoopDelay` reports zeros. |
| `process` | 🟡 Partial | Reports Linux x64 and Node v24.3.0. `env`, `cwd`, `chdir`, `nextTick`, `hrtime`, `memoryUsage`, `uptime`. `stdout`/`stderr` go to the console. `argv` is `["bun", entry]`; `stdin` never emits; `exit` and `kill` throw. |
| `punycode` | ✅ Works | |
| `querystring` | ✅ Works | |
| `readline`, `readline/promises` | ⚪ Stub | |
| `repl` | ❌ Missing | |
| `sqlite` | ❌ Missing | Use [`bun:sqlite`](/compatibility/bun/#bun-modules). |
| `stream`, `stream/promises` | ✅ Works | Based on `readable-stream`. `Readable.toWeb`/`fromWeb` are basic. |
| `stream/web` | ✅ Works | The browser's web stream classes. |
| `string_decoder` | ✅ Works | |
| `sys` | 🟡 Partial | Same as `util`. |
| `test` | ❌ Missing | Use [`bun:test`](/compatibility/bun/#buntest). |
| `timers`, `timers/promises` | ✅ Works | `ref`, `unref`, `refresh`, promise timers with `AbortSignal`. |
| `tls` | ⚪ Stub | |
| `trace_events` | ❌ Missing | |
| `tty` | 🟡 Partial | `isatty` returns `false`. |
| `url` | ✅ Works | `URL`, `URLSearchParams`, `fileURLToPath`, `pathToFileURL`, `parse`. |
| `util`, `util/types` | 🟡 Partial | `format`, `inspect` (Bun's port of Node's, with its options; a promise shows its state only when the playground saw it settle, a Map or Set iterator shows no entries and a Proxy shows as its target), `promisify`, `callbackify`, `inherits`, `deprecate`, `types`, `isDeepStrictEqual`, `parseEnv`, `parseArgs`, `styleText` (no colors). No `MIMEType`; `debuglog` does nothing. |
| `v8` | ⚪ Stub | |
| `vm` | ⚪ Stub | |
| `wasi` | ❌ Missing | |
| `worker_threads` | 🟡 Partial | `isMainThread`, `MessageChannel`, `BroadcastChannel`. `new Worker()` throws. |
| `zlib` | 🟡 Partial | gzip, deflate (zlib and raw) and `unzip`: sync, callback and stream APIs, `crc32`, `constants`. Brotli functions throw. |

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
