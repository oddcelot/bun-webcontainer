import { Buffer } from "buffer";
import EventEmitter from "events";
import { capture, runIn } from "./asyncHooks";
import { Server as NetServer, Socket } from "./net";
import { hooks, upgradeRequests, type FetchHandler } from "./serve";
import { Readable, Writable } from "./stream";

type Any = any;

export const STATUS_CODES: Record<number, string> = { 100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints", 200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content", 205: "Reset Content", 206: "Partial Content", 300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a Teapot", 421: "Misdirected Request", 422: "Unprocessable Entity", 426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons", 500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported" };
export const METHODS = ["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE"];

const TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const nullBody = (s: number) => s === 101 || s === 204 || s === 205 || s === 304 || (s >= 100 && s < 200);

export class IncomingMessage extends (Readable as Any) {
  httpVersion = "1.1";
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  complete = false;
  url = "/";
  method = "GET";
  headers: Record<string, string | string[]> = {};
  rawHeaders: string[] = [];
  trailers = {};
  rawTrailers: string[] = [];
  aborted = false;
  statusCode?: number;
  statusMessage?: string;
  socket: Any;
  connection: Any;
  private body: Uint8Array | null = null;
  constructor(socket?: Any) {
    super();
    this.socket = this.connection = socket ?? new Socket();
  }
  _read() {
    if (this.complete) return;
    this.complete = true;
    if (this.body?.byteLength) this.push(Buffer.from(this.body));
    this.push(null);
  }
  setTimeout() {
    return this;
  }
  /** Loads the request's headers and body from a fetch `Request`. */
  static async from(req: Request, socket: Any, host: string): Promise<IncomingMessage> {
    const m = new IncomingMessage(socket);
    const u = new URL(req.url);
    m.method = req.method;
    m.url = u.pathname + u.search;
    for (const [k, v] of req.headers) {
      m.rawHeaders.push(k, v);
      const prev = m.headers[k];
      m.headers[k] = prev === undefined ? v : k === "cookie" ? `${prev}; ${v}` : Array.isArray(prev) ? [...prev, v] : k === "set-cookie" ? [prev, v] : `${prev}, ${v}`;
    }
    if (!m.headers.host) {
      m.headers.host = host;
      m.rawHeaders.push("host", host);
    }
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) m.body = new Uint8Array(await req.arrayBuffer());
    return m;
  }
}

export class OutgoingMessage extends (Writable as Any) {
  statusCode = 200;
  statusMessage = "";
  headersSent = false;
  finished = false;
  sendDate = true;
  strictContentLength = false;
  chunkedEncoding = false;
  socket: Any;
  connection: Any;
  protected _headers = new Map<string, [string, unknown]>();
  constructor() {
    super();
  }
  setHeader(name: string, value: unknown) {
    if (this.headersSent) throw Object.assign(new Error("Cannot set headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
    if (!TOKEN.test(name)) throw Object.assign(new TypeError(`Header name must be a valid HTTP token ["${name}"]`), { code: "ERR_INVALID_HTTP_TOKEN" });
    if (value === undefined) throw Object.assign(new TypeError(`Invalid value "undefined" for header "${name}"`), { code: "ERR_HTTP_INVALID_HEADER_VALUE" });
    this._headers.set(name.toLowerCase(), [name, value]);
    return this;
  }
  setHeaders(h: Headers | Map<string, unknown>) {
    for (const [k, v] of h as Any) this.setHeader(k, v);
    return this;
  }
  appendHeader(name: string, value: unknown) {
    const prev = this._headers.get(name.toLowerCase());
    if (!prev) return this.setHeader(name, value);
    this._headers.set(name.toLowerCase(), [prev[0], [...[prev[1]].flat(), ...[value].flat()]]);
    return this;
  }
  getHeader(name: string) {
    return this._headers.get(name.toLowerCase())?.[1];
  }
  getHeaders() {
    const o: Record<string, unknown> = Object.create(null);
    for (const [k, [, v]] of this._headers) o[k] = v;
    return o;
  }
  getHeaderNames() {
    return [...this._headers.keys()];
  }
  getRawHeaderNames() {
    return [...this._headers.values()].map(([n]) => n);
  }
  hasHeader(name: string) {
    return this._headers.has(name.toLowerCase());
  }
  removeHeader(name: string) {
    if (this.headersSent) throw Object.assign(new Error("Cannot remove headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
    this._headers.delete(name.toLowerCase());
  }
  flushHeaders() {
    this.headersSent = true;
    (this as Any).commit?.();
  }
  setTimeout() {
    return this;
  }
  addTrailers() {}
  cork() {}
  uncork() {}
  destroy(err?: Error) {
    this.finished = true;
    (this as Any).endStream?.();
    return super.destroy(err);
  }
}

/**
 * A response goes out whole when the handler ends it in the same tick it first writes (`res.end(body)`, Express's
 * `send`); one that's still open after its first write or flushHeaders() streams (SSE, progressive output).
 */
export class ServerResponse extends (OutgoingMessage as Any) {
  private chunks: Uint8Array[] = [];
  private done: (r: Response) => void;
  private method: string;
  /** Set once the Response is handed over; `stream` is its body while it streams. */
  private committed = false;
  private stream?: ReadableStreamDefaultController<Uint8Array>;
  private scheduled = false;
  constructor(req: Any, done: (r: Response) => void) {
    super();
    this.req = req;
    this.method = req.method;
    this.socket = this.connection = req.socket;
    this.done = done;
    this.once("finish", () => this.respond());
  }
  req: Any;
  writeHead(status: number, ...rest: Any[]) {
    if (this.headersSent) throw Object.assign(new Error("Cannot write headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
    const h = rest.find((a) => a && typeof a === "object");
    if (typeof rest[0] === "string") this.statusMessage = rest[0];
    this.statusCode = status;
    if (Array.isArray(h)) {
      if (h.some(Array.isArray)) for (const [k, v] of h) this.appendHeader(k, v);
      else for (let i = 0; i < h.length; i += 2) this.appendHeader(h[i], h[i + 1]);
    } else if (h) for (const k of Object.keys(h)) this.setHeader(k, h[k]);
    this.headersSent = true;
    return this;
  }
  writeContinue() {}
  writeProcessing() {}
  writeEarlyHints() {}
  assignSocket() {}
  detachSocket() {}
  _write(chunk: Any, enc: string, cb: (e?: Error) => void) {
    this.headersSent = true;
    const bytes: Uint8Array = typeof chunk === "string" ? Buffer.from(chunk, enc as BufferEncoding) : chunk;
    if (this.stream) this.stream.enqueue(bytes);
    else if (!this.committed) {
      this.chunks.push(bytes);
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.writableEnded || this.commit());
      }
    }
    cb();
  }
  _final(cb: () => void) {
    this.finished = true;
    cb();
  }
  get writableEnded() {
    return this.finished || (this as Any)._writableState?.ending === true;
  }
  private head(): ResponseInit {
    const headers = new Headers();
    for (const [k, [, v]] of this._headers) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, String(x));
    return { status: this.statusCode, statusText: this.statusMessage || STATUS_CODES[this.statusCode] || "", headers };
  }
  private get bodyless() {
    return nullBody(this.statusCode) || this.method === "HEAD";
  }
  /** Hands over a streaming Response: what was written so far, then each write as it comes. */
  private commit() {
    if (this.committed) return;
    this.committed = true;
    const body = this.bodyless
      ? null
      : new ReadableStream<Uint8Array>({
          start: (c) => {
            this.stream = c;
            for (const b of this.chunks) c.enqueue(b);
          },
          // The client went away.
          cancel: () => {
            this.stream = undefined;
            this.destroy();
          },
        });
    this.chunks = [];
    this.done(new Response(body, this.head()));
  }
  private endStream() {
    try {
      this.stream?.close();
    } catch {}
    this.stream = undefined;
  }
  private respond() {
    if (this.committed) return this.endStream();
    this.committed = true;
    const size = this.chunks.reduce((n, c) => n + c.byteLength, 0);
    const body = new Uint8Array(size);
    let o = 0;
    for (const c of this.chunks) body.set(c, o), (o += c.byteLength);
    this.done(new Response(this.bodyless ? null : body, this.head()));
  }
}

const listeners = new WeakMap<object, FetchHandler>();

export class Server extends (NetServer as Any) {
  timeout = 0;
  keepAliveTimeout = 5000;
  headersTimeout = 60000;
  requestTimeout = 300000;
  maxHeadersCount: number | null = null;
  maxRequestsPerSocket = 0;
  encrypted: boolean;
  constructor(opts?: Any, handler?: (req: Any, res: Any) => void, encrypted = false) {
    super();
    this.encrypted = encrypted;
    const l = typeof opts === "function" ? opts : handler;
    if (l) this.on("request", l);
  }
  onListen() {
    const handler: FetchHandler = async (req, bun) => {
      // The request listeners run in the context `listen` was called in; the body's `await` below resumes outside it.
      const context = capture();
      const addr = this.address();
      const socket = new Socket();
      socket.encrypted = this.encrypted;
      const incoming = await IncomingMessage.from(req, socket, `localhost:${addr?.port}`);
      // A page's WebSocket (see openSocket in the runtime): "upgrade" listeners take it, `ws` accepts it.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket" && this.listenerCount("upgrade")) {
        upgradeRequests.set(incoming, (data) => (bun as { upgrade(r: Request, o: object): boolean }).upgrade(req, { data }));
        this.emit("upgrade", incoming, socket, Buffer.alloc(0));
        return new Response(null);
      }
      return new Promise<Response>((resolve, reject) => {
        const res = new ServerResponse(incoming, (r) => {
          resolve(r);
          queueMicrotask(() => incoming.emit("close"));
        });
        res.once("close", () => {
          if (!res.finished) resolve(new Response(null, { status: 499 }));
        });
        if (!runIn(context, () => this.emit("request", incoming, res), undefined, [])) resolve(new Response("No request listener", { status: 503 }));
      }).catch((e) => new Response(String(e), { status: 500 }));
    };
    listeners.set(this, handler);
    hooks.set(handler);
  }
  onClose() {
    if (hooks.get() === listeners.get(this)) hooks.set(undefined);
    listeners.delete(this);
  }
  setTimeout(ms?: number, cb?: () => void) {
    this.timeout = ms ?? 0;
    if (cb) this.on("timeout", cb);
    return this;
  }
  closeAllConnections() {}
  closeIdleConnections() {}
}

export class Agent extends EventEmitter {
  options: object;
  constructor(options: object = {}) {
    super();
    this.options = options;
  }
  destroy() {}
}

const ERR_INVALID_PROTOCOL = (got: string, want: string) => Object.assign(new TypeError(`Protocol "${got}" not supported. Expected "${want}"`), { code: "ERR_INVALID_PROTOCOL" });

/** The response to a ClientRequest: the fetch body as a stream. */
class ClientResponse extends IncomingMessage {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private reading = false;
  onActivity?: () => void;
  private cancelFetch: () => void;
  constructor(socket: Any, r: Response, cancelFetch: () => void) {
    super(socket);
    this.cancelFetch = cancelFetch;
    this.statusCode = r.status;
    this.statusMessage = r.statusText || STATUS_CODES[r.status] || "";
    const cookies = r.headers.getSetCookie?.() ?? [];
    for (const [k, v] of r.headers) {
      if (k === "set-cookie" && cookies.length) continue;
      this.rawHeaders.push(k, v);
      this.headers[k] = k === "set-cookie" ? [v] : v;
    }
    if (cookies.length) {
      for (const c of cookies) this.rawHeaders.push("set-cookie", c);
      this.headers["set-cookie"] = cookies;
    }
    this.reader = r.body && !nullBody(r.status) ? r.body.getReader() : null;
  }
  _read() {
    if (this.reading) return;
    if (!this.reader) {
      this.complete = true;
      this.push(null);
      return;
    }
    this.reading = true;
    this.reader.read().then(
      ({ done, value }) => {
        this.reading = false;
        this.onActivity?.();
        if (done) {
          this.complete = true;
          this.push(null);
        } else if (!value?.byteLength || this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) this._read();
      },
      (e) => {
        this.reading = false;
        this.aborted = true;
        this.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET", cause: e }));
      },
    );
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    if (!this.complete) this.cancelFetch();
    this.reader?.cancel().catch(() => {});
    cb(err);
  }
}

/** The request half of `http.request`, over `fetch` (buffered until `end()`). Remote hosts follow the browser's CORS rules. */
export class ClientRequest extends (OutgoingMessage as Any) {
  method = "GET";
  path = "/";
  host = "localhost";
  protocol = "http:";
  aborted = false;
  reusedSocket = false;
  res: Any = null;
  private url: URL;
  private chunks: Uint8Array[] = [];
  private control = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timeoutMs = 0;
  private closed = false;
  constructor(input: Any, options?: Any, cb?: Any, defaultProtocol = "http:") {
    super();
    // Closing is up to the response (or an error), not the end of the writable side.
    if (this._writableState) this._writableState.autoDestroy = false;
    if (typeof options === "function") (cb = options), (options = undefined);
    let o: Any = options ?? {};
    if (typeof input === "string" || input instanceof URL) {
      const u = new URL(String(input));
      o = { protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port, path: u.pathname + u.search, auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : undefined, ...o };
    } else if (input && typeof input === "object") o = { ...input, ...o };
    const protocol: string = o.protocol ?? o.agent?.protocol ?? defaultProtocol;
    if (protocol !== defaultProtocol) throw ERR_INVALID_PROTOCOL(protocol, defaultProtocol);
    const hostname: string = o.hostname ?? o.host ?? "localhost";
    const port = o.port || o.defaultPort || (protocol === "https:" ? 443 : 80);
    this.protocol = protocol;
    this.host = hostname;
    this.method = String(o.method ?? "GET").toUpperCase();
    this.path = o.path ?? "/";
    if (/[\u0000- ]/.test(this.path)) throw Object.assign(new TypeError("Request path contains unescaped characters"), { code: "ERR_UNESCAPED_CHARACTERS" });
    if (!TOKEN.test(this.method)) throw Object.assign(new TypeError(`The argument 'method' must be a valid HTTP token ["${this.method}"]`), { code: "ERR_INVALID_ARG_VALUE" });
    this.url = new URL(`${protocol}//${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}${this.path.startsWith("/") ? "" : "/"}${this.path}`);
    const h = o.headers;
    if (Array.isArray(h)) {
      if (h.some(Array.isArray)) for (const [k, v] of h) this.appendHeader(k, v);
      else for (let i = 0; i < h.length; i += 2) this.appendHeader(h[i], h[i + 1]);
    } else if (h) for (const k of Object.keys(h)) if (h[k] !== undefined) this.setHeader(k, h[k]);
    if (o.auth && !this.hasHeader("authorization")) this.setHeader("Authorization", `Basic ${Buffer.from(String(o.auth)).toString("base64")}`);
    if (!this.hasHeader("host")) this.setHeader("Host", this.url.host);
    this.socket = this.connection = new Socket();
    if (cb) this.once("response", cb);
    this.once("close", () => {
      this.closed = true;
      clearTimeout(this.timer);
    });
    if (o.signal) {
      const s: AbortSignal = o.signal;
      const onAbort = () => this.destroy(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: s.reason }));
      if (s.aborted) queueMicrotask(onAbort);
      else {
        s.addEventListener("abort", onAbort, { once: true });
        this.once("close", () => s.removeEventListener("abort", onAbort));
      }
    }
    if (o.timeout) this.setTimeout(o.timeout);
    queueMicrotask(() => this.emit("socket", this.socket));
  }
  setTimeout(ms: number, cb?: () => void) {
    if (cb) this.once("timeout", cb);
    this.timeoutMs = ms;
    this.touch();
    return this;
  }
  private touch() {
    clearTimeout(this.timer);
    if (this.timeoutMs > 0 && !this.closed) this.timer = setTimeout(() => this.emit("timeout"), this.timeoutMs);
  }
  setNoDelay() {}
  setSocketKeepAlive() {}
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => this.emit("abort"));
    this.destroy();
  }
  flushHeaders() {}
  _write(chunk: Any, enc: string, cb: (e?: Error) => void) {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk, enc as BufferEncoding) : chunk);
    cb();
  }
  _final(cb: () => void) {
    cb();
    this.send();
  }
  destroy(err?: Error) {
    if (this.destroyed) return this;
    this.control.abort();
    // Node: a request destroyed before its response fails as a dropped connection.
    if (!err && !this.res) err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    return super.destroy(err);
  }
  private send() {
    if (this.destroyed) return;
    this.headersSent = true;
    const headers = new Headers();
    for (const [k, [, v]] of this._headers) {
      if (k === "host") continue;
      for (const x of Array.isArray(v) ? v : [v]) headers.append(k, String(x));
    }
    const size = this.chunks.reduce((n, c) => n + c.byteLength, 0);
    let body: Uint8Array | undefined;
    if (size) {
      body = new Uint8Array(size);
      let o = 0;
      for (const c of this.chunks) body.set(c, o), (o += c.byteLength);
    }
    this.chunks = [];
    this.touch();
    // Node doesn't follow redirects. The browser's network fetch can't hand one over (an opaque response), so only this
    // program's own servers (on localhost, answered in-process) give the redirect itself.
    const redirect = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(this.url.hostname) ? "manual" : "follow";
    fetch(this.url, { method: this.method, headers, body: body as BodyInit | undefined, signal: this.control.signal, redirect }).then(
      (r) => {
        if (this.destroyed) return void r.body?.cancel().catch(() => {});
        const res = new ClientResponse(this.socket, r, () => this.control.abort());
        (res as Any).req = this;
        res.onActivity = () => this.touch();
        this.res = res;
        res.once("close", () => {
          if (!this.closed && !this.destroyed) {
            this.closed = true;
            this.emit("close");
          }
        });
        if (this.listenerCount("response")) this.emit("response", res);
        else res.resume();
      },
      (e) => {
        if (this.destroyed) return;
        // The browser's fetch hides why it failed (refused, DNS, CORS, TLS), so every failure reads as a refused connection.
        const port = Number(this.url.port) || (this.protocol === "https:" ? 443 : 80);
        this.destroy(Object.assign(new Error(`connect ECONNREFUSED ${this.url.hostname}:${port}`), { code: "ECONNREFUSED", errno: -61, syscall: "connect", address: this.url.hostname, port, cause: e }));
      },
    );
  }
}

const requestFor = (protocol: string) => ({
  request: (input: Any, options?: Any, cb?: Any) => new ClientRequest(input, options, cb, protocol),
  get(input: Any, options?: Any, cb?: Any) {
    const req = new ClientRequest(input, options, cb, protocol);
    req.end();
    return req;
  },
});
const httpClient = requestFor("http:");
const httpsClient = requestFor("https:");

export const createServer = (opts?: Any, handler?: (req: Any, res: Any) => void) => new Server(opts, handler);

const http = {
  STATUS_CODES,
  METHODS,
  maxHeaderSize: 16384,
  globalAgent: new Agent(),
  Agent,
  Server,
  ClientRequest,
  IncomingMessage,
  ServerResponse,
  OutgoingMessage,
  createServer,
  ...httpClient,
  validateHeaderName(name: string) {
    if (!TOKEN.test(name)) throw Object.assign(new TypeError(`Header name must be a valid HTTP token ["${name}"]`), { code: "ERR_INVALID_HTTP_TOKEN" });
  },
  validateHeaderValue(name: string, value: unknown) {
    if (value === undefined) throw Object.assign(new TypeError(`Invalid value "undefined" for header "${name}"`), { code: "ERR_HTTP_INVALID_HEADER_VALUE" });
  },
  setMaxIdleHTTPParsers() {},
};
export default http;

export const https = {
  Agent,
  Server: class HttpsServer extends Server {
    constructor(opts?: Any, handler?: (req: Any, res: Any) => void) {
      super(opts, handler, true);
    }
  },
  createServer(opts?: Any, handler?: (req: Any, res: Any) => void) {
    return new https.Server(opts, handler);
  },
  globalAgent: new Agent(),
  ...httpsClient,
};
