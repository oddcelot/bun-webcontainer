import { BASE } from "../base";
import { loadSemver } from "../semver";
import { dirname, norm, VFS } from "../vfs";
import { builtins, installTimers, setFs, setStdio } from "./node";
import { setHostVfs } from "./hostPackages";
import { fsError } from "./node/errors";
import { hooks } from "./node/serve";
import nodePath from "./node/path";
import process, { env } from "./node/process";

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
const importUrl = new Function("url", "options", "return import(url, options)") as (url: string, options?: ImportCallOptions) => Promise<unknown>;

/** `import(expr)` in served modules (see rewriteMeta): `file:` URLs and paths, as Bun takes them, load from the VFS. */
g.__dynamicImport = (from: string, spec: unknown, options?: ImportCallOptions) => {
  const s = String(spec);
  const builtin = s.replace(/^node:/, "");
  if (builtin in builtins) return importUrl(`${BASE}__vfs/__node/${builtin}`);
  const path = /^(file:|\/|\.)/.test(s) && decodeURIComponent(new URL(s, from).pathname);
  return importUrl(path ? `${BASE}__vfs/${norm(path)}` : s, options);
};
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
hooks.set = (h) => {
  if (nodeServer) stopServer(nodeServer);
  nodeServer = h ? createInstance({ fetch: h }) : undefined;
};
hooks.get = () => nodeServer?.handler;

/** Requests the worker made for a page's WebSocket: `server.upgrade(req)` accepts them, once. */
const upgrades = new WeakMap<Request, (data: unknown) => void>();

const size = (m: WsPayload) => (typeof m === "string" ? new TextEncoder().encode(m).length : m.byteLength);
const bytesOf = (m: Exclude<WsPayload, string>) =>
  m instanceof ArrayBuffer ? m.slice(0) : (m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer);

/** Bun's `ServerWebSocket`, talking to the page's `WebSocket` over a MessagePort (see previewWebSocket in sw.js). */
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
    upgrade(req: Request, o?: { data?: unknown }) {
      const accept = upgrades.get(req);
      if (!accept) return false;
      upgrades.delete(req);
      accept(o?.data);
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
  return page + (rest.startsWith(`${BASE}__preview`) ? rest.slice(`${BASE}__preview`.length) || "/" : rest);
}

/** A page's WebSocket: a GET with `upgrade: websocket` through the server's handler, which may accept it. */
async function openSocket(inst: Instance, port: MessagePort, path: string, headers: [string, string][]) {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const req = serverRequest(path, {}, [...headers, ["upgrade", "websocket"], ["connection", "Upgrade"], ["sec-websocket-version", "13"], ["sec-websocket-key", key]]);
  let ws: ServerWebSocket | undefined;
  upgrades.set(req, (data) => (ws = new ServerWebSocket(port, inst, data)));
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

async function dispatch(inst: Instance, req: Request): Promise<Response> {
  const { routes, handler, server } = inst;
  const path = new URL(req.url).pathname;
  for (const [pattern, value] of Object.entries(routes)) {
    const params = matchRoute(pattern, path);
    if (!params) continue;
    Object.assign(req, { params });
    if (value instanceof Response) return value.clone();
    if (isHtmlImport(value)) return serveHtml(value);
    if (typeof value === "function") return value(req, server);
    const byMethod = value[req.method];
    if (byMethod) return byMethod instanceof Response ? byMethod.clone() : byMethod(req, server);
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

for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    post({ type: "console", level, text: args.map(fmt).join(" ") });
  };
}

class BunFile {
  readonly name: string;
  constructor(path: string) {
    this.name = norm(nodePath.resolve(path));
  }
  async exists() {
    return vfs.files.has(this.name);
  }
  async bytes() {
    const d = vfs.readBytes(this.name);
    if (d === undefined) throw fsError("ENOENT", "open", "/" + this.name);
    return d.slice();
  }
  async arrayBuffer() {
    const b = await this.bytes();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  async text() {
    return new TextDecoder().decode(await this.bytes());
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

async function write(path: string, data: unknown): Promise<number> {
  let out: string | Uint8Array;
  if (typeof data === "string") out = data;
  else if (data instanceof BunFile) out = await data.bytes();
  else if (data instanceof Blob || data instanceof Response) out = new Uint8Array(await data.arrayBuffer());
  else if (data instanceof ArrayBuffer) out = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) out = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else out = String(data);
  const file = "/" + norm(nodePath.resolve(path));
  const fs = builtins.fs as { mkdirSync(p: string, o: object): void; writeFileSync(p: string, d: string | Uint8Array): void };
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return typeof out === "string" ? new TextEncoder().encode(out).length : out.byteLength;
}

type BuildArtifact = Blob & { path: string; kind: "entry-point"; loader: "js"; hash: null; sourcemap: null };

/**
 * `Bun.build` without a bundler (bwc-6yq.6): each entry point becomes a module that imports its source from the
 * module server, which transpiles it and its imports on request. Enough for a dev server that serves the
 * output to a page; `outdir` gets the same stubs.
 */
async function build(opts: { entrypoints: string[]; outdir?: string; naming?: string }) {
  const outputs: BuildArtifact[] = [];
  for (const entry of opts.entrypoints) {
    const src = norm(nodePath.resolve(entry.startsWith("file:") ? new URL(entry).pathname : entry));
    if (!vfs.files.has(src)) {
      const message = `Could not resolve: "${entry}"`;
      return { success: false, outputs: [], logs: [Object.assign(new Error(message), { level: "error", message })] };
    }
    const name = (opts.naming ?? "[name].[ext]").replace("[dir]/", "").replace("[name]", nodePath.basename(src).replace(/\.[^.]+$/, "")).replace("[hash]", "dev").replace("[ext]", "js");
    const blob = new Blob([`import ${JSON.stringify(`${BASE}__vfs/${src}`)};\n`], { type: "text/javascript;charset=utf-8" });
    outputs.push(Object.assign(blob, { path: `./${name}`, kind: "entry-point" as const, loader: "js" as const, hash: null, sourcemap: null }));
    if (opts.outdir) await write(nodePath.join(opts.outdir, name), blob);
  }
  return { success: true, outputs, logs: [] };
}

/**
 * Bun's fetch reads `file:` URLs from disk; here, from the VFS (napi-rs wasm bindings fetch their .wasm this way).
 * A relative URL is invalid, as in Bun: the worker's own URL would make it a request to the playground.
 */
const networkFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!URL.canParse(url)) throw Object.assign(new TypeError("fetch() URL is invalid"), { code: "ERR_INVALID_URL" });
  if (!url.startsWith("file:")) return networkFetch(input, init);
  const path = norm(decodeURIComponent(new URL(url).pathname));
  const data = vfs.readBytes(path);
  if (data === undefined) throw new TypeError(`fetch failed: no such file /${path}`);
  return new Response(data.slice());
};

async function main() {
  const semver = await loadSemver();
  g.Bun = {
    version: "1.4.4-browser",
    env,
    gc: () => {},
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    nanoseconds: () => Math.round(performance.now() * 1e6),
    semver: {
      order: semver.order,
      satisfies: semver.satisfies,
    },
    file: (path: string) => new BunFile(path),
    write,
    serve: (opts: ServeOptions) => createInstance(opts).server,
    build,
  };

  self.addEventListener("unhandledrejection", (e) => {
    post({ type: "console", level: "error", text: `Uncaught (in promise) ${fmt(e.reason)}` });
  });

  self.addEventListener("message", async (e: MessageEvent) => {
    const m = e.data;
    if (m.type === "request") {
      const port = e.ports[0];
      try {
        const inst = previewServer();
        if (!inst) {
          port.postMessage({ status: 503, statusText: "", headers: [], body: new TextEncoder().encode("No Bun.serve handler registered").buffer });
          return;
        }
        const r = m.req;
        const req = serverRequest(r.path, { method: r.method, body: r.body }, r.headers);
        const res = await dispatch(inst, req);
        const body = await res.arrayBuffer();
        port.postMessage({ status: res.status, statusText: res.statusText, headers: [...res.headers], body }, [body]);
      } catch (err) {
        console.error(err);
        port.postMessage({ status: 500, statusText: "", headers: [["content-type", "text/plain"]], body: new TextEncoder().encode(fmt(err)).buffer });
      }
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

self.addEventListener("message", async (e: MessageEvent) => {
  if (e.data.type !== "start") return;
  vfs.load(e.data.files, e.data.dirs);
  await booted;
  try {
    await importUrl(`${BASE}__vfs/${e.data.entry}`);
  } catch (err) {
    post({ type: "console", level: "error", text: fmt(err) });
  }
  post({ type: "ready" });
});
