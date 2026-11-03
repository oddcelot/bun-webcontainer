import { BASE } from "../base";
import { loadResolver, parseData, parseDataFile, resolve } from "../resolver";
import { loadSemver } from "../semver";
import { dirname, norm, VFS } from "@runbun/vfs";
import { BUN_NAMES, builtins, installTimers, setExit, setFs, setRequire, setStdio } from "./node";
import { bundle, type BundleConfig, type BundleLog } from "./bundler";
import { setHostVfs } from "./hostPackages";
import { hash } from "./hash";
import { CryptoHasher } from "./node/crypto";
import { Glob } from "./glob";
import { installConsole, table } from "./console";
import { bunInspect, formatLog as formatValues, installWebInspect } from "./inspect";
import { trackBodies } from "./bodies";
import { fulfilled, tracked, trackedFn } from "./promises";
import { frameMapper, previewSource } from "./sourceMaps";
import { json5Stringify, tomlStringify, yamlStringify } from "./dataStringify";
import { password } from "./password";
import { Cookie, CookieMap } from "./cookie";
import { importMetaResolve, resolveSync } from "./resolve";
import { Transpiler } from "./transpiler";
import { codeError, fsError } from "./node/errors";
import { hooks, type NodeSocket } from "./node/serve";
import { flushDatabases } from "./node/sqlite";
import nodePath from "./node/path";
import process, { env } from "./node/process";
import { isDeepStrictEqual } from "./node/util";
import { runTestFiles } from "./node/test";
import { BUN_REVISION, BUN_VERSION } from "./bunVersion";
import * as fflate from "fflate";

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
type ServeOptions = { port?: number | string; hostname?: string; fetch?: Handler; routes?: Routes; websocket?: WebSocketHandlers };
type WsPayload = string | ArrayBuffer | ArrayBufferView;

const g = globalThis as unknown as Record<string, unknown>;
const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

// The worker's copy of the page VFS (sent with "start"); node:fs and Bun.file read it synchronously, and
// writes are mirrored to the page.
const vfs = new VFS();
setHostVfs(vfs);
setFs(vfs, (op, ...args) => post({ type: "vfs", op, args }));
setStdio((level, text) => post({ type: "console", level, text }));
g.__nodeBuiltins = builtins;
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
  const builtin = s.replace(/^node:/, "");
  if (builtin in builtins) return importUrl(`${VFS_ROOT}__node/${builtin}`);
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
g.global ??= globalThis;
g.Buffer ??= (builtins.buffer as { Buffer: unknown }).Buffer;
installTimers();

/** One `Bun.serve` (or `http.Server#listen`). A program may start several: devframe adds one on port 0 for its RPC socket. */
interface Instance {
  handler?: Handler;
  routes: Routes;
  websocket: WebSocketHandlers;
  port: number;
  /** Started on port 0: a helper the preview never shows. */
  ephemeral: boolean;
  topics: Map<string, Set<ServerWebSocket>>;
  server: object;
}

const servers: Instance[] = [];
let nextPort = 40001;
/** What the preview shows: the first server on a fixed port. */
const previewServer = () => servers.find((s) => !s.ephemeral) ?? servers[0];
const stopServer = (inst: Instance) => servers.splice(servers.indexOf(inst) >>> 0, 1);

let nodeServer: Instance | undefined;
/** A node:http server's accepted WebSockets carry their `ws` connection as data (see upgradeRequests). */
const nodeSockets: WebSocketHandlers = {
  open: (ws) => (ws.data as NodeSocket).open(ws),
  message: (ws, m) => (ws.data as NodeSocket).message(m),
  close: (ws, code, reason) => (ws.data as NodeSocket).close(code, reason),
};
hooks.set = (h) => {
  if (nodeServer) stopServer(nodeServer);
  nodeServer = h ? createInstance({ fetch: h, websocket: nodeSockets }) : undefined;
};
hooks.get = () => nodeServer?.handler;

/**
 * Requests the worker made for a page's WebSocket: `server.upgrade(req)` accepts them, once, with the Set-Cookie
 * headers Bun's 101 response would carry.
 */
const upgrades = new WeakMap<Request, (data: unknown, setCookies: string[]) => void>();

const size = (m: WsPayload) => (typeof m === "string" ? new TextEncoder().encode(m).length : m.byteLength);
const bytesOf = (m: Exclude<WsPayload, string>) =>
  m instanceof ArrayBuffer ? m.slice(0) : (m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer);

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
    server: {},
  };
  inst.server = {
    port,
    hostname,
    url: new URL(`http://${hostname}:${port}/`),
    development: true,
    /** Swaps handlers in place, as Bun's does; the port and hostname stay. */
    reload(next: ServeOptions) {
      if (next.fetch) inst.handler = next.fetch;
      if (next.routes) inst.routes = next.routes;
      if (next.websocket) inst.websocket = next.websocket;
    },
    /**
     * As in Bun, the 101 carries the Set-Cookie headers of `headers`, then those of what a route handler set or deleted
     * in `req.cookies` so far (later changes are lost).
     */
    upgrade(req: Request, o?: { data?: unknown; headers?: HeadersInit }) {
      const accept = upgrades.get(req);
      if (!accept) return false;
      upgrades.delete(req);
      const setCookies = [...(o?.headers ? new Headers(o.headers).getSetCookie() : []), ...(requestCookies.get(req)?.toSetCookieHeaders() ?? [])];
      accept(o?.data, setCookies);
      return true;
    },
    publish(topic: string, message: WsPayload) {
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
  };
  servers.push(inst);
  return inst;
}

/**
 * Server-side Responses. `new Response()` drops forbidden header names (Set-Cookie), which a server must send; a
 * standalone `Headers` keeps them, so responses get one built from their init, plus what Response adds itself
 * (a form's boundary). `instanceof Response` still holds for the browser's own responses (`fetch()` results).
 * Content types follow Bun: a string body has none until it is served (then `text/plain;charset=utf-8`, see
 * servedHeaders), and `Response.json()` says `application/json;charset=utf-8`.
 */
const NativeResponse = Response;
const textBodies = new WeakSet<Response>();
const hasType = (init?: ResponseInit) => new Headers(init?.headers).has("content-type");
class ServerResponse extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    const headers = new Headers(init?.headers);
    for (const [k, v] of super.headers) if (!headers.has(k)) headers.set(k, v);
    if (typeof body === "string" && !hasType(init)) {
      headers.delete("content-type");
      textBodies.add(this);
    }
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
  clone(): Response {
    const c = super.clone();
    if (textBodies.has(this)) textBodies.add(c);
    return Object.defineProperty(c, "headers", { value: new Headers(this.headers) });
  }
}
Object.defineProperty(ServerResponse, "name", { value: "Response" });
self.Response = ServerResponse as typeof Response;

// For console.log: what Responses/Requests were made with, promise states, URL's inspect.custom (as in Bun).
trackBodies(self);
installWebInspect(self);

/** The headers Bun.serve sends for `res`, then the Set-Cookie headers of the request's `req.cookies` changes. */
function servedHeaders(res: Response, setCookies: string[]): [string, string][] {
  const headers = [...res.headers];
  if (textBodies.has(res) && !res.headers.has("content-type")) headers.push(["content-type", "text/plain;charset=utf-8"]);
  for (const c of setCookies) headers.push(["set-cookie", c]);
  return headers;
}

/**
 * A server-side Request. `new Request()` drops forbidden header names (Cookie, Origin, Upgrade, Sec-*), which a
 * server must see; a standalone `Headers` keeps them.
 */
function serverRequest(path: string, init: { method?: string; body?: BodyInit | null }, headers: [string, string][]) {
  headers = headers.map(([k, v]) => [k, k === "origin" || k === "referer" ? asPageOrigin(v) : v]);
  // The init's headers too: body methods (`formData()`) read the Request's own content-type.
  const req = new Request(self.location.origin + path, { ...init, headers });
  return Object.defineProperty(req, "headers", { value: new Headers(headers) });
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

/** A page's WebSocket: a GET with `upgrade: websocket` through the server's handler, which may accept it. */
async function openSocket(inst: Instance, port: MessagePort, path: string, headers: [string, string][]) {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const req = serverRequest(path, {}, [...headers, ["upgrade", "websocket"], ["connection", "Upgrade"], ["sec-websocket-version", "13"], ["sec-websocket-key", key]]);
  let ws: ServerWebSocket | undefined;
  upgrades.set(req, (data, setCookies) => {
    ws = new ServerWebSocket(port, inst, data);
    // The page's WebSocket never sees the 101's headers: its cookies go to the preview's cookie jar (runner.ts),
    // before the socket opens, so the page's next request carries them.
    if (setCookies.length) post({ type: "cookies", path, setCookies });
  });
  try {
    await dispatch(inst, req);
  } catch (err) {
    console.error(err);
  }
  upgrades.delete(req);
  if (!ws) {
    port.postMessage({ type: "close", code: 1006, reason: "" });
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
 * Bundles an HTML import with Bun's bundler (browser target, scripts and stylesheets become hashed chunks under
 * ASSET_PREFIX). Null when bundling fails; the errors go to the console.
 */
function bundleHtml(imp: HtmlImport): Promise<HtmlBundle> {
  let p = htmlBundles.get(imp.__htmlImport);
  if (p) return p;
  p = (async (): Promise<HtmlBundle> => {
    const res = await bundle(vfs, { cwd: "/", entryPoints: ["/" + norm(imp.__htmlImport)], target: "browser", format: "esm", outdir: "/__bundle", publicPath: ASSET_PREFIX, sourcemap: "none", minify: false });
    for (const l of res.logs) if (l.level === "error" || l.level === "warning") console[l.level === "error" ? "error" : "warn"](`[bundler] ${formatLog(l)}`);
    const page = res.outputs.find((o) => o.loader.toLowerCase() === "html");
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
async function sendResponse(port: MessagePort, res: Response, setCookies: string[] = []) {
  port.postMessage({ type: "head", status: res.status, statusText: res.statusText, headers: servedHeaders(res, setCookies) });
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
async function dispatch(inst: Instance, req: Request): Promise<{ res: Response; setCookies: string[] }> {
  const res = await route(inst, req);
  return { res, setCookies: requestCookies.get(req)?.toSetCookieHeaders() ?? [] };
}

async function route(inst: Instance, req: Request): Promise<Response> {
  const { routes, handler, server } = inst;
  const path = new URL(req.url).pathname;
  const asset = bundledAssets.get(path);
  if (asset && (req.method === "GET" || req.method === "HEAD")) return new Response(asset.body, { headers: { "content-type": asset.type } });
  for (const [pattern, value] of Object.entries(routes)) {
    const params = matchRoute(pattern, path);
    if (!params) continue;
    if (value instanceof Response) return value.clone();
    if (isHtmlImport(value)) return serveBundledHtml(value);
    if (typeof value === "function") return value(routeRequest(req, params), server);
    const byMethod = value[req.method];
    if (byMethod) return byMethod instanceof Response ? byMethod.clone() : byMethod(routeRequest(req, params), server);
  }
  if (handler) return handler(req, server);
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

/** True while `bun test` runs: an uncaught error is reported, and the run goes on. */
let testing = false;
/** The `exit` listeners ran; the worker is waiting to be terminated. */
let exitEmitted = false;
let halted = false;

const printError = (err: unknown) => post({ type: "console", level: "error", text: uncaughtText(err).replace(/\n$/, "") });

/** Runs the `exit` listeners, once, with `code` as `process.exitCode`. */
function emitExit(code: number) {
  if (exitEmitted) return;
  exitEmitted = true;
  process.exitCode = code;
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
function halt(code: number): never {
  if (!halted) {
    halted = true;
    try {
      flushDatabases();
    } catch (err) {
      post({ type: "console", level: "error", text: fmt(err) });
    }
    post({ type: "exit", code });
  }
  if (typeof SharedArrayBuffer === "function") for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  // Without shared memory (a page that isn't cross-origin isolated): no further task runs, and the throw ends this one.
  self.close();
  throw EXIT;
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
  if (testing) return reportUncaught(v);
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
  printError(v);
  emitExit(1);
  post({ type: "console", level: "error", text: `\n${versionLine()}` });
  halt(1);
}

const JS = "text/javascript;charset=utf-8";
const MIME: Record<string, string> = {
  js: JS,
  mjs: JS,
  cjs: JS,
  ts: JS,
  mts: JS,
  cts: JS,
  jsx: JS,
  tsx: JS,
  css: "text/css;charset=utf-8",
  html: "text/html;charset=utf-8",
  json: "application/json;charset=utf-8",
  map: "application/json;charset=utf-8",
  txt: "text/plain;charset=utf-8",
  md: "text/markdown;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  xml: "application/xml;charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wasm: "application/wasm",
};
const mimeOf = (path: string) => MIME[path.slice(path.lastIndexOf(".") + 1)] ?? "";

/**
 * `Bun.file`: a Blob over a project file. Reads go to the VFS each time, as Bun's are lazy; the Blob's own bytes
 * are the file when it was created, which is what `new Response(file)` and other native consumers send.
 */
class BunFile extends Blob {
  readonly name: string;
  readonly #start: number;
  readonly #end: number | undefined;
  constructor(path: string, type?: string, start = 0, end?: number) {
    const name = norm(nodePath.resolve(path));
    const data = vfs.readBytes(name);
    super(data ? [data.slice(start, end)] : [], { type: type ?? (mimeOf(name) || "application/octet-stream") });
    this.name = name;
    this.#start = start;
    this.#end = end;
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
    if (d === undefined) throw fsError("ENOENT", "open", "/" + this.name);
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

/** `Bun.stdout`/`Bun.stderr`: write targets that go to the console pane. */
const stdout = new BunFile("/dev/stdout");
const stderr = new BunFile("/dev/stderr");

async function writeFile(dest: string | URL | BunFile, data: unknown): Promise<number> {
  let out: string | Uint8Array;
  if (typeof data === "string") out = data;
  else if (data instanceof BunFile) out = await data.bytes();
  else if (data instanceof Blob || data instanceof Response) out = new Uint8Array(await data.arrayBuffer());
  else if (data instanceof ArrayBuffer) out = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) out = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else out = String(data);
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
  plugins?: unknown[];
  throw?: boolean;
};

const buildLog = (l: BundleLog) =>
  Object.assign(new Error(l.message), { name: "BuildMessage", level: l.level, message: l.message, position: l.file ? { file: l.file, line: l.line, column: l.column } : null });
const formatLog = (l: BundleLog) => `${l.level}: ${l.message}${l.file ? `\n    at ${l.file}:${l.line}:${l.column}` : ""}`;

/**
 * `Bun.build` through Bun's own bundler (compiled to wasm, see bundler.ts). Outputs are Blobs in memory; with
 * `outdir` they are also written to the VFS through `write`, so the page sees them. Failures throw an
 * AggregateError of the logs, as in Bun, unless `throw: false`.
 */
async function build(opts: BuildOptions) {
  if (opts.plugins?.length) console.warn("Bun.build: plugins are not supported and are ignored");
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
    naming: typeof opts.naming === "string" ? { entry: opts.naming } : opts.naming,
    publicPath: opts.publicPath,
    banner: opts.banner,
    footer: opts.footer,
  };
  const outdir = opts.outdir ? "/" + norm(nodePath.resolve(opts.outdir)) : undefined;
  if (outdir) config.outdir = outdir;
  const res = await bundle(vfs, config);
  const logs = res.logs.map(buildLog);
  if (!res.success) {
    if (opts.throw === false) return { success: false, outputs: [] as BuildArtifact[], logs };
    throw Object.assign(new AggregateError(logs, "Bundle failed"), { name: "AggregateError" });
  }
  const outputs: BuildArtifact[] = [];
  for (const o of res.outputs) {
    const rel = o.path.replace(/^\.\//, "");
    const loader = o.loader.toLowerCase();
    const blob = new ArtifactBlob([o.contents], { type: mimeOf(rel) });
    const path = outdir ? nodePath.join(outdir, rel) : `./${rel}`;
    outputs.push(Object.assign(blob, { path, kind: o.kind as BuildArtifact["kind"], loader, hash: o.hash && o.hash !== "0" ? o.hash : null, sourcemap: null as BuildArtifact | null }));
  }
  for (const o of outputs) o.sourcemap = outputs.find((m) => m.kind === "sourcemap" && m.path === `${o.path}.map`) ?? null;
  if (outdir) for (const o of outputs) await writeFile(o.path, o);
  return { success: true, outputs, logs };
}

/**
 * Bun's fetch reads `file:` URLs from disk; here, from the VFS (napi-rs wasm bindings fetch their .wasm this way).
 * A relative URL is invalid, as in Bun: the worker's own URL would make it a request to the playground.
 */
const networkFetch = globalThis.fetch;
const fileFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!URL.canParse(url)) throw Object.assign(new TypeError("fetch() URL is invalid"), { code: "ERR_INVALID_URL" });
  if (!url.startsWith("file:")) return networkFetch(input, init);
  const path = norm(decodeURIComponent(new URL(url).pathname));
  const data = vfs.readBytes(path);
  if (data === undefined) throw new TypeError(`fetch failed: no such file /${path}`);
  return new Response(data.slice());
};
globalThis.fetch = trackedFn(function fetch(input: RequestInfo | URL, init?: RequestInit) {
  return fileFetch(input, init);
}) as typeof fetch;

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

async function main() {
  // Bun's resolver, for `require` and `require.resolve` with a computed specifier (node/module.ts); the page has its own instance.
  const [semver] = await Promise.all([loadSemver(), loadResolver(vfs)]);
  setRequire(vfs, (spec, dir) => resolve(spec, dir, "require", "bun"), (spec, dir) => resolve(spec, dir, "import", "bun"), () => VFS_ROOT);
  const bun: Record<(typeof BUN_NAMES)[number], unknown> = {
    version: `${BUN_VERSION}-browser`,
    env,
    gc: () => {},
    main: "",
    argv: process.argv,
    stdout,
    stderr,
    inspect: Object.assign(bunInspect, {
      // `Bun.inspect.table(data, properties?, options?)`: console.table's box as a string, nested values collapsed.
      table: (data: unknown, properties?: unknown) => (typeof data === "object" && data !== null ? table(data, Array.isArray(properties) ? properties.map(String) : undefined, 5) + "\n" : ""),
    }),
    deepEquals: (a: unknown, b: unknown, strict = false) => isDeepStrictEqual(a, b, strict),
    escapeHTML,
    which: () => null,
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
    file: (path: string | URL, opts?: { type?: string }) => new BunFile(path instanceof URL ? decodeURIComponent(path.pathname) : path, opts?.type),
    write: trackedFn(function write(dest: string | URL | BunFile, data: unknown) {
      return writeFile(dest, data);
    }),
    serve: (opts: ServeOptions) => createInstance(opts).server,
    build,
    CryptoHasher,
    hash,
    // Bun's deflate is raw (no zlib header), like its inflate.
    gzipSync: (d: Compressible, o?: { level?: number }) => fflate.gzipSync(compressible(d), level(o)),
    gunzipSync: (d: Compressible) => fflate.gunzipSync(compressible(d)),
    deflateSync: (d: Compressible, o?: { level?: number }) => fflate.deflateSync(compressible(d), level(o)),
    inflateSync: (d: Compressible) => fflate.inflateSync(compressible(d)),
    Transpiler,
    resolveSync,
    resolve: async (specifier: string, from: string | URL) => resolveSync(specifier, from),
    Glob,
    // Wrapped so the functions are named `parse`/`stringify`, with Bun's lengths.
    YAML: { parse: (input: unknown) => parseData(dataText(input, "yaml"), "yaml"), stringify: (value: unknown, replacer?: unknown, space?: unknown) => yamlStringify(value, replacer, space) },
    TOML: { parse: (input: unknown) => parseData(dataText(input, "toml"), "toml"), stringify: (value: unknown, replacer?: unknown, _space?: unknown) => tomlStringify(value, replacer) },
    JSONC: { parse: (input: unknown) => jsoncParse(input) },
    JSON5: { parse: (input: unknown) => parseData(dataText(input, "json5"), "json5"), stringify: (value: unknown, replacer?: unknown, space?: unknown) => json5Stringify(value, replacer, space) },
    password,
    Cookie,
    CookieMap,
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
        const inst = previewServer();
        if (!inst) return sendText(port, 503, "No Bun.serve handler registered");
        out = await dispatch(inst, serverRequest(r.path, { method: r.method, body: r.body }, r.headers));
      } catch (err) {
        if (halted) return;
        // Bun's development server (`development` is true here) reports it as uncaught, then which request failed.
        post({ type: "console", level: "error", text: `${uncaughtText(err)}${r.method} - ${new URL(r.path, "http://localhost/").pathname} failed` });
        return sendText(port, 500, fmt(err));
      }
      await sendResponse(port, out.res, out.setCookies);
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

// The page is about to terminate this worker (Run, Stop, bun test): write open databases back first. Their bytes go
// to the page as "vfs" messages, which arrive before "flushed".
self.addEventListener("message", (e: MessageEvent) => {
  if (e.data?.type !== "flush") return;
  try {
    flushDatabases();
  } catch (err) {
    post({ type: "console", level: "error", text: fmt(err) });
  }
  post({ type: "flushed" });
});

// Page-side edits made after "start" (editor, file tree, installs). Applied straight to the VFS: only node:fs and
// Bun.write mirror back to the page, so this isn't echoed.
self.addEventListener("message", (e: MessageEvent) => {
  const m = e.data;
  if (m.type !== "vfs") return;
  if (m.op === "write") vfs.write(m.path, m.data);
  else if (m.op === "mkdir") vfs.mkdir(m.path);
  else if (m.op === "remove") vfs.remove(m.path);
});

self.addEventListener("message", async (e: MessageEvent) => {
  if (e.data.type !== "start") return;
  if (e.data.vfsRoot) VFS_ROOT = e.data.vfsRoot;
  vfs.load(e.data.files, e.data.dirs);
  await booted;
  if (e.data.tests) {
    testing = true;
    // `bun test`: load and run each file instead of an entry.
    const failed = await runTestFiles(e.data.tests, (f) => importUrl(`${VFS_ROOT}${f}`), (g.Bun as { version: string }).version).catch((err) => (post({ type: "console", level: "error", text: fmt(err) }), 1));
    post({ type: "ready", failed });
    return;
  }
  (g.Bun as { main: string }).main = process.argv[1] = `/${e.data.entry}`;
  try {
    const mod = (await importUrl(`${VFS_ROOT}${e.data.entry}`)) as { default?: ServeOptions };
    // Bun serves an entry whose default export has a fetch handler (Hono's `export default app`), unless that
    // port is already served (Elysia's `export default app.listen(3000)`).
    const def = mod.default;
    const port = Number(def?.port ?? env.PORT ?? env.BUN_PORT ?? 3000);
    if (typeof def?.fetch === "function" && !servers.some((s) => s.server === def || s.port === port)) createInstance(def);
  } catch (err) {
    // Ends the program (the "exit" message ends the start too), unless an uncaughtException listener takes it; Bun
    // passes it as the entry's rejection.
    uncaught(err, "uncaughtException", "unhandledRejection");
  }
  post({ type: "ready" });
});
