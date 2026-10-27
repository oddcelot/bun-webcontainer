import { Buffer } from "buffer";
import EventEmitter from "events";
import { Server as NetServer, Socket } from "./net";
import { hooks, type FetchHandler } from "./serve";
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
  }
  setTimeout() {
    return this;
  }
  addTrailers() {}
  cork() {}
  uncork() {}
  destroy(err?: Error) {
    this.finished = true;
    return super.destroy(err);
  }
}

export class ServerResponse extends (OutgoingMessage as Any) {
  private chunks: Uint8Array[] = [];
  private done: (r: Response) => void;
  private method: string;
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
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk, enc as BufferEncoding) : chunk);
    cb();
  }
  _final(cb: () => void) {
    this.finished = true;
    cb();
  }
  get writableEnded() {
    return this.finished || (this as Any)._writableState?.ending === true;
  }
  private respond() {
    const headers = new Headers();
    for (const [k, [, v]] of this._headers) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, String(x));
    const size = this.chunks.reduce((n, c) => n + c.byteLength, 0);
    const body = new Uint8Array(size);
    let o = 0;
    for (const c of this.chunks) body.set(c, o), (o += c.byteLength);
    this.done(new Response(nullBody(this.statusCode) || this.method === "HEAD" ? null : body, { status: this.statusCode, statusText: this.statusMessage || STATUS_CODES[this.statusCode] || "", headers }));
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
    const handler: FetchHandler = async (req) => {
      const addr = this.address();
      const socket = new Socket();
      socket.encrypted = this.encrypted;
      const incoming = await IncomingMessage.from(req, socket, `localhost:${addr?.port}`);
      return new Promise<Response>((resolve, reject) => {
        const res = new ServerResponse(incoming, (r) => {
          resolve(r);
          queueMicrotask(() => incoming.emit("close"));
        });
        res.once("close", () => {
          if (!res.finished) resolve(new Response(null, { status: 499 }));
        });
        if (!this.emit("request", incoming, res)) resolve(new Response("No request listener", { status: 503 }));
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

const unsupported = (what: string) => () => {
  throw new Error(`${what} is not supported in the playground (use fetch)`);
};
export class ClientRequest extends (OutgoingMessage as Any) {
  constructor() {
    super();
    unsupported("node:http.ClientRequest")();
  }
}

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
  request: unsupported("node:http.request"),
  get: unsupported("node:http.get"),
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
  request: unsupported("node:https.request"),
  get: unsupported("node:https.get"),
};
