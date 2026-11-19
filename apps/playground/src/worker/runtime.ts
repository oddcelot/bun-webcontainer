import { BASE } from "../base";
import { loadResolver, parseData, parseDataFile, resolve } from "../resolver";
import { loadSemver } from "../semver";
import { dirname, norm, VFS, type FileData } from "@runbun/vfs";
import { readConfig } from "../projectConfig";
import { BUN_NAMES, builtinName, builtins, compressionStreams, installAsyncContext, installTimers, setBunFetch, setExit, setFs, setWatchReport, setRawStdio, setRequire, setStdio } from "./node";
import { BuildPlugins } from "./buildPlugins";
import { bundle, type BundleConfig, type BundleLog } from "./bundler";
import { setHostVfs } from "./hostPackages";
import { hash } from "./hash";
import { CryptoHasher } from "./node/crypto";
import { setCryptoWasm } from "./node/cryptoWasm";
import { Glob } from "./glob";
import { FileSink } from "./fileSink";
import { FileSystemRouter } from "./fileSystemRouter";
import { plugin, pluginImportUrl, pluginRequire, setPluginHost } from "./plugins";
import { pluginModuleHost, setPluginHook } from "./node/module";
import { installConsole, table } from "./console";
import { bunInspect, formatLog as formatValues, installWebInspect } from "./inspect";
import { trackBodies } from "./bodies";
import { keepRequestHeaders, withHeaders } from "./requestHeaders";
import { fulfilled, tracked, trackedFn } from "./promises";
import { createS3 } from "./s3";
import { currentGeneration, hold, holdUntil, release, whenIdle } from "./loop";
import { frameMapper, installStackTraces, previewSource } from "./sourceMaps";
import { installDebugger, installNoopDebugger } from "./debugger";
import { json5Stringify, tomlStringify, yamlStringify } from "./dataStringify";
import { password } from "./password";
import { Cookie, CookieMap } from "./cookie";
import { importMetaResolve, resolveSync } from "./resolve";
import { Transpiler } from "./transpiler";
import { makeJSONL } from "./jsonl";
import { makeMarkdown } from "./markdown";
import { makeXML, setProxyCheck } from "./xml";
import { HTMLRewriter } from "./htmlRewriterWasm";
import { isProxy } from "./proxies";
import { markdownWasm, xmlWasm } from "../transpiler";
import { asyncError, codeError, fsError } from "./node/errors";
import { capture, runIn } from "./node/asyncHooks";
import { MIME, mimeOf } from "./mime";
import { hooks, type NodeSocket } from "./node/serve";
import { flushDatabases } from "./node/sqlite";
import { SQL, flushSql, sql } from "./sql";
import nodePath from "./node/path";
import process, { env } from "./node/process";
import { enableTTY, resizeTTY } from "./node/tty";
import { isDeepStrictEqual } from "./node/util";
import { failRunning, runTestFiles, setReport } from "./node/test";
import { finishCoverage, startCoverage } from "./coverage";
import { coverageOptions } from "../coverage/options";
import { splitTestArgs, testOptions, type TestOptions } from "../testArgs";
import { BUN_REVISION, BUN_VERSION } from "./bunVersion";
import * as fflate from "fflate";
import { bunZstdCompress, bunZstdCompressSync, bunZstdDecompress, bunZstdDecompressSync } from "./compress";
import { createDollar } from "../shell/dollar";
import { builtins as shellBuiltins } from "../shell/builtins";
import { nodeFs as shellFs } from "../shell/nodeFs";
import { loadShellWasm } from "../shell/load";
import { FILE_PATH } from "../shell/parse";
import { Buffer } from "./node/buffer";
import { consoleLines, installDialogs, pushStdin, setStdinPost, StdinFile, stdinStream } from "./stdin";
import { Shell as ShellInterpreter, ShellEnv, type Command as ShellCommand, type Reader } from "../shell/interp";
import { templateSource } from "../shell/parse";
import { childByPid, launchOf, onProcMessage, setKernel, setSyncVfs, signalName, SIGNALS, spawnChild, type Child } from "./processes";
import { spawn as bunSpawn, spawnSync as bunSpawnSync } from "./spawn";
import { setThread, threadEnd, threadError, type ThreadInfo } from "./node/worker_threads";
import { WebWorker } from "./webWorker";
import { cliPreloads, isShellCommand, isTestFile } from "../scripts";
import { hideXhr, XHR } from "./xhr";
import { randomUUIDv7 } from "./uuid";
import { loopbackWebSocket } from "./loopbackSocket";

type Handler = (req: Request, server: unknown) => Response | Promise<Response>;
type HtmlImport = { __htmlImport: string };
type RouteValue = Response | Handler | HtmlImport | Partial<Record<string, Handler | Response>>;
type Routes = Record<string, RouteValue>;
type WebSocketHandlers = {
  open?(ws: ServerWebSocket): void;
  message?(ws: ServerWebSocket, message: string | Uint8Array): void;
  close?(ws: ServerWebSocket, code: number, reason: string): void;
  drain?(ws: ServerWebSocket): void;
};
type ErrorHandler = (this: unknown, err: unknown) => unknown;
type ServeOptions = {
  port?: number | string;
  hostname?: string;
  fetch?: Handler;
  routes?: Routes;
  websocket?: WebSocketHandlers;
  error?: ErrorHandler;
  development?: boolean | object;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  unix?: string;
  reusePort?: boolean;
};
type WsPayload = string | ArrayBuffer | ArrayBufferView;

const g = globalThis as unknown as Record<string, unknown>;
// The worker's channel to the page, saved: in a thread, the program's own `self.postMessage` and `close` are its
// Worker's (node/worker_threads.ts ThreadScope).
const selfPost = (self as unknown as Worker).postMessage.bind(self);
const selfClose = self.close.bind(self);
const post = (msg: unknown, transfer: Transferable[] = []) => selfPost(msg, transfer);

// The worker's copy of the page VFS (sent with "start"); node:fs and Bun.file read it synchronously, and
// writes are mirrored to the page.
const vfs = new VFS();
/**
 * Large installed files stay out of memory (the page's pkgStore.ts): reading one asks the page for it and blocks
 * until its bytes are in a buffer shared with the page, which keeps it too. Only where the page is cross-origin
 * isolated, the only place installs leave files out.
 */
if (typeof SharedArrayBuffer === "function" && crossOriginIsolated)
  vfs.loadSync = (path, ref) => {
    const sab = new SharedArrayBuffer(8 + ref.size);
    const state = new Int32Array(sab, 0, 1);
    post({ type: "lazy-read", path, ref, sab });
    Atomics.wait(state, 0, 0, 60_000);
    if (Atomics.load(state, 0) !== 1) throw fsError("EIO", "read", "/" + path);
    return new Uint8Array(sab, 8, ref.size);
  };
setHostVfs(vfs);
setFs(vfs, (op, ...args) => post({ type: "vfs", op, args }));
process.stdin = stdinStream;
setStdinPost(post, true);
setWatchReport((watched) => post({ type: "watching", watched }));
installDialogs(g, (text) => void process.stdout.write(text));
setStdio((level, text, partial) => post({ type: "console", level, text, partial }));
const has = (path: string) => vfs.files.has(path);
const read = (path: string) => vfs.readText(path);
const listDirs = (dir: string) => vfs.readdir(dir).flatMap((e) => (e.dir ? [e.name] : []));
setKernel(post, 1, has, read, listDirs);
g.__nodeBuiltins = builtins;
// node:crypto's ciphers and keys (crypto-wasm): fetched and compiled synchronously on the first call that needs them, as
// transpiler/index.ts does for Bun.Transpiler#transformSync. The worker's sync XHR is the only way to the bytes in a
// synchronous API.
setCryptoWasm(() => {
  const xhr = new XHR();
  xhr.open("GET", new URL(`${BASE}bun_crypto_wasm.wasm`, location.href), false);
  xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status !== 200) throw new Error(`failed to load the crypto module: HTTP ${xhr.status}`);
  return new WebAssembly.Module(xhr.response as ArrayBuffer);
});

/**
 * `import(url)` that the host Vite leaves alone: in dev it rewrites computed imports in the playground's own code to
 * add `?import`, and the same module imported statically elsewhere would load a second time.
 */
/** Where the page serves modules (moduleServer.ts `vfsRoot`), from the start message. */
let VFS_ROOT = `${BASE}__vfs/`;

const importUrl = new Function("url", "options", "return import(url, options)") as (url: string, options?: ImportCallOptions) => Promise<unknown>;

/** `import(expr)` in served modules (see rewriteMeta): `file:` URLs and paths, as Bun takes them, load from the VFS. */
g.__dynamicImport = (from: string, spec: unknown, options?: ImportCallOptions) => {
  const s = String(spec);
  const builtin = builtinName(s);
  if (builtin !== undefined) return importUrl(`${VFS_ROOT}__node/${builtin}`);
  // What a runtime plugin (Bun.plugin) takes, the page asks it for (plugins.ts).
  const plugged = pluginImportUrl(from, s);
  if (plugged) return plugged.then((url) => importUrl(url, options));
  // A package resolves from the importer's directory (CommonJS the worker runs itself rewrites literal imports to this too).
  const pkg = !/^(file:|\/|\.|[a-z][a-z\d+.-]*:)/i.test(s) && from.startsWith("file:") ? resolve(s, dirname(norm(decodeURIComponent(new URL(from).pathname))), "import", "bun") : null;
  const path = pkg ?? (/^(file:|\/|\.)/.test(s) && decodeURIComponent(new URL(s, from).pathname));
  if (!path) return importUrl(s, options);
  const file = norm(path);
  return importUrl(`${VFS_ROOT}${file.endsWith(".css") ? "__css/" : ""}${file}`, options);
};
/** `import.meta.resolve` in served modules (see rewriteMeta), bound to the module's path. */
g.__importMetaResolve = importMetaResolve;
/** A served data file's value (see moduleServer.ts dataModule). */
g.__parseDataFile = parseDataFile;
g.process = process;
// Bun's Worker, on the process kernel (the browser's own can't load the project's files).
g.Worker = WebWorker;
// lol-html (wasm, loaded on first use). A global only, not a `Bun` member, as in Bun.
g.HTMLRewriter = HTMLRewriter;
g.global ??= globalThis;
setProxyCheck(isProxy);
g.Buffer ??= (builtins.buffer as { Buffer: unknown }).Buffer;
installTimers();
installAsyncContext();
hideXhr();
Object.assign(globalThis, compressionStreams); // gzip, deflate-raw and also brotli, zstd

/** One `Bun.serve` (or `http.Server#listen`). A program may start several: devframe adds one on port 0 for its RPC socket. */
interface Instance {
  handler?: Handler;
  routes: Routes;
  websocket: WebSocketHandlers;
  port: number;
  /** Started on port 0: a helper the preview never shows. */
  ephemeral: boolean;
  topics: Map<string, Set<ServerWebSocket>>;
  /** `error`: answers for a handler that threw or rejected. */
  error?: ErrorHandler;
  /** Picks the default error page (Bun's HTML one, or "Something went wrong!") and what a failed request logs. */
  development: boolean;
  /** `maxRequestBodySize`: a larger request body gets a 413 instead of the handler. */
  maxBody: number;
  /** `unix`: the socket path `fetch(url, { unix })` reaches it on; such a server has no port and no preview. */
  unix?: string;
  server: object;
  /** The AsyncLocalStorage context `Bun.serve` was called in: its handlers run in it, as in Bun. */
  context: ReturnType<typeof capture>;
}

const servers: Instance[] = [];
/** Called when a server starts (see the "start" handler: a package's bin starting one late). */
let onServer: (() => void) | undefined;
let nextPort = 40001;
/** What the preview shows: the first server on a fixed port. */
const previewServer = () => servers.find((s) => !s.ephemeral) ?? servers[0];
/** Tells the page which ports the program serves (the status bar shows them); helpers on port 0 aren't listed. */
const postPorts = () => post({ type: "ports", ports: servers.filter((s) => !s.ephemeral).map((s) => s.port) });
const stopServer = (inst: Instance) => {
  servers.splice(servers.indexOf(inst) >>> 0, 1);
  release(inst);
  postPorts();
};

/** A node:http server's accepted WebSockets carry their `ws` connection as data (see upgradeRequests). */
const nodeSockets: WebSocketHandlers = {
  open: (ws) => (ws.data as NodeSocket).open(ws),
  message: (ws, m) => (ws.data as NodeSocket).message(m),
  close: (ws, code, reason) => (ws.data as NodeSocket).close(code, reason),
};
hooks.listen = (fetch, port) => {
  const inst = listen({ fetch, websocket: nodeSockets, port });
  // The listening `http.Server` holds the program (net.ts), so its `unref()` lets it end.
  release(inst);
  return { port: inst.port, stop: () => servers.includes(inst) && stopServer(inst) };
};

/**
 * Requests the worker made for a page's WebSocket: `server.upgrade(req)` accepts them, once, with the Set-Cookie
 * headers Bun's 101 response would carry.
 */
const upgrades = new WeakMap<Request, (data: unknown, setCookies: string[]) => void>();
/** Requests `server.upgrade` accepted: their handler may return nothing. */
const upgraded = new WeakSet<Request>();

const size = (m: WsPayload) => (typeof m === "string" ? new TextEncoder().encode(m).length : m.byteLength);
const bytesOf = (m: Exclude<WsPayload, string>) =>
  m instanceof ArrayBuffer ? m.slice(0) : (m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer);

/** What Bun sends for a message: bytes, else the value as a string (a number, an object); nothing is an error. */
const wsPayload = (m: unknown): WsPayload => {
  if (m === null || m === undefined) throw new TypeError("send requires a non-empty message");
  return typeof m === "string" || m instanceof ArrayBuffer || ArrayBuffer.isView(m) ? m : String(m);
};

/** Bun's `ServerWebSocket`, talking to the page's `WebSocket` over a MessagePort (see previewWebSocket in swPage.ts). */
class ServerWebSocket {
  readyState = 1;
  binaryType = "nodebuffer";
  remoteAddress = "127.0.0.1";
  #subs = new Set<string>();
  constructor(
    private port: MessagePort,
    private inst: Instance,
    public data: unknown,
  ) {}
  send(message: WsPayload) {
    message = wsPayload(message);
    if (this.readyState !== 1) return 0;
    const data = typeof message === "string" ? message : bytesOf(message);
    this.port.postMessage({ type: "message", data }, typeof data === "string" ? [] : [data]);
    return size(message);
  }
  sendText(message: string) {
    return this.send(message);
  }
  sendBinary(message: ArrayBuffer | ArrayBufferView) {
    return this.send(message);
  }
  publish(topic: string, message: WsPayload) {
    message = wsPayload(message);
    for (const ws of this.inst.topics.get(topic) ?? []) if (ws !== this) ws.send(message);
    return size(message);
  }
  publishText(topic: string, message: string) {
    return this.publish(topic, message);
  }
  publishBinary(topic: string, message: ArrayBuffer | ArrayBufferView) {
    return this.publish(topic, message);
  }
  subscribe(topic: string) {
    this.#subs.add(topic);
    let set = this.inst.topics.get(topic);
    if (!set) this.inst.topics.set(topic, (set = new Set()));
    set.add(this);
  }
  unsubscribe(topic: string) {
    this.#subs.delete(topic);
    this.inst.topics.get(topic)?.delete(this);
  }
  isSubscribed(topic: string) {
    return this.#subs.has(topic);
  }
  get subscriptions() {
    return [...this.#subs];
  }
  cork<T>(fn: (ws: this) => T) {
    return fn(this);
  }
  ping() {
    return 0;
  }
  pong() {
    return 0;
  }
  getBufferedAmount() {
    return 0;
  }
  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    this.port.postMessage({ type: "close", code, reason });
    this.closed(code, reason);
  }
  terminate() {
    this.close(1006);
  }
  /** The connection is gone, from either side. */
  closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const t of this.#subs) this.inst.topics.get(t)?.delete(this);
    this.#subs.clear();
    this.port.close();
    this.inst.websocket.close?.(this, code, reason);
  }
}

/**
 * The ports the other processes of this run serve (the program and its child processes, as the page last told this
 * one: runner.ts `shareTaken`), so a `Bun.serve` on one of them fails as on a real machine.
 */
let taken = new Set<number>();

/**
 * `Bun.serve`: a server on a port this program or another process of the run already serves isn't started; it throws
 * Bun's EADDRINUSE error, as native Bun does. Port 0 always gets a port of its own.
 */
function listen(opts: ServeOptions): Instance {
  // `idleTimeout` is checked as in Bun, but nothing times out here (the docs say so); `reusePort` changes nothing.
  const idle = opts.idleTimeout;
  if (idle !== undefined && idle !== null) {
    if (typeof idle !== "number" || !Number.isInteger(idle)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Bun.serve expects idleTimeout to be an integer");
    if (idle > 255) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Bun.serve expects idleTimeout to be 255 or less");
  }
  if (opts.unix) {
    if (servers.some((s) => s.unix === opts.unix))
      throw Object.assign(new Error(`EADDRINUSE: address already in use, listen '${opts.unix}'`), { code: "EADDRINUSE", syscall: "listen", errno: 0 });
    return createInstance(opts);
  }
  const port = Number(opts.port ?? env.PORT ?? env.BUN_PORT ?? 3000);
  if (port !== 0 && (taken.has(port) || servers.some((s) => s.port === port)))
    throw Object.assign(new Error(`Failed to start server. Is port ${port} in use?`), { code: "EADDRINUSE", syscall: "listen", errno: 0 });
  return createInstance(opts);
}

/** `maxRequestBodySize` as Bun takes it: 128 MiB unless a size is given; a negative one is no limit. */
const bodyLimit = (n: unknown) => (typeof n !== "number" || Number.isNaN(n) ? 128 * 1024 * 1024 : n < 0 ? Infinity : Math.floor(n));

type SocketAddress = { address: string; family: "IPv4" | "IPv6"; port: number };
/** Where each request a server answered came from (`server.requestIP`), set by `dispatch`. */
const peers = new WeakMap<Request, SocketAddress>();
/** A client on this machine: `127.0.0.1` reaches Bun's dual-stack socket as an IPv4-mapped address, the rest as `::1`. */
const localPeer = (hostname: string): SocketAddress => ({
  address: hostname === "127.0.0.1" || hostname === "0.0.0.0" ? "::ffff:127.0.0.1" : "::1",
  family: "IPv6",
  port: 49152 + Math.floor(Math.random() * 16384),
});

function createInstance(opts: ServeOptions): Instance {
  const requested = Number(opts.port ?? env.PORT ?? env.BUN_PORT ?? 3000);
  const port = requested === 0 ? nextPort++ : requested;
  const hostname = opts.hostname ?? "localhost";
  const inst: Instance = {
    handler: opts.fetch,
    routes: opts.routes ?? {},
    websocket: opts.websocket ?? {},
    port,
    ephemeral: requested === 0,
    topics: new Map(),
    error: opts.error,
    // As in Bun: on unless asked off, or NODE_ENV is production.
    development: opts.development === undefined ? env.NODE_ENV !== "production" : !!opts.development,
    maxBody: bodyLimit(opts.maxRequestBodySize),
    unix: opts.unix || undefined,
    server: {},
    context: capture(),
  };
  if (inst.unix) inst.ephemeral = true;
  inst.server = {
    port: inst.unix ? undefined : port,
    hostname: inst.unix ? undefined : hostname,
    url: new URL(inst.unix ? `unix://${inst.unix}` : `http://${hostname}:${port}/`),
    /** Bun's for a local client: `localhost` and the preview come over IPv6 loopback; none over a unix socket. */
    requestIP: (req: Request) => peers.get(req) ?? null,
    /** Nothing times out here (see `idleTimeout`). */
    timeout(_req: Request, _seconds: number) {},
    get development() {
      return inst.development;
    },
    /** Swaps handlers in place, as Bun's does; the port and hostname stay. */
    reload(next: ServeOptions) {
      if (next.fetch) inst.handler = next.fetch;
      if (next.routes) inst.routes = next.routes;
      if (next.websocket) inst.websocket = next.websocket;
      if (next.error) inst.error = next.error;
    },
    /**
     * As in Bun, the 101 carries the Set-Cookie headers of `headers`, then those of what a route handler set or deleted
     * in `req.cookies` so far (later changes are lost).
     */
    upgrade(req: Request, o?: { data?: unknown; headers?: HeadersInit }) {
      const accept = upgrades.get(req);
      if (!accept) return false;
      upgrades.delete(req);
      upgraded.add(req);
      const setCookies = [...(o?.headers ? new Headers(o.headers).getSetCookie() : []), ...(requestCookies.get(req)?.toSetCookieHeaders() ?? [])];
      accept(o?.data, setCookies);
      return true;
    },
    publish(topic: string, message: WsPayload) {
      message = wsPayload(message);
      const subs = inst.topics.get(topic);
      for (const ws of subs ?? []) ws.send(message);
      return subs?.size ? size(message) : 0;
    },
    subscriberCount: (topic: string) => inst.topics.get(topic)?.size ?? 0,
    get pendingWebSockets() {
      let n = 0;
      for (const s of inst.topics.values()) n += s.size;
      return n;
    },
    async stop() {
      for (const subs of inst.topics.values()) for (const ws of subs) ws.close(1001);
      stopServer(inst);
    },
    /** A listening server holds the program, as in Bun, until `unref()`. */
    ref() {
      if (servers.includes(inst)) hold(inst);
    },
    unref() {
      release(inst);
    },
  };
  servers.push(inst);
  hold(inst);
  postPorts();
  onServer?.();
  return inst;
}

/**
 * Server-side Responses. `new Response()` drops forbidden header names (Set-Cookie), which a server must send; a
 * standalone `Headers` keeps them, so responses get one built from their init, plus what Response adds itself
 * (a form's boundary). `instanceof Response` still holds for the browser's own responses (`fetch()` results).
 * Content types follow Bun: a string body has none until it is served (then `text/plain;charset=utf-8`, see
 * servedHeaders), bytes and a stream of a body or Blob are served as `application/octet-stream`, and `Response.json()`
 * says `application/json;charset=utf-8`.
 */
const NativeResponse = Response;
/** What Bun.serve adds to a response it sends: a default content type, and the body's length where it is known. */
type Served = { type?: string; implicitType?: boolean; length?: number };
const served = new WeakMap<Response, Served>();
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const hasType = (init?: ResponseInit) => new Headers(init?.headers).has("content-type");
/** Streams whose bytes come from a body or a Blob (`response.body`, `request.body`, `blob.stream()`), as Bun's native ones. */
const bodyStreams = new WeakSet<ReadableStream>();
/** The length of such a stream where its body's is known (a Response's string, bytes or Blob): Bun sends it. */
const streamLengths = new WeakMap<ReadableStream, number>();
for (const [proto, key] of [[NativeResponse.prototype, "body"], [Request.prototype, "body"]] as const) {
  const get = Object.getOwnPropertyDescriptor(proto, key)?.get;
  if (get)
    Object.defineProperty(proto, key, {
      get() {
        const s = get.call(this) as ReadableStream | null;
        if (s) bodyStreams.add(s);
        const length = served.get(this as Response)?.length;
        if (s && length !== undefined && !(this as Response).bodyUsed) streamLengths.set(s, length);
        return s;
      },
      configurable: true,
      enumerable: true,
    });
}
const blobStream = Blob.prototype.stream;
Blob.prototype.stream = function stream(this: Blob) {
  const s = blobStream.call(this);
  bodyStreams.add(s);
  streamLengths.set(s, blobSize.call(this) as number);
  return s;
};
const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size")!.get!;
/** The byte length of a body Bun knows before sending it (not a stream's, nor a form's). */
function knownLength(body: BodyInit | null | undefined): number | undefined {
  if (body === null || body === undefined) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  // The Blob's own bytes (a Bun.file's are the file when it was made), not a BunFile's live size.
  if (body instanceof Blob) return blobSize.call(body) as number;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof ReadableStream) return streamLengths.get(body);
  return undefined;
}
class ServerResponse extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    const headers = new Headers(init?.headers);
    for (const [k, v] of super.headers) if (!headers.has(k)) headers.set(k, v);
    const info: Served = { length: knownLength(body) };
    if (!hasType(init)) {
      if (typeof body === "string") {
        headers.delete("content-type");
        info.type = "text/plain;charset=utf-8";
      } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body) || (body instanceof ReadableStream && bodyStreams.has(body))) info.type = "application/octet-stream";
      // A Blob's type, a form's boundary: Bun sends them, but not for HEAD.
      else if (headers.has("content-type")) info.implicitType = true;
    }
    served.set(this, info);
    Object.defineProperty(this, "headers", { value: headers });
  }
  static [Symbol.hasInstance](x: unknown) {
    return x instanceof NativeResponse;
  }
  static json(data: unknown, init?: ResponseInit) {
    const r = new ServerResponse(JSON.stringify(data), init);
    if (!hasType(init)) r.headers.set("content-type", "application/json;charset=utf-8");
    return r;
  }
  /**
   * Bun's: the Location is the URL as given (a browser's resolves it against the worker's own URL, the playground's),
   * and an init object's status defaults to 200.
   */
  static redirect(url: string | URL, init?: number | ResponseInit) {
    const obj = typeof init === "object" && init !== null;
    const status = typeof init === "number" ? init : obj ? (init.status ?? 200) : 302;
    if (!REDIRECT_STATUS.has(status) && !(status === 200 && obj)) throw new RangeError("Failed to execute 'redirect' on 'Response': Invalid status code");
    const r = new ServerResponse(null, { ...(obj ? init : {}), status });
    r.headers.set("location", String(url));
    return r;
  }
  clone(): Response {
    const c = super.clone();
    const info = served.get(this);
    if (info) served.set(c, info);
    return Object.defineProperty(c, "headers", { value: new Headers(this.headers) });
  }
}
Object.defineProperty(ServerResponse, "name", { value: "Response" });
self.Response = ServerResponse as typeof Response;
self.Request = keepRequestHeaders(Request);

/**
 * Bun's `Headers#toJSON`: a plain object of lower-cased names, values joined with ", " except Set-Cookie (an array).
 * Elysia 2 reads WebSocket upgrade headers with it when `typeof Bun` is defined.
 */
Object.defineProperty(Headers.prototype, "toJSON", {
  value: function toJSON(this: Headers) {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of this) out[k] = k === "set-cookie" ? this.getSetCookie() : v;
    return out;
  },
  writable: true,
  enumerable: true,
  configurable: true,
});

// For console.log: what Responses/Requests were made with, promise states, URL's inspect.custom (as in Bun).
trackBodies(self);
installWebInspect(self);

/**
 * The headers Bun.serve sends for `res`, then the Set-Cookie headers of the request's `req.cookies` changes: a default
 * content type (none for HEAD, as Bun leaves out what it would derive from the body) and the content length when the
 * body's is known (a stream's isn't), as Bun adds them.
 */
function servedHeaders(res: Response, setCookies: string[], head = false): [string, string][] {
  const info = served.get(res);
  const length = info?.length !== undefined && !(res.status < 200 || res.status === 204 || res.status === 304) ? info.length : undefined;
  const headers = [...res.headers].filter(([k]) => !(k === "content-length" && length !== undefined) && !(k === "content-type" && head && info?.implicitType));
  if (info?.type && !head && !res.headers.has("content-type")) headers.push(["content-type", info.type]);
  if (length !== undefined) headers.push(["content-length", String(length)]);
  for (const c of setCookies) headers.push(["set-cookie", c]);
  return headers;
}

/** A server-side Request; it keeps forbidden header names (Cookie, Origin, Upgrade, Sec-*), see requestHeaders.ts. */
function serverRequest(path: string, init: { method?: string; body?: BodyInit | null }, headers: [string, string][]) {
  headers = headers.map(([k, v]) => [k, k === "origin" || k === "referer" ? asPageOrigin(v) : v]);
  return new Request(self.location.origin + path, { ...init, headers });
}

/**
 * Preview pages are the app at its server's URL (`http://localhost:3000`), so their Origin and Referer say so,
 * not the playground's origin: servers that admit only loopback origins (devframe's RPC socket) accept them on a
 * deployed playground too, as they would locally.
 */
function asPageOrigin(value: string): string {
  const inst = previewServer();
  const own = self.location.origin;
  if (!inst || !value.startsWith(own)) return value;
  const { hostname, port } = inst.server as { hostname: string; port: number };
  const page = `http://${hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname}:${port}`;
  const rest = value.slice(own.length);
  // `/__preview` or `/__preview/@<client id>` (preview.ts PREFIX) is where the page sits, not part of its path.
  const prefix = new RegExp(`^${BASE}__preview(?:/@[^/]+)?`).exec(rest)?.[0];
  return page + (prefix ? rest.slice(prefix.length) || "/" : rest);
}

/**
 * A page's WebSocket: a GET with `upgrade: websocket` through the server's handler, which may accept it. With `url`,
 * the program's own WebSocket (loopbackSocket.ts) to that URL: its cookies are its own, not the preview's.
 */
async function openSocket(inst: Instance, port: MessagePort, path: string, headers: [string, string][], url?: string) {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const all: [string, string][] = [...headers, ["upgrade", "websocket"], ["connection", "Upgrade"], ["sec-websocket-version", "13"], ["sec-websocket-key", key]];
  const req = url ? new Request(url.replace(/^ws/, "http"), { headers: all }) : serverRequest(path, {}, all);
  const toJar = (setCookies: string[]) => !url && setCookies.length && post({ type: "cookies", path, setCookies });
  let ws: ServerWebSocket | undefined;
  let status: number | undefined;
  upgrades.set(req, (data, setCookies) => {
    ws = new ServerWebSocket(port, inst, data);
    // The page's WebSocket never sees the 101's headers: its cookies go to the preview's cookie jar (runner.ts),
    // before the socket opens, so the page's next request carries them.
    toJar(setCookies);
  });
  try {
    const { res, setCookies } = await dispatch(inst, req);
    // Not upgraded: as in Bun, the handler's Response goes back with its Set-Cookie headers, then those of what it
    // set or deleted in `req.cookies`. The page's socket only fails; the cookies go to the jar all the same.
    if (!ws) toJar([...(res instanceof Response ? res.headers.getSetCookie() : []), ...setCookies]);
    if (!ws && res instanceof Response) status = res.status;
  } catch (err) {
    console.error(err);
  }
  upgrades.delete(req);
  if (!ws) {
    port.postMessage({ type: "close", code: 1006, reason: "", status });
    return port.close();
  }
  const socket = ws;
  port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "close") {
      if (socket.readyState !== 1) return;
      port.postMessage({ type: "close", code: m.code, reason: m.reason });
      socket.closed(m.code, m.reason);
    } else if (m.type === "message" && socket.readyState === 1) {
      const data = typeof m.data === "string" ? m.data : (builtins.buffer as { Buffer: { from(b: ArrayBuffer): Uint8Array } }).Buffer.from(m.data);
      inst.websocket.message?.(socket, data);
    }
  };
  const protocol = headers.find(([k]) => k === "sec-websocket-protocol")?.[1].split(",")[0].trim();
  port.postMessage({ type: "open", protocol });
  inst.websocket.open?.(socket);
}

const isHtmlImport = (v: unknown): v is HtmlImport => typeof v === "object" && v !== null && "__htmlImport" in v;

/** `Bun.serve` route patterns: exact paths, `:param` segments, trailing `*`. */
function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const u = path.split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") return params;
    if (i >= u.length) return null;
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(u[i]);
    else if (p[i] !== u[i]) return null;
  }
  return p.length === u.length ? params : null;
}

/**
 * An HTML import served the way Bun's dev server serves it, minus bundling: local `<script src>` and
 * `<link href>` point at the module server, which transpiles them and resolves their imports.
 */
async function serveHtml(imp: HtmlImport): Promise<Response> {
  const dir = dirname(imp.__htmlImport);
  const html = vfs.readText(imp.__htmlImport) ?? "";
  const out = html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=)(["'])([^"']+)\2/gi, (m, pre: string, q: string, ref: string) =>
    /^(https?:|data:|\/\/|#)/.test(ref) ? m : `${pre}${q}${BASE}__vfs/${norm(ref.startsWith("/") ? ref : `${dir}/${ref}`)}${q}`,
  );
  return new Response(out, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Where bundled HTML imports serve their chunks and assets from (Bun's dev server uses the same prefix). */
const ASSET_PREFIX = "/_bun/";
type Asset = { body: string | Uint8Array<ArrayBuffer>; type: string };
type HtmlBundle = { html: string; assets: Map<string, Asset> } | null;
/** Bundles per HTML file; any VFS change drops them all, so the next request bundles again. */
const htmlBundles = new Map<string, Promise<HtmlBundle>>();
/** Served files of the current bundles, by URL path. */
const bundledAssets = new Map<string, Asset>();
vfs.onChange(() => {
  htmlBundles.clear();
  bundledAssets.clear();
});

/**
 * bunfig.toml's `[serve.static] plugins` (in the working directory), loaded: the plugins Bun's dev server and
 * `Bun.serve`'s HTML imports bundle with. Their `setup` runs for each bundle, as `Bun.build`'s plugins' do.
 */
async function staticPlugins(): Promise<unknown[] | undefined> {
  const dir = norm(process.cwd());
  const text = vfs.readText(dir ? `${dir}/bunfig.toml` : "bunfig.toml");
  if (text === undefined) return;
  const list = ((parseData(text, "toml") as { serve?: { static?: { plugins?: unknown } } } | null)?.serve?.static?.plugins ?? []) as unknown;
  const specs = typeof list === "string" ? [list] : Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  const out: unknown[] = [];
  for (const spec of specs) out.push(((await importUrl(`${VFS_ROOT}${resolvePreload(spec)}`)) as { default?: unknown }).default);
  return out;
}

/**
 * Bundles an HTML import with Bun's bundler (browser target, scripts and stylesheets become hashed chunks under
 * ASSET_PREFIX). Null when bundling fails; the errors go to the console.
 */
function bundleHtml(imp: HtmlImport): Promise<HtmlBundle> {
  let p = htmlBundles.get(imp.__htmlImport);
  if (p) return p;
  p = (async (): Promise<HtmlBundle> => {
    const plugins = await BuildPlugins.setup(await staticPlugins(), { entrypoints: [imp.__htmlImport], target: "browser" });
    const res = await bundle(vfs, { cwd: "/", entryPoints: ["/" + norm(imp.__htmlImport)], target: "browser", format: "esm", outdir: "/__bundle", publicPath: ASSET_PREFIX, sourcemap: "inline", minify: false }, plugins);
    for (const l of res.logs) if (l.level === "error" || l.level === "warning") console[l.level === "error" ? "error" : "warn"](`[bundler] ${formatLog(l)}`);
    const page = res.outputs.find((o) => o.loader === "html");
    await plugins?.end({ success: res.success, outputs: [], logs: [] });
    if (!res.success || !page) return null;
    const assets = new Map<string, Asset>();
    for (const o of res.outputs) {
      if (o === page) continue;
      const rel = o.path.replace(/^\.\//, "");
      assets.set(ASSET_PREFIX + rel, { body: o.contents, type: mimeOf(rel) });
    }
    return { html: page.contents as string, assets };
  })().catch((e) => {
    console.error("[bundler]", e);
    return null;
  });
  htmlBundles.set(imp.__htmlImport, p);
  p.then((b) => {
    // Only while this bundle is still the current one (an edit may have cleared the cache meanwhile).
    if (b && htmlBundles.get(imp.__htmlImport) === p) for (const [k, v] of b.assets) bundledAssets.set(k, v);
  });
  return p;
}

async function serveBundledHtml(imp: HtmlImport): Promise<Response> {
  const b = await bundleHtml(imp);
  if (!b) return serveHtml(imp);
  return new Response(b.html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * A preview response goes back as it's produced (SSE, streamed HTML): `head`, then a `chunk` per piece of the body,
 * then `end`, or `error` if the body fails. A `cancel` from the other end (the page went away) cancels the body.
 */
async function sendResponse(port: MessagePort, res: Response, setCookies: string[] = [], head = false) {
  port.postMessage({ type: "head", status: res.status, statusText: res.statusText, headers: servedHeaders(res, setCookies, head) });
  if (!res.body) return port.postMessage({ type: "end" });
  const reader = res.body.getReader();
  port.onmessage = (e) => {
    if (e.data?.type === "cancel") reader.cancel().catch(() => {});
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const data = (value as Uint8Array).slice().buffer;
      port.postMessage({ type: "chunk", data }, [data]);
    }
    port.postMessage({ type: "end" });
  } catch (err) {
    port.postMessage({ type: "error", message: fmt(err) });
  }
  port.onmessage = null;
}

const sendText = (port: MessagePort, status: number, text: string) => sendResponse(port, new Response(text, { status, headers: { "content-type": "text/plain" } }));

/** The `req.cookies` of a request a route handler got, once it has read them. */
const requestCookies = new WeakMap<Request, CookieMap>();

/**
 * A route handler's request (Bun's BunRequest): `params`, and `cookies`, a CookieMap over its Cookie header made on
 * first use. A `fetch` handler's request has neither, as in Bun.
 */
function routeRequest(req: Request, params: Record<string, string>) {
  Object.defineProperties(req, {
    params: { value: params, writable: true, enumerable: true, configurable: true },
    cookies: {
      get() {
        let map = requestCookies.get(req);
        if (!map) requestCookies.set(req, (map = new CookieMap(req.headers.get("cookie") ?? "")));
        return map;
      },
      enumerable: true,
      configurable: true,
    },
  });
  return req;
}

/**
 * Answers `req`, with the Set-Cookie headers for what a route handler set or deleted in `req.cookies` by the time it
 * returned (Bun sends them after the response's own, and leaves the Response object itself alone).
 */
async function dispatch(inst: Instance, req: Request, bodySize?: number): Promise<{ res: Response; setCookies: string[] }> {
  if (!inst.unix && !peers.has(req)) peers.set(req, localPeer(new URL(req.url).hostname));
  let res: unknown;
  // A body over `maxRequestBodySize` (its size known: the preview's, a loopback fetch's) never reaches the handler.
  if (bodySize !== undefined && bodySize > inst.maxBody) res = new Response(null, { status: 413, headers: { connection: "close" } });
  else
    try {
      res = await route(inst, req);
    } catch (err) {
      res = await failed(inst, req, err);
    }
  if (!(res instanceof Response)) res = notAResponse(inst, req, res);
  return { res: res as Response, setCookies: requestCookies.get(req)?.toSetCookieHeaders() ?? [] };
}

/**
 * A handler threw or rejected: Bun's `error` handler answers, as `this` the server. If there is none, it throws, or
 * it returns something other than a Response, the error (its own, if it threw) is logged and Bun's default answers:
 * in development, an HTML error page, after `GET - /path failed`; otherwise "Something went wrong!".
 */
async function failed(inst: Instance, req: Request, err: unknown): Promise<Response> {
  if (err === EXIT || halted) throw err;
  let logged = err;
  if (inst.error)
    try {
      const res = await runIn<unknown>(inst.context, inst.error, inst.server, [err]);
      if (res instanceof Response) return res;
    } catch (e) {
      if (e === EXIT || halted) throw e;
      logged = e;
    }
  if (!inst.development) {
    printError(logged);
    return new Response("Something went wrong!", { status: 500, headers: { "content-type": "text/plain" } });
  }
  post({ type: "console", level: "error", text: `${uncaughtText(logged)}${req.method} - ${new URL(req.url).pathname} failed` });
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(
    `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Internal Server Error</title>\n  </head>\n  <body>\n    <pre>${esc(fmt(logged))}</pre>\n  </body>\n</html>\n`,
    { status: 500, headers: { "content-type": "text/html;charset=utf-8" } },
  );
}

/** A handler returned something other than a Response (and didn't upgrade): Bun logs it, then answers anyway. */
function notAResponse(inst: Instance, req: Request, value: unknown): Response {
  if (upgraded.has(req)) return new Response(null);
  const shown = typeof value === "string" ? JSON.stringify(value) : bunInspect(value);
  post({ type: "console", level: "error", text: `error: Expected a Response object, but received '${shown}'` });
  return inst.development ? new Response("Welcome to Bun! To get started, return a Response object.") : new Response(null, { status: 204 });
}

async function route(inst: Instance, req: Request): Promise<Response> {
  const { routes, handler, server, context } = inst;
  const call = (fn: (...a: any[]) => Response | Promise<Response>, ...args: unknown[]) => runIn<Response | Promise<Response>>(context, fn, undefined, args);
  const path = new URL(req.url).pathname;
  const asset = bundledAssets.get(path);
  if (asset && (req.method === "GET" || req.method === "HEAD")) return new Response(asset.body, { headers: { "content-type": asset.type } });
  for (const [pattern, value] of Object.entries(routes)) {
    const params = matchRoute(pattern, path);
    if (!params) continue;
    if (value instanceof Response) return value.clone();
    if (isHtmlImport(value)) return serveBundledHtml(value);
    if (typeof value === "function") return call(value, routeRequest(req, params), server);
    // A HEAD to a route with only GET gets GET's response, without its body (as Bun answers it).
    const byMethod = value[req.method] ?? (req.method === "HEAD" ? value.GET : undefined);
    if (byMethod) return byMethod instanceof Response ? byMethod.clone() : call(byMethod, routeRequest(req, params), server);
  }
  if (handler) return call(handler, req, server);
  return new Response("Not Found", { status: 404 });
}
const fmt = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? String(v);
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
};

// A served module's URL in a stack frame reads as its project path, and its line and column the file's, as in Bun.
installConsole(
  (level, text) => post({ type: "console", level, text }),
  frameMapper(() => new URL(VFS_ROOT, location.href).href),
  previewSource((path) => vfs.readText(path)),
);
// Bun's console is an AsyncIterable of stdin's lines.
Object.defineProperty(console, Symbol.asyncIterator, { value: consoleLines, configurable: true, writable: true });
// error.stack itself, as Bun's reads (V8 only).
installStackTraces(() => new URL(VFS_ROOT, location.href).href, (path) => vfs.readText(path));
// Instrumented modules served to a process that isn't the debug run (a child process during one) find a __dbg too.
installNoopDebugger();

/** How Bun reports an uncaught error or rejection: its error printer for errors, `error: value` and the value otherwise. */
function uncaughtText(v: unknown): string {
  if (v instanceof Error || (Error as { isError?: (v: unknown) => boolean }).isError?.(v)) return formatValues([v], "error");
  const primitive = v === null || (typeof v !== "object" && typeof v !== "function");
  let head = "error";
  if (primitive)
    try {
      head = `error: ${String(v)}`;
    } catch {}
  return `${head}\n${formatValues([v], "error")}\n`;
}

const PLATFORMS: Record<string, string> = { linux: "Linux", darwin: "macOS", win32: "Windows" };
const versionLine = () => `Bun v${(g.Bun as { version: string }).version} (${PLATFORMS[process.platform] ?? process.platform} ${process.arch})`;
/** An uncaught error as Bun prints it when it isn't ending the program (`bun test`): the error, then Bun's version line. */
const reportUncaught = (v: unknown) => post({ type: "console", level: "error", text: `${uncaughtText(v)}\n${versionLine()}` });

/** True while `bun test` runs: an uncaught error fails the test running now (or is reported), and the run goes on. */
let testing = false;
/** The `exit` listeners ran; the worker is waiting to be terminated. */
let exitEmitted = false;
let halted = false;

const printError = (err: unknown) => post({ type: "console", level: "error", text: uncaughtText(err).replace(/\n$/, "") });

/** Runs the `exit` listeners, once, with `code` (as `process.exitCode` too, unless `setCode` is false). */
function emitExit(code: number, setCode = true) {
  if (exitEmitted) return;
  exitEmitted = true;
  if (setCode) process.exitCode = code;
  try {
    process.emit("exit", code);
  } catch (err) {
    printError(err);
  }
}

/** `process.exit(code)`: the `exit` listeners, then the end of the program. */
function exit(code: number): never {
  emitExit(code);
  return halt(code);
}

/**
 * Ends the program: open databases are written back and the page terminates the worker (runner.ts). Nothing runs
 * after it, as nothing runs after Bun's `process.exit`: the worker blocks until then.
 */
function halt(code: number, signal?: string): never {
  if (!halted) {
    halted = true;
    try {
      flushDatabases();
      flushSql();
    } catch (err) {
      post({ type: "console", level: "error", text: fmt(err) });
    }
    threadEnd();
    post({ type: "exit", code, signal });
  }
  if (typeof SharedArrayBuffer === "function") for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  // Without shared memory (a page that isn't cross-origin isolated): no further task runs, and the throw ends this one.
  selfClose();
  throw EXIT;
}
/**
 * `bun test` as a child process (processes.ts launchOf): the test files under `cwd` (or the ones `filters` name: a path,
 * or part of one), run as the console's `bun test` runs them, with the report as Bun writes it to a pipe: the version
 * line on stdout, the rest on stderr, without colors. It exits with 1 when a test failed.
 */
async function runChildTests(filters: string[], flags: string[], cwd: string) {
  const enc = new TextEncoder();
  const write = (fd: 1 | 2, text: string) => {
    const data = enc.encode(text);
    post({ type: "stdio", fd, data }, [data.buffer]);
  };
  // The flags as the console's `bun test` takes them (processes.ts passes on a command line it rejects, for this).
  const split = splitTestArgs([...flags, ...filters]);
  let options: TestOptions;
  try {
    if (split.error !== undefined) throw new Error(split.error.replace(/^error: /, ""));
    ({ filters, flags } = split);
    options = testOptions(flags);
  } catch (err) {
    write(2, `error: ${err instanceof Error ? err.message : String(err)}\n`);
    return exit(1);
  }
  const GLYPHS: Record<string, string> = { "✓": "(pass)", "✗": "(fail)", "»": "(skip)", "✎": "(todo)" };
  // eslint-disable-next-line no-control-regex
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/^([✓✗»✎]) (.*?)( \[todo\])?$/gm, (_, g: string, rest: string) => `${GLYPHS[g]} ${rest}`);
  setReport({
    log: (text) => write(/^bun test v/.test(text) ? 1 : 2, `${plain(text)}\n`),
    error: (text) => write(2, `${plain(text)}\n`),
  });
  const root = cwd.replace(/^\/+|\/+$/g, "");
  const project = (p: string) => (p.startsWith("/") ? p : `${cwd}/${p}`).split("/").reduce<string[]>((out, s) => (s === ".." ? out.slice(0, -1) : s && s !== "." ? [...out, s] : out), []).join("/");
  const all = [...vfs.files.keys()].filter((f) => (!root || f.startsWith(`${root}/`)) && isTestFile(f));
  const files = new Set<string>();
  for (const f of filters) {
    const exact = project(f);
    if (/^\.{0,2}\//.test(f) && vfs.files.has(exact)) files.add(exact);
    else for (const t of all) if (t.includes(f)) files.add(t);
  }
  if (!filters.length) for (const t of all) files.add(t);
  if (!files.size) {
    write(2, `error: No tests found${filters.length ? ` matching ${filters.join(", ")}` : ""}!\n`);
    return exit(1);
  }
  // `--coverage` (bunfig.toml's too): the page serves the project's files with counters while this process runs
  // (runner.ts spawn); the table goes to stderr.
  let finish: (() => boolean) | undefined;
  try {
    finish = await testCoverage(flags, (table) => write(2, `${plain(table)}\n`));
  } catch (err) {
    write(2, `error: ${err instanceof Error ? err.message : String(err)}\n`);
    return exit(1);
  }
  testing = true;
  const { failed, coverageFailed } = await runTestFiles([...files].sort(), (f) => importUrl(`${VFS_ROOT}${f}`), (g.Bun as { version: string }).version, {
    ...options,
    preload: () => bunfigPreloads(true),
    coverage: finish,
    // Named as Bun does for a child: relative to its working directory.
    label: (f) => (root && f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f),
  }).catch((err) => (write(2, `${fmt(err)}\n`), { failed: 1, coverageFailed: undefined }));
  testing = false;
  exit(failed || coverageFailed ? 1 : 0);
}

/** What `halt` throws where it can't block; the error handlers ignore it. */
const EXIT = Symbol("exit");

/**
 * An uncaught error or unhandled rejection. `process.on("uncaughtException")`/`("unhandledRejection")` listeners get
 * it, with `detail` (the origin, or the rejected promise), if there are any; one that throws ends the program with
 * code 7, as in Bun. Otherwise it ends the program with code 1, printed as Bun prints it: the error, what `exit`
 * listeners print, a blank line and Bun's version line.
 */
function uncaught(v: unknown, kind: "uncaughtException" | "unhandledRejection", detail: unknown = kind) {
  if (v === EXIT || halted) return;
  if (testing) return void (failRunning(v) || reportUncaught(v));
  if (process.listenerCount(kind) > 0) {
    try {
      process.emit(kind, v, detail);
      return;
    } catch (err) {
      if (err === EXIT) return;
      printError(err);
      exit(7);
    }
  }
  // In a thread it is the Worker's "error" event instead, not printed.
  if (threadError(v)) {
    emitExit(1);
    halt(1);
  }
  printError(v);
  // Bun's `exit` listeners get 1 for an uncaught error, but `process.exitCode` (0 when unset) for a rejection.
  if (kind === "unhandledRejection") emitExit(Number(process.exitCode ?? 0) | 0, false);
  else emitExit(1);
  post({ type: "console", level: "error", text: `\n${versionLine()}` });
  halt(1);
}

/**
 * The program ran out of work (loop.ts): `beforeExit` listeners run with `process.exitCode`, and the program goes on if
 * they started something (it comes back here once that's done). Otherwise it ends as with `process.exit()`.
 */
function drained() {
  if (halted) return;
  const before = currentGeneration();
  try {
    process.emit("beforeExit", Number(process.exitCode ?? 0) | 0);
  } catch (err) {
    uncaught(err, "uncaughtException");
  }
  if (halted || currentGeneration() !== before) return;
  exit(Number(process.exitCode ?? 0) | 0);
}


/**
 * `Bun.file`: a Blob over a project file. Reads go to the VFS each time, as Bun's are lazy; the Blob's own bytes
 * are the file when it was created, which is what `new Response(file)` and other native consumers send.
 */
class BunFile extends Blob {
  readonly name: string;
  /** Its path, for Bun.$ (`> ${Bun.file("out.txt")}` writes the file). */
  get [FILE_PATH]() {
    return "/" + this.name;
  }
  readonly #start: number;
  readonly #end: number | undefined;
  /** The path as given, which Bun's errors name. */
  readonly #given: string;
  /** The path as given (a `file:` URL's path), which Bun names the file by in a FormData. */
  static givenPath(f: BunFile) {
    return f.#given;
  }
  constructor(path: string, type?: string, start = 0, end?: number) {
    const name = norm(nodePath.resolve(path));
    const data = vfs.readBytes(name);
    super(data ? [data.slice(start, end)] : [], { type: type ?? (mimeOf(name) || "application/octet-stream") });
    this.name = name;
    this.#start = start;
    this.#end = end;
    this.#given = path;
  }
  get size() {
    const d = vfs.readBytes(this.name);
    return d ? Math.max(0, Math.min(this.#end ?? d.length, d.length) - this.#start) : 0;
  }
  get lastModified() {
    return vfs.mtimes.get(this.name) ?? Date.now();
  }
  // Bun's reads settle a tick later (exists() before it returns): their promises show their state in console.log.
  exists() {
    return fulfilled(vfs.files.has(this.name));
  }
  #read() {
    const d = vfs.readBytes(this.name);
    if (d === undefined) throw asyncError(fsError("ENOENT", "open", this.#given));
    return d.slice(this.#start, this.#end);
  }
  bytes() {
    return tracked((async () => this.#read())());
  }
  arrayBuffer() {
    return tracked((async () => this.#read().buffer as ArrayBuffer)());
  }
  text() {
    return tracked((async () => new TextDecoder().decode(this.#read()))());
  }
  json() {
    return tracked((async () => JSON.parse(new TextDecoder().decode(this.#read())))());
  }
  stream() {
    try {
      return new Blob([this.#read()]).stream();
    } catch (err) {
      return new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (c) => c.error(err) });
    }
  }
  slice(start?: number | string, end?: number | string, type?: string): BunFile {
    if (typeof start === "string") [start, type] = [undefined, start];
    if (typeof end === "string") [end, type] = [undefined, end];
    const size = this.size;
    const at = (i: number | undefined, dflt: number) => (i === undefined ? dflt : i < 0 ? Math.max(size + i, 0) : Math.min(i, size));
    const from = at(start, 0);
    const to = Math.max(at(end, size), from);
    return new BunFile("/" + this.name, type ?? "", this.#start + from, this.#start + to);
  }
  write(data: unknown) {
    return tracked(writeFile(this, data));
  }
  delete() {
    return tracked((async () => (builtins.fs as { rmSync(p: string): void }).rmSync("/" + this.name))());
  }
  async unlink() {
    return this.delete();
  }
  /** `FileSink`: buffers writes and saves them on `flush`/`end`, replacing the file. */
  writer() {
    // Bun.stdout and Bun.stderr: onto the console, flushed as Bun does (fileSink.ts).
    if (this === stdout || this === stderr) return new FileSink((b) => void (this === stdout ? process.stdout : process.stderr).write(b));
    const parts: Uint8Array[] = [];
    let written = 0;
    const flush = async () => {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let o = 0;
      for (const p of parts) all.set(p, (o += p.byteLength) - p.byteLength);
      await writeFile(this, all);
      return all.byteLength;
    };
    return {
      write(chunk: string | ArrayBuffer | ArrayBufferView) {
        const b = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
        parts.push(b);
        written += b.byteLength;
        return b.byteLength;
      },
      flush,
      end: flush,
      ref() {},
      unref() {},
      start() {},
      get written() {
        return written;
      },
    };
  }
}

// A Bun.file in a FormData is a File named by its path, as in Bun (a browser names a Blob "blob").
for (const key of ["append", "set"] as const) {
  const method = FormData.prototype[key] as (this: FormData, name: string, value: string | Blob, filename?: string) => void;
  FormData.prototype[key] = function (this: FormData, name: string, value: string | Blob, filename?: string) {
    if (filename === undefined && value instanceof BunFile) filename = BunFile.givenPath(value);
    // Two arguments for a string: a third, even undefined, makes it the Blob overload.
    return arguments.length < 3 && filename === undefined ? method.call(this, name, value) : method.call(this, name, value, filename);
  } as never;
}

/**
 * A file part's type in a parsed multipart body, as Bun gives it: from its file name's extension (Bun's table), not
 * from the part's Content-Type (`a.txt` is `text/plain;charset=utf-8`); "" when there is none.
 */
const partType = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot > name.lastIndexOf("/") ? (MIME[name.slice(dot + 1).toLowerCase()] ?? "") : "";
};
for (const proto of [NativeResponse.prototype, Request.prototype]) {
  const parse = proto.formData as (this: Body) => Promise<FormData>;
  proto.formData = async function formData(this: Body) {
    const parsed = await parse.call(this);
    const out = new FormData();
    for (const [k, v] of parsed) out.append(k, typeof v === "string" ? v : new File([v], v.name, { type: partType(v.name), lastModified: v.lastModified }));
    return out;
  };
}

/** `Bun.S3Client`, `Bun.s3` and `s3://` URLs (s3.ts), on the worker's env and its (tracked) fetch. */
const s3 = createS3({ env: () => env, fetch: () => globalThis.fetch, track: tracked });
type S3File = InstanceType<typeof s3.S3File>;

/** `Bun.stdout`/`Bun.stderr`: write targets that go to the console pane. */
const stdout = new BunFile("/dev/stdout");
const stderr = new BunFile("/dev/stderr");

/** What `Bun.write` writes without reading first: a string, or the bytes of a buffer or view (else undefined). */
function directData(data: unknown): string | Uint8Array | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

async function writeFile(dest: string | URL | BunFile, data: unknown): Promise<number> {
  let out = directData(data);
  if (out === undefined) {
    if (data instanceof BunFile) out = await data.bytes();
    else if (data instanceof Blob || data instanceof Response) out = new Uint8Array(await data.arrayBuffer());
    else out = String(data);
  }
  return writeOut(dest, out);
}

function writeOut(dest: string | URL | BunFile, out: string | Uint8Array): number {
  const size = typeof out === "string" ? new TextEncoder().encode(out).length : out.byteLength;
  if (dest === stdout || dest === stderr) {
    (dest === stdout ? process.stdout : process.stderr).write(out);
    return size;
  }
  const path = dest instanceof BunFile ? dest.name : dest instanceof URL ? decodeURIComponent(dest.pathname) : dest;
  const file = "/" + norm(nodePath.resolve(path));
  const fs = builtins.fs as { mkdirSync(p: string, o: object): void; writeFileSync(p: string, d: string | Uint8Array): void };
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return size;
}

type BuildArtifact = Blob & { path: string; kind: "entry-point" | "chunk" | "asset" | "sourcemap"; loader: string; hash: string | null; sourcemap: BuildArtifact | null };
/** Bun's Blobs have `json()` and `bytes()`; the browser's may not. */
class ArtifactBlob extends Blob {
  async json() {
    return JSON.parse(await this.text());
  }
  async bytes() {
    return new Uint8Array(await this.arrayBuffer());
  }
}
type BuildOptions = {
  entrypoints: string[];
  outdir?: string;
  target?: "browser" | "bun" | "node";
  format?: "esm" | "cjs" | "iife";
  minify?: boolean | { whitespace?: boolean; syntax?: boolean; identifiers?: boolean };
  splitting?: boolean;
  sourcemap?: boolean | "none" | "inline" | "external" | "linked";
  naming?: string | { entry?: string; chunk?: string; asset?: string };
  publicPath?: string;
  external?: string[];
  define?: Record<string, string>;
  conditions?: string[] | string;
  banner?: string;
  footer?: string;
  /** File extension (with the dot) to loader: `{ ".txt": "text" }`. */
  loader?: Record<string, string>;
  /** `true`/`"inline"` inlines every variable, `"PUBLIC_*"` those with the prefix, `false`/`"disable"` none. */
  env?: boolean | number | null | "inline" | "disable" | `${string}*`;
  packages?: "bundle" | "external";
  drop?: string[];
  root?: string;
  plugins?: unknown[];
  throw?: boolean;
};

const buildLog = (l: BundleLog) =>
  Object.assign(new Error(l.message), { name: "BuildMessage", level: l.level, message: l.message, position: l.file ? { file: l.file, line: l.line, column: l.column } : null });
const formatLog = (l: BundleLog) => `${l.level}: ${l.message}${l.file ? `\n    at ${l.file}:${l.line}:${l.column}` : ""}`;

/** `Bun.build`'s `env` as the bundler takes it, with the worker's `process.env` as the variables it reads. */
function buildEnv(e: BuildOptions["env"]): Pick<BundleConfig, "env" | "envVars"> {
  if (e === undefined || e === null || e === false || e === 0 || e === "disable") return {};
  if (e === true || e === 1 || e === "inline") return { env: "inline", envVars: env };
  if (typeof e === "string" && e.includes("*")) return { env: e, envVars: env };
  throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "env must be 'inline', 'disable', or a string with a '*' character");
}

/**
 * `Bun.build`'s naming as `JSBundler.Config` reads it: chunks are `chunk-[hash]` (the CLI's, the bundler's default
 * here, are `[name]-[hash]`) and given templates get a leading `./` (it goes into the outputs' hashes).
 */
function buildNaming(naming: BuildOptions["naming"]): BundleConfig["naming"] {
  const dot = (t: string | undefined) => (t === undefined || t.startsWith("./") ? t : `./${t}`);
  const n = typeof naming === "string" ? { entry: naming } : (naming ?? {});
  return { entry: dot(n.entry), chunk: dot(n.chunk) ?? "./chunk-[hash].[ext]", asset: dot(n.asset) };
}

/**
 * `Bun.build` through Bun's own bundler (compiled to wasm, see bundler.ts). Outputs are Blobs in memory; with
 * `outdir` they are also written to the VFS through `write`, so the page sees them. Failures throw an
 * AggregateError of the logs, as in Bun, unless `throw: false`.
 */
async function build(opts: BuildOptions) {
  // As Bun's `Config::from_js`: the plugins' `setup` runs first and may change the options it reads after.
  const plugins = await BuildPlugins.setup(opts.plugins, opts as Record<string, unknown>);
  for (const ext of Object.keys(opts.loader ?? {}))
    if (ext.length < 2 || !ext.startsWith(".")) throw new TypeError("loader property names must be file extensions, such as '.txt'");
  const entryPoints = (opts.entrypoints ?? []).map((e) => "/" + norm(nodePath.resolve(e.startsWith("file:") ? new URL(e).pathname : e)));
  const sm = opts.sourcemap;
  const config: BundleConfig = {
    cwd: "/",
    entryPoints,
    target: opts.target,
    format: opts.format,
    minify: opts.minify,
    splitting: opts.splitting,
    external: opts.external,
    define: opts.define,
    conditions: typeof opts.conditions === "string" ? [opts.conditions] : opts.conditions,
    sourcemap: sm === true ? "linked" : sm === false ? "none" : sm,
    naming: buildNaming(opts.naming),
    publicPath: opts.publicPath,
    banner: opts.banner,
    footer: opts.footer,
    loader: opts.loader,
    packages: opts.packages,
    drop: opts.drop,
    rootDir: opts.root === undefined ? undefined : "/" + norm(nodePath.resolve(opts.root)),
    ...buildEnv(opts.env),
  };
  const outdir = opts.outdir ? "/" + norm(nodePath.resolve(opts.outdir)) : undefined;
  if (outdir) config.outdir = outdir;
  const res = await bundle(vfs, config, plugins);
  const logs = res.logs.map(buildLog);
  if (!res.success) {
    const result = { success: false, outputs: [] as BuildArtifact[], logs };
    await plugins?.end(result);
    if (opts.throw === false) return result;
    throw Object.assign(new AggregateError(logs, "Bundle failed"), { name: "AggregateError" });
  }
  const outputs: BuildArtifact[] = [];
  for (const o of res.outputs) {
    const rel = o.path.replace(/^\.\//, "");
    const blob = new ArtifactBlob([o.contents], { type: mimeOf(rel) });
    const path = outdir ? nodePath.join(outdir, rel) : `./${rel}`;
    outputs.push(Object.assign(blob, { path, kind: o.kind as BuildArtifact["kind"], loader: o.inputLoader, hash: o.hash && o.hash !== "0" ? o.hash : null, sourcemap: null as BuildArtifact | null }));
  }
  for (const o of outputs) o.sourcemap = outputs.find((m) => m.kind === "sourcemap" && m.path === `${o.path}.map`) ?? null;
  if (outdir) for (const o of outputs) await writeFile(o.path, o);
  const result = { success: true, outputs, logs };
  await plugins?.end(result);
  return result;
}

/**
 * Bun's fetch reads `file:` URLs from disk; here, from the VFS (napi-rs wasm bindings fetch their .wasm this way).
 * A relative URL is invalid, as in Bun: the worker's own URL would make it a request to the playground.
 */
const networkFetch = globalThis.fetch;
const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const fileFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!URL.canParse(url)) throw Object.assign(new TypeError("fetch() URL is invalid"), { code: "ERR_INVALID_URL" });
  if (url.startsWith("s3:")) return s3.fetchUrl(url, init);
  // Bun's `unix` option: the request goes to the server on that socket path, whatever the URL's host.
  const unix = (init as { unix?: string } | undefined)?.unix;
  if (unix) {
    const inst = servers.find((s) => s.unix === unix);
    if (!inst) throw codeError(TypeError, "ENOENT", "ENOENT: Was there a typo in the url or port?");
    return loopbackFetch(inst, new Request(input, init));
  }
  if (!url.startsWith("file:")) {
    // A server this program started (Bun.serve, http.createServer) is answered in-process, as on a machine where
    // localhost reaches it; the browser's network can't. A child process's server lives in another worker: unreachable.
    const inst = ownServer(url);
    if (inst) return loopbackFetch(inst, new Request(input, init));
    return networkFetch(input, withHeaders(input, init));
  }
  const path = norm(decodeURIComponent(new URL(url).pathname));
  const data = vfs.readBytes(path);
  if (data === undefined) throw new TypeError(`fetch failed: no such file /${path}`);
  return new Response(data.slice());
};

/** The server of this program that `url` reaches on localhost, if any. */
function ownServer(url: string | URL): Instance | undefined {
  const u = new URL(url);
  return loopback.has(u.hostname) && u.protocol === "http:" ? servers.find((s) => s.port === Number(u.port || 80)) : undefined;
}

/** Bun follows 126 redirects; the 127th fails. */
const MAX_REDIRECTS = 126;
const fetchError = (code: string, message: string) => Object.assign(new TypeError(`${message}. For more information, pass \`verbose: true\` in the second argument to fetch()`), { code });

const macrotask = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => (ch.port1.close(), resolve());
    ch.port2.postMessage(0);
  });
const connectionReset = () => fetchError("ECONNRESET", "ECONNRESET: The socket connection was closed unexpectedly");

/**
 * A response body as a client of Bun.serve gets it. Bun sends the head with the first chunk, and what the stream has
 * ready without waiting along with it: a stream that fails before then drops the connection (fetch rejects), one that
 * fails later ends the body with the same error. A stream that ended by then has its length sent too, as Bun does.
 */
async function eagerBody(stream: ReadableStream<Uint8Array>): Promise<{ body: ReadableStream<Uint8Array>; length?: number }> {
  const reader = stream.getReader();
  const ready: Uint8Array[] = [];
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let done = false;
  try {
    for (let r = await reader.read(); ; ) {
      if (r.done) {
        done = true;
        break;
      }
      ready.push(r.value);
      const next = reader.read();
      const settled = await Promise.race([next, macrotask()]);
      if (!settled) {
        pending = next;
        // Read later; until then a failure is this one's to report.
        next.catch(() => {});
        break;
      }
      r = settled;
    }
  } catch {
    throw connectionReset();
  }
  const length = done ? ready.reduce((n, c) => n + c.byteLength, 0) : undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (ready.length) return c.enqueue(ready.shift()!);
      if (done) return c.close();
      try {
        const r = await (pending ?? reader.read());
        pending = undefined;
        if (r.done) c.close();
        else c.enqueue(r.value);
      } catch {
        c.error(connectionReset());
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { body, length };
}

/**
 * A request to a server of this program, answered in-process. Redirects are followed as Bun's fetch follows them
 * (`redirect: "follow"`, the default): a 303, and a 301 or 302 to a POST, go on as a GET without the body; the others
 * keep method and body; another origin doesn't get the Authorization and Cookie headers. A hop that leaves the
 * program's servers goes to the network. `"manual"` returns the redirect, `"error"` fails on it.
 */
async function loopbackFetch(inst: Instance, req: Request): Promise<Response> {
  const mode = req.redirect;
  // A 307 or 308 sends the body again: kept from the start, as it is read only once.
  const body = mode === "follow" && req.body ? await req.clone().arrayBuffer() : null;
  for (let hops = 0; ; hops++) {
    const { res, setCookies } = await dispatch(inst, req, req.body ? body?.byteLength : undefined);
    const location = res.headers.get("location");
    if (mode === "manual" || !REDIRECT_STATUS.has(res.status) || location === null) {
      // What a client of Bun.serve gets: its headers (the implicit content-type, Set-Cookie), no body for HEAD.
      const eager = req.method !== "HEAD" && res.body ? await eagerBody(res.body) : undefined;
      const headers = servedHeaders(res, setCookies, req.method === "HEAD");
      if (eager?.length !== undefined && !headers.some(([k]) => k === "content-length")) headers.push(["content-length", String(eager.length)]);
      const out = new Response(eager?.body ?? null, { status: res.status, statusText: res.statusText, headers });
      return Object.defineProperties(out, { url: { value: req.url }, redirected: { value: hops > 0 } });
    }
    res.body?.cancel().catch(() => {});
    if (mode === "error") throw fetchError("UnexpectedRedirect", `UnexpectedRedirect fetching "${req.url}"`);
    if (hops === MAX_REDIRECTS) throw fetchError("TooManyRedirects", "TooManyRedirects: The response redirected too many times");
    const next = new URL(location, req.url);
    const asGet = (res.status === 303 && req.method !== "GET" && req.method !== "HEAD") || ((res.status === 301 || res.status === 302) && req.method === "POST");
    const headers = new Headers(req.headers);
    if (asGet) for (const h of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(h);
    if (next.origin !== new URL(req.url).origin) for (const h of ["authorization", "proxy-authorization", "cookie"]) headers.delete(h);
    const nextInit: RequestInit = { method: asGet ? "GET" : req.method, headers, body: asGet || req.method === "GET" || req.method === "HEAD" ? null : body, redirect: mode, signal: req.signal };
    const nextInst = ownServer(next);
    if (!nextInst) {
      const out = await networkFetch(next, nextInit);
      return Object.defineProperty(out, "redirected", { value: true });
    }
    inst = nextInst;
    req = new Request(next, nextInit);
  }
}
globalThis.fetch = trackedFn(function fetch(input: RequestInfo | URL, init?: RequestInit) {
  return fileFetch(input, init);
}) as typeof fetch;
// undici, node-fetch & co. (node/bunPackages.ts) keep this one even after a program replaces the global.
setBunFetch(globalThis.fetch);

/** The browser's WebSocket client, holding the program while it is connecting or open (loop.ts), as Bun's does. */
if (typeof globalThis.WebSocket === "function") {
  const BrowserWebSocket = class WebSocket extends globalThis.WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      hold(this);
      this.addEventListener("close", () => release(this));
    }
  };
  // `ws://localhost:<port>` to a server of this program connects in-process, as `fetch` does over http.
  globalThis.WebSocket = loopbackWebSocket(BrowserWebSocket, (url) => {
    const inst = ownServer(url.href.replace(/^ws/, "http"));
    return inst && ((headers, port) => void openSocket(inst, port, url.pathname + url.search, headers, url.href));
  });
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
/** `Bun.escapeHTML`: like Bun's, non-strings are stringified first. */
const escapeHTML = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

type Compressible = string | ArrayBuffer | ArrayBufferView;
const compressible = (d: Compressible) =>
  typeof d === "string" ? new TextEncoder().encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
const level = (o?: { level?: number }) => ({ level: (o?.level === undefined || o.level < 0 ? 6 : Math.min(o.level, 9)) as fflate.DeflateOptions["level"] });

/**
 * `Bun.sleepSync`: blocks the worker. `Atomics.wait` on shared memory where the page is cross-origin isolated (as the
 * playground serves it), else a busy loop.
 */
function sleepSync(ms: unknown) {
  if (typeof ms !== "number") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "milliseconds must be a number");
  if (ms < 0) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `argument to sleepSync must not be negative, got ${ms}`);
  if (!(ms > 0)) return;
  if (typeof SharedArrayBuffer === "function") return void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const end = performance.now() + ms;
  while (performance.now() < end);
}

/**
 * The text `Bun.YAML.parse`/`Bun.TOML.parse`/`Bun.JSON5.parse` read: a string, buffer or Blob (read synchronously, as
 * Bun does). YAML takes anything else as its `String()`; TOML and JSON5 only a non-nullish value.
 */
function dataText(v: unknown, format: "yaml" | "toml" | "json5"): string {
  if (typeof v === "string") return v;
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return new TextDecoder().decode(v);
  if (v instanceof Blob) return new (globalThis as unknown as { FileReaderSync: new () => { readAsText(b: Blob): string } }).FileReaderSync().readAsText(v);
  if (format !== "yaml" && v == null) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "input must be a string, ArrayBuffer, ArrayBufferView or Blob");
  return String(v);
}

/** `Bun.JSONC.parse`: like `JSON.parse`, anything but a string (a buffer too) is read as its `String()`, and "" throws. */
function jsoncParse(input: unknown): unknown {
  if (input == null) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "input must be a string");
  const text = String(input);
  if (!text) throw new SyntaxError("JSONC Parse error: Unexpected end of input");
  return parseData(text, "jsonc");
}

/** `Bun.markdown.ansi`'s default background (ansi_renderer.rs `colorfgbg_light`): `COLORFGBG`'s last field is 7 or 15. */
function colorfgbgLight(v: string | undefined): boolean {
  const last = v?.split(";").pop();
  return last === "7" || last === "15";
}

/** Bun's shell over the project's files, as Bun.$ and a shell process (`sh -c`, a package.json script) run it. */
const shellHost = (wasm: Awaited<ReturnType<typeof loadShellWasm>>) => ({
  // Through node:fs, whose writes reach the page's copy of the project (and its file tree).
  fs: shellFs(builtins.fs as never),
  wasm,
  builtins: shellBuiltins,
  external: externalCommand,
});

/**
 * A command that isn't a builtin, as a child process (processes.ts) with the command's stdin, stdout and stderr
 * joined to it; undefined for one that isn't there (`command not found`).
 */
function externalCommand(name: string, cwd: string, PATH?: string): ShellCommand | undefined {
  const launch = launchOf([name], cwd, has, read, PATH, listDirs);
  if ("error" in launch && launch.enoent) return;
  return async (ctx) => {
    let child: Child;
    try {
      child = spawnChild(ctx.argv, { cwd: ctx.shell.cwd, env: ctx.env });
    } catch (err) {
      const e = err as Error & { code?: string };
      await ctx.stderr.write(e.code === "ENOENT" ? `bun: command not found: ${ctx.argv[0]}\n` : `bun: ${e.message}\n`);
      return 1;
    }
    // In order, each after the last: the writers are async.
    let written: Promise<unknown> = Promise.resolve();
    child.onData = (fd, data) => void (written = written.then(() => (fd === 1 ? ctx.stdout : ctx.stderr).write(data)));
    const abort = () => child.kill("SIGKILL");
    ctx.signal.addEventListener("abort", abort, { once: true });
    void (async () => {
      for (let chunk; (chunk = await ctx.stdin.read()) && !child.status; ) child.write(chunk);
      child.end();
    })();
    const status = await child.exited;
    ctx.signal.removeEventListener("abort", abort);
    await written;
    return status.code;
  };
}

/** A signal sent to this program (a parent's kill, process.kill): its listeners get it, else it ends the program. */
function signal(name: string) {
  if (halted) return;
  if (process.listenerCount(name) > 0) {
    try {
      process.emit(name, name);
    } catch (err) {
      uncaught(err, "uncaughtException");
    }
    return;
  }
  // Ended by a signal, `exit` listeners don't run (as in Bun); a shell sees 128 + its number.
  halt(128 + (SIGNALS[name] ?? 15), name);
}

process.kill = (pid: number, sig: string | number = "SIGTERM") => {
  const name = signalName(sig);
  if (!name) throw Object.assign(new TypeError(`Unknown signal: ${sig}`), { code: "ERR_UNKNOWN_SIGNAL" });
  const target = Number(pid);
  if (target === process.pid || target === 0) {
    if (name !== "0") setTimeout(() => signal(name));
    return true;
  }
  const child = childByPid(target);
  if (!child) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH", errno: -3, syscall: "kill" });
  child.kill(name);
  return true;
};

async function main() {
  // Bun's resolver, for `require` and `require.resolve` with a computed specifier (node/module.ts); the page has its own instance.
  // The shell's parser too: `$` parses as it's called, as Bun's does (a syntax error throws there).
  const [semver, shellWasm] = await Promise.all([loadSemver(), loadShellWasm(), loadResolver(vfs)]);
  setRequire(vfs, (spec, dir) => resolve(spec, dir, "require", "bun"), (spec, dir) => resolve(spec, dir, "import", "bun"), () => VFS_ROOT);
  setPluginHost({ vfsRoot: () => VFS_ROOT, resolve: (spec, dir, kind) => resolve(spec, dir, kind, "bun"), cwd: () => process.cwd(), parseData, ...pluginModuleHost() });
  setPluginHook(pluginRequire);
  const bun: Record<(typeof BUN_NAMES)[number], unknown> = {
    version: `${BUN_VERSION}-browser`,
    env,
    gc: () => {},
    main: "",
    argv: process.argv,
    stdout,
    stderr,
    stdin: new StdinFile(),
    inspect: Object.assign(bunInspect, {
      // `Bun.inspect.table(data, properties?, options?)`: console.table's box as a string, nested values collapsed.
      table: (data: unknown, properties?: unknown) => (typeof data === "object" && data !== null ? table(data, Array.isArray(properties) ? properties.map(String) : undefined, 5) + "\n" : ""),
    }),
    deepEquals: (a: unknown, b: unknown, strict = false) => isDeepStrictEqual(a, b, strict),
    escapeHTML,
    which: () => null,
    spawn: bunSpawn,
    spawnSync: bunSpawnSync,
    sleep: trackedFn(function sleep(ms: number) {
      return new Promise<void>((r) => setTimeout(r, ms));
    }),
    sleepSync,
    revision: BUN_REVISION,
    nanoseconds: () => Math.round(performance.now() * 1e6),
    semver: {
      order: semver.order,
      satisfies: semver.satisfies,
    },
    file: (path: string | URL, opts?: { type?: string }) => (typeof path === "string" && path.startsWith("s3://") ? s3.fromUrl(path, opts) : new BunFile(path instanceof URL ? decodeURIComponent(path.pathname) : path, opts?.type)),
    // A string or bytes to a file is written before Bun.write returns, its promise already resolved (as in Bun);
    // anything to read first (a Blob, a Response, another file) settles later, as do errors.
    write(dest: string | URL | BunFile | S3File, data: unknown, options?: unknown) {
      // An S3 file, or an s3:// URL with the options of S3Client#file.
      if (s3.isS3File(dest)) return dest.write(data, options);
      if (typeof dest === "string" && dest.startsWith("s3://")) return s3.fromUrl(dest, options).write(data);
      const out = directData(data);
      if (out !== undefined && dest !== stdout && dest !== stderr)
        try {
          return fulfilled(writeOut(dest, out));
        } catch (e) {
          return tracked(Promise.reject(asyncError(e)));
        }
      return tracked(writeFile(dest, data));
    },
    serve: (opts: ServeOptions) => listen(opts).server,
    build,
    CryptoHasher,
    hash,
    // Bun's deflate is raw (no zlib header), like its inflate.
    gzipSync: (d: Compressible, o?: { level?: number }) => fflate.gzipSync(compressible(d), level(o)),
    gunzipSync: (d: Compressible) => fflate.gunzipSync(compressible(d)),
    deflateSync: (d: Compressible, o?: { level?: number }) => fflate.deflateSync(compressible(d), level(o)),
    inflateSync: (d: Compressible) => fflate.inflateSync(compressible(d)),
    // zstd runs in compress-wasm, instantiated on first use.
    zstdCompressSync: bunZstdCompressSync,
    zstdDecompressSync: bunZstdDecompressSync,
    zstdCompress: trackedFn(bunZstdCompress),
    zstdDecompress: trackedFn(bunZstdDecompress),
    Transpiler,
    resolveSync,
    resolve: async (specifier: string, from: string | URL) => resolveSync(specifier, from),
    Glob,
    FileSystemRouter,
    plugin,
    S3Client: s3.S3Client,
    s3: s3.s3,
    sql,
    SQL,
    // Wrapped so the functions are named `parse`/`stringify`, with Bun's lengths.
    YAML: { parse: (input: unknown) => parseData(dataText(input, "yaml"), "yaml"), stringify: (value: unknown, replacer?: unknown, space?: unknown) => yamlStringify(value, replacer, space) },
    TOML: { parse: (input: unknown) => parseData(dataText(input, "toml"), "toml"), stringify: (value: unknown, replacer?: unknown, _space?: unknown) => tomlStringify(value, replacer) },
    JSONC: { parse: (input: unknown) => jsoncParse(input) },
    JSON5: { parse: (input: unknown) => parseData(dataText(input, "json5"), "json5"), stringify: (value: unknown, replacer?: unknown, space?: unknown) => json5Stringify(value, replacer, space) },
    // Bun's parsers and renderers in transpile-wasm, loaded on first use as Bun.Transpiler's.
    JSONL: makeJSONL(),
    XML: makeXML(() => xmlWasm),
    markdown: makeMarkdown(() => markdownWasm, () => colorfgbgLight(env.COLORFGBG)),
    password,
    Cookie,
    CookieMap,
    randomUUIDv7,
    // Bun's shell with its builtins over the project's files; other commands run as child processes.
    $: createDollar({
      ...shellHost(shellWasm),
      stdout: { write: async (c) => (process.stdout.write(c), true) },
      stderr: { write: async (c) => (process.stderr.write(c), true) },
      cwd: () => process.cwd(),
      env: () => env,
      buffer: (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength),
      home: env.HOME ?? "/",
    }),
  };
  g.Bun = Object.assign(builtins.bun, bun);

  setExit(exit);
  self.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    uncaught(e.reason, "unhandledRejection", e.promise);
  });
  // An exception out of a timer or event callback (the page's worker.onerror would only get its message).
  self.addEventListener("error", (e) => {
    e.preventDefault();
    uncaught(e.error, "uncaughtException");
  });

  self.addEventListener("message", async (e: MessageEvent) => {
    const m = e.data;
    if (m.type === "request") {
      const port = e.ports[0];
      let out: { res: Response; setCookies: string[] };
      const r = m.req;
      try {
        // The page names the port when the server it routes to isn't this program's first (runner.ts route).
        const inst = (m.port !== undefined && servers.find((s) => s.port === m.port)) || previewServer();
        if (!inst) return sendText(port, 503, "No Bun.serve handler registered");
        // A response being made holds the program, even after an unref'd or stopped server.
        out = await holdUntil(dispatch(inst, serverRequest(r.path, { method: r.method, body: r.body }, r.headers), r.body?.byteLength));
      } catch (err) {
        if (halted) return;
        // Bun's development server (`development` is true here) reports it as uncaught, then which request failed.
        post({ type: "console", level: "error", text: `${uncaughtText(err)}${r.method} - ${new URL(r.path, "http://localhost/").pathname} failed` });
        return sendText(port, 500, fmt(err));
      }
      await sendResponse(port, out.res, out.setCookies, r.method === "HEAD");
    } else if (m.type === "ws") {
      const port = e.ports[0];
      const inst = m.port === undefined ? previewServer() : servers.find((s) => s.port === m.port);
      if (!inst) {
        port.postMessage({ type: "close", code: 1006, reason: "" });
        return port.close();
      }
      openSocket(inst, port, m.path, m.headers);
    }
  });

  post({ type: "booted" });
}

const booted = main();
booted.catch(() => {}); // reported to the page once "start" arrives

// The page is about to terminate this worker (Run, Stop, bun test): write open databases back first. Their bytes go
// to the page as "vfs" messages, which arrive before "flushed".
self.addEventListener("message", (e: MessageEvent) => {
  if (e.data?.type !== "flush") return;
  try {
    flushDatabases();
    flushSql();
  } catch (err) {
    post({ type: "console", level: "error", text: fmt(err) });
  }
  post({ type: "flushed" });
});

// Page-side edits made after "start" (editor, file tree, installs). Applied straight to the VFS: only node:fs and
// Bun.write mirror back to the page, so this isn't echoed.
// The same changes made while this program waited on a synchronous child come through its channel instead.
const applyVfs = (m: { op: string; path: string; data?: unknown }) => {
  if (m.op === "write") vfs.write(m.path, m.data as FileData);
  else if (m.op === "mkdir") vfs.mkdir(m.path);
  else if (m.op === "remove") vfs.remove(m.path);
};
setSyncVfs(applyVfs);
self.addEventListener("message", (e: MessageEvent) => {
  if (e.data.type === "vfs") applyVfs(e.data);
});

// The page's reports about this program's children, and what its parent sends it as a child itself. The stdin a
// parent writes (or the console, for the main program) can arrive before "start" is through (it waits for the wasm): it waits in the stream.
self.addEventListener("message", (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "proc") onProcMessage(m);
  else if (m.type === "stdin") pushStdin(m.data);
  else if (m.type === "tty") resizeTTY(m.cols, m.rows);
  else if (m.type === "signal") signal(m.signal);
  else if (m.type === "taken") taken = new Set(m.ports);
});

/** A thread's `eval: true` code: a CommonJS script, as Node runs it, with `require` from the working directory. */
function evalThread(code: string): unknown {
  const filename = nodePath.join(process.cwd(), "[worker eval]");
  const require = (builtins.module as { createRequire(p: string): unknown }).createRequire(filename);
  const module = { exports: {} as unknown };
  new Function("exports", "require", "module", "__filename", "__dirname", code)(module.exports, require, module, filename, process.cwd());
  return module.exports;
}

/** A shell process (`sh -c <line>`, a package.json script): the line in Bun's shell, then its exit code. */
async function runScript(script: string, args: string[], child: boolean) {
  const wasm = await loadShellWasm();
  const source = templateSource([script], []);
  const vars = new Map(Object.entries(env).filter((kv): kv is [string, string] => kv[1] !== undefined));
  // Run from the console (not a child), it has no stdin.
  const iter = child ? stdinStream[Symbol.asyncIterator]() : undefined;
  const stdin: Reader = { read: async () => ((await iter?.next())?.value as Uint8Array | undefined) ?? null, close: () => void iter?.return?.() };
  const out = (w: { write(c: Uint8Array | string): unknown }) => ({ write: async (c: Uint8Array | string) => (w.write(c), true) });
  try {
    const code = await new ShellInterpreter(shellHost(wasm)).run(wasm.parse(source), { stdin, stdout: out(process.stdout), stderr: out(process.stderr) }, new ShellEnv(process.cwd(), new Map(), vars, ["sh", ...args]), source.objs);
    exit(code);
  } catch (err) {
    if (err === EXIT) return;
    process.stderr.write(`bun: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(1);
  }
}

/**
 * The modules bunfig.toml (in the working directory, as Bun reads it) preloads: `preload` for a run, `[test] preload`
 * for `bun test`, a path or a list, each resolved from that directory (a bare name is a package). Their VFS paths;
 * throws Bun's error for one that doesn't resolve.
 */
function bunfigPreloads(test: boolean): string[] {
  return bunfigPreloadSpecs(test).map(resolvePreload);
}

/** What bunfig.toml (in the working directory) lists to preload, as written. */
function bunfigPreloadSpecs(test: boolean): string[] {
  const dir = norm(process.cwd());
  const text = vfs.readText(dir ? `${dir}/bunfig.toml` : "bunfig.toml");
  if (text === undefined) return [];
  const config = parseData(text, "toml") as { preload?: unknown; test?: { preload?: unknown } } | null;
  const list = test ? config?.test?.preload : config?.preload;
  return typeof list === "string" ? [list] : Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
}

/**
 * `bun test --coverage` (the flags, bunfig.toml's `[test]`): the files that load from now on count, and what reports
 * them once the tests are done (whether that fails the run). Undefined without coverage; throws Bun's error for an
 * option it rejects.
 */
async function testCoverage(flags: string[], print: (table: string) => void = (table) => console.error(table)): Promise<(() => boolean) | undefined> {
  const dir = norm(process.cwd());
  const text = vfs.readText(dir ? `${dir}/bunfig.toml` : "bunfig.toml");
  const config = text === undefined ? undefined : (parseData(text, "toml") as { test?: Record<string, unknown> } | null);
  const opts = coverageOptions(flags, config?.test);
  if (!opts.enabled) return undefined;
  await startCoverage(opts);
  const { default: fs } = await import("./node/fs");
  const ignore = opts.ignorePatterns.map((p) => new Glob(p));
  return () =>
    finishCoverage(
      opts,
      dir,
      (path) => ignore.some((p) => p.match(path)),
      print,
      (path, lcov) => {
        fs.mkdirSync(`/${path}`.replace(/\/[^/]*$/, "") || "/", { recursive: true });
        fs.writeFileSync(`/${path}`, lcov);
      },
    );
}

/** A preload's VFS path, resolved from the working directory (a bare name is a package); throws Bun's error if none. */
function resolvePreload(spec: string): string {
  const path = resolve(spec, norm(process.cwd()), "import", "bun");
  if (path === null) throw new Error(`preload not found "${spec}"`);
  return path;
}

/** `bun ./index.html [--port n]`: serves the page (and what it imports) at every path, as Bun's HTML dev server. */
function serveHtmlEntry(entry: string, args: string[]): Record<string, never> {
  const started = performance.now();
  const at = args.findIndex((a) => a === "--port" || a.startsWith("--port="));
  const given = at < 0 ? undefined : args[at]!.includes("=") ? args[at]!.split("=")[1] : args[at + 1];
  const server = listen({ ...(given !== undefined && { port: Number(given) }), development: true, routes: { "/*": { __htmlImport: norm(entry) } } }).server as { url: URL };
  post({ type: "console", level: "log", text: `Bun v${BUN_VERSION} dev server ready in ${(performance.now() - started).toFixed(2)} ms\n\nurl: ${server.url}` });
  return {};
}

self.addEventListener("message", async (e: MessageEvent) => {
  if (e.data.type !== "start") return;
  if (e.data.vfsRoot) VFS_ROOT = e.data.vfsRoot;
  vfs.load(e.data.files, e.data.dirs);
  // A debug run (debugSession.ts): its project files call __dbg before each statement.
  if (e.data.debug) installDebugger(e.data.debug.sab, e.data.debug.breakpoints, post, () => new URL(VFS_ROOT, location.href).href);
  // A worker that can't boot (its wasm out of memory: too many processes at once) ends with code 1, so a parent
  // waiting on it as a child hears an exit and a run doesn't wait for "ready" until it times out.
  const boot = await booted.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (boot !== undefined) {
    const msg = boot instanceof Error ? boot.message : String(boot);
    const hint = /Out of memory/i.test(msg) ? " (too many processes at once: a browser tab has room for about 60 Wasm memories, and each running process holds some)" : "";
    post({ type: "console", level: "error", text: `bun: failed to start: ${msg}${hint}` });
    post({ type: "exit", code: 1, signal: null });
    return;
  }
  const proc = e.data.proc as { pid: number; ppid: number; cwd: string; env: Record<string, string> } | undefined;
  if (proc) {
    // A child process: its parent's env, cwd and ids, its stdout and stderr as bytes to the parent, its stdin from it.
    process.pid = proc.pid;
    process.ppid = proc.ppid;
    for (const k of Object.keys(env)) delete env[k];
    Object.assign(env, proc.env);
    process.chdir(proc.cwd);
    setKernel(post, proc.pid, has, read, listDirs);
    setRawStdio((fd, data) => post({ type: "stdio", fd, data }, [data.buffer]));
    setStdinPost(post, false);
    // Only the program itself tells the page what it watches: Watch asks about the one answering previews.
    setWatchReport(() => {});
    const thread = e.data.thread as ThreadInfo | undefined;
    if (thread) {
      // A worker_threads thread: the process's ids, not a child's of its own.
      process.pid = thread.pid;
      process.ppid = thread.ppid;
      setThread(e.data.port, thread);
    }
    if (e.data.script !== undefined) {
      post({ type: "ready" });
      return runScript(e.data.script, e.data.args ?? [], true);
    }
    if (e.data.childTest) {
      post({ type: "ready" });
      return runChildTests(e.data.childTest, e.data.args ?? [], proc.cwd);
    }
  }
  // runbun.json's `env`, over the defaults: runs, restarts on save and tests (the page logs what's wrong with the file).
  else {
    Object.assign(env, readConfig((path) => vfs.readText(path)).env);
    // The console is this program's terminal (a test run's output is not a terminal's).
    if (!e.data.tests) enableTTY(e.data.tty?.cols, e.data.tty?.rows);
  }
  if (e.data.tests) {
    testing = true;
    // `bun test`: load and run each file instead of an entry.
    const args = (e.data.args as string[] | undefined) ?? [];
    let finish: (() => boolean) | undefined;
    let options: TestOptions;
    try {
      options = testOptions(args);
      finish = await testCoverage(args);
    } catch (err) {
      post({ type: "console", level: "error", text: `error: ${err instanceof Error ? err.message : String(err)}` });
      post({ type: "ready", failed: 1 });
      return;
    }
    const { failed, results, coverageFailed } = await runTestFiles(e.data.tests, (f) => importUrl(`${VFS_ROOT}${f}`), (g.Bun as { version: string }).version, { ...options, preload: () => bunfigPreloads(true), coverage: finish }).catch((err) => (post({ type: "console", level: "error", text: fmt(err) }), { failed: 1, results: undefined, coverageFailed: undefined }));
    post({ type: "ready", failed, results, coverageFailed });
    return;
  }
  // A package.json script's line (scripts.ts shellCommand), unless the project has a file named `sh`.
  if (!proc && isShellCommand(e.data.entry, e.data.args ?? []) && !vfs.files.has(e.data.entry)) {
    post({ type: "ready" });
    return runScript(e.data.args[1], e.data.args.slice(2), false);
  }
  (g.Bun as { main: string }).main = process.argv[1] = `/${e.data.entry}`;
  // A package's bin run from a script (`"dev": "vite --port 3000"`) reads its arguments here.
  process.argv.splice(2, Infinity, ...((e.data.args as string[] | undefined) ?? []));
  try {
    const code = (e.data.thread as ThreadInfo | undefined)?.eval;
    // bunfig.toml's `preload`, then the command line's (`bun -r ./p.ts main.ts`; with `bun run`, bunfig.toml's
    // replace them, as in Bun 1.4), each resolved as it comes, before the entry (their runtime plugins apply to the
    // entry's imports). Not in a worker_threads thread, which is no new `bun` process.
    if (!e.data.thread) {
      const execArgv = (e.data.execArgv as string[] | undefined) ?? [];
      process.execArgv = execArgv;
      let specs: string[] = [];
      try {
        const bunfig = bunfigPreloadSpecs(false);
        specs = e.data.run && bunfig.length ? bunfig : [...bunfig, ...cliPreloads(execArgv)];
      } catch (err) {
        // A bunfig.toml that doesn't parse.
        post({ type: "console", level: "error", text: `error: ${err instanceof Error ? err.message : String(err)}` });
        halt(1);
      }
      for (const spec of specs) {
        let path: string;
        try {
          path = resolvePreload(spec);
        } catch (err) {
          post({ type: "console", level: "error", text: `error: ${err instanceof Error ? err.message : String(err)}` });
          return halt(1);
        }
        await importUrl(`${VFS_ROOT}${path}`);
      }
    }
    // A .cjs/.mjs program by moduleServer.ts's ENTRY_PREFIX: served as its extension makes it, as Bun runs one.
    const entryUrl = `${VFS_ROOT}${/\.[cm][jt]s$/.test(e.data.entry) ? "__entry/" : ""}${e.data.entry}`;
    // `bun ./index.html`: Bun's dev server, which bundles the page like an HTML import and serves it.
    const htmlEntry = code === undefined && /\.html?$/.test(e.data.entry);
    // A program that a preloaded plugin's onLoad takes is loaded through it, as Bun loads its entry (plugins.ts).
    const plugged = htmlEntry || code !== undefined ? undefined : await pluginImportUrl(`/${e.data.entry}`, `/${e.data.entry}`);
    const mod = (htmlEntry ? serveHtmlEntry(e.data.entry, process.argv.slice(2)) : code !== undefined ? evalThread(code) : await importUrl(plugged ?? entryUrl)) as { default?: ServeOptions };
    // Bun serves an entry whose default export has a fetch handler (Hono's `export default app`), unless that
    // port is already served (Elysia's `export default app.listen(3000)`).
    const def = mod.default;
    const port = Number(def?.port ?? env.PORT ?? env.BUN_PORT ?? 3000);
    if (typeof def?.fetch === "function" && !servers.some((s) => s.server === def || s.port === port)) listen(def);
  } catch (err) {
    // Ends the program (the "exit" message ends the start too), unless an uncaughtException listener takes it; Bun
    // passes it as the entry's rejection.
    uncaught(err, "uncaughtException", "unhandledRejection");
  }
  // A package's bin often starts its server after its entry has run (Vite's `import("../dist/node/cli.js")`): a moment
  // for it, so the preview doesn't load before there is a server.
  if (e.data.entry.startsWith("node_modules/") && !servers.length) await new Promise<void>((r) => ((onServer = r), setTimeout(r, 10000)));
  onServer = undefined;
  post({ type: "ready" });
  // From now on the program ends once it runs out of work.
  whenIdle(drained);
});
