// npm packages Bun serves from its own modules, installed or not (bun/src/resolve_builtins/HardcodedModule.rs, "Thirdparty
// packages we override"): undici, node-fetch, isomorphic-fetch, @vercel/fetch over fetch; abort-controller and
// utf-8-validate over the globals; `ws` is ./ws.ts. After bun/src/js/thirdparty/*.
// Evaluating this has no side effects but one: abort-controller's static members, which Bun puts on AbortController too.
import { Buffer } from "buffer";
import buffer from "./buffer";
import EventEmitter from "events";
import Stream, { Readable } from "./stream";

type Any = any;

/** Bun.fetch, the original fetch: the runtime sets it once it has wrapped the browser's (a program may replace the global). */
let bunFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
export const setBunFetch = (f: typeof fetch) => void (bunFetch = f);

const notImplemented = () => {
  throw new Error("This function is not yet implemented in Bun");
};

/** A response body as a node Readable of Buffers, as node-fetch's. */
function nodeBody(web: ReadableStream<Uint8Array> | null): Any {
  return Readable.from(
    (async function* () {
      if (!web) return;
      const reader = web.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) yield Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength);
    })(),
    { objectMode: false },
  );
}

// ---- isomorphic-fetch
const isomorphicFetch: Any = { fetch: (...args: Parameters<typeof fetch>) => bunFetch(...args) }.fetch;
isomorphicFetch.default = isomorphicFetch;
isomorphicFetch.fetch = isomorphicFetch;

// ---- @vercel/fetch
const vercelFetch = (wrapper: Any = (...a: Parameters<typeof fetch>) => bunFetch(...a)) => {
  async function vercelFetch(url: Any, opts: Any = {}) {
    // Object bodies become JSON.
    if (opts.body && typeof opts.body === "object" && (!("buffer" in opts.body) || typeof opts.body.buffer !== "object" || !(opts.body.buffer instanceof ArrayBuffer))) {
      opts.body = JSON.stringify(opts.body);
      if (!opts.headers) opts.headers = new Headers();
      opts.headers.set("Content-Type", "application/json");
    }
    try {
      return await wrapper(url, opts);
    } catch (error: Any) {
      error.url = url;
      error.opts = opts;
      throw error;
    }
  }
  (vercelFetch as Any).default = vercelFetch;
  return vercelFetch;
};

// ---- utf-8-validate
const utf8Validate = function utf8Validate(b: ArrayBufferView) {
  return buffer.isUtf8(b);
};

// ---- abort-controller: the global, with itself and AbortSignal as members (as the package's CommonJS export)
for (const [k, v] of [["AbortSignal", AbortSignal], ["AbortController", AbortController], ["default", AbortController]] as const)
  if (!Object.hasOwn(AbortController, k)) Object.defineProperty(AbortController, k, { value: v, enumerable: true, writable: true });

// ---- node-fetch
class NodeFetchHeaders extends Headers {
  raw() {
    const obj: Record<string, string | string[]> = (this as Any).toJSON();
    for (const key in obj) if (!Array.isArray(obj[key])) obj[key] = [obj[key] as string];
    return obj;
  }
  sort() {
    throw new TypeError("Expected this to be instanceof URLSearchParams");
  }
}
const kBody = Symbol("kBody");
const kHeaders = Symbol("kHeaders");
const kFetched = Symbol("kFetched");

/** An old-style Stream (form-data's CombinedStream) piped into a Readable, which Readable.toWeb needs. */
function readableFromOldStyleStream(source: Any) {
  const passthrough = new (Stream as Any).PassThrough();
  source.on("error", (err: Error) => {
    if (!passthrough.writableEnded) passthrough.destroy(err);
  });
  source.pipe(passthrough);
  return passthrough;
}
const isNodeStream = (b: unknown): boolean => !!b && typeof b === "object" && (b instanceof (Stream as Any) || b instanceof Readable);

class NodeFetchResponse extends Response {
  declare [kBody]: Any;
  declare [kHeaders]: Any;
  declare [kFetched]: boolean | undefined;
  constructor(body?: Any, init?: ResponseInit) {
    if (isNodeStream(body)) body = (Readable as Any).toWeb(body instanceof Readable ? body : readableFromOldStyleStream(body));
    super(body, init);
  }
  /** A node Readable, as node-fetch's. */
  get body(): Any {
    if (this[kBody]) return this[kBody];
    const web = super.body;
    if (!web && !this[kFetched]) return null;
    return (this[kBody] = nodeBody(web));
  }
  get headers() {
    return (this[kHeaders] ??= Object.setPrototypeOf(super.headers, NodeFetchHeaders.prototype));
  }
  clone(): Any {
    const cloned = Object.setPrototypeOf(super.clone(), NodeFetchResponse.prototype);
    // A response of the program's own server has its headers as its own property (the runtime's Response).
    if (Object.hasOwn(this, "headers")) Object.defineProperty(cloned, "headers", { value: new NodeFetchHeaders(this.headers) });
    this[kBody] = undefined;
    if (this[kFetched]) cloned[kFetched] = true;
    return cloned;
  }
  /** node-fetch parses the text, so an empty body rejects. */
  async json() {
    return JSON.parse(await super.text());
  }
  async buffer() {
    return Buffer.from(await super.arrayBuffer());
  }
  /** node-fetch's: "error" for any status that isn't ok. */
  get type(): Any {
    return super.ok ? "default" : "error";
  }
}

const kUrl = Symbol("kUrl");
class NodeFetchRequest extends Request {
  declare [kUrl]?: string;
  constructor(input: Any, init?: RequestInit) {
    // node-fetch takes a URL that doesn't parse ("/"), as Bun's does.
    if (typeof input === "string" && !URL.canParse(input)) {
      super(new URL(input, "http://localhost/"), init);
      this[kUrl] = input;
    } else super(input, init);
  }
  get url() {
    return this[kUrl] ?? super.url;
  }
}

async function nodeFetch(url: Any, init?: Any): Promise<Any> {
  const body = init?.body;
  if (body && typeof body === "object" && !body[Symbol.asyncIterator] && isNodeStream(body))
    init = { ...init, body: (Readable as Any).toWeb(body instanceof Readable ? body : readableFromOldStyleStream(body)), duplex: "half" };
  const response: Any = await bunFetch(url, init);
  Object.setPrototypeOf(response, NodeFetchResponse.prototype);
  if (Object.hasOwn(response, "headers")) Object.setPrototypeOf(response.headers, NodeFetchHeaders.prototype);
  response[kFetched] = true;
  return response;
}
class FetchAbortError extends DOMException {
  constructor(message?: string) {
    super(message, "AbortError");
  }
}
class FetchBaseError extends Error {
  type: string;
  constructor(message: string, type: string) {
    super(message);
    this.type = type;
  }
}
class FetchError extends FetchBaseError {
  code?: string;
  constructor(message: string, type: string, systemError?: { code?: string }) {
    super(message, type);
    this.code = systemError?.code;
  }
}
const blobFromSync = (path: string, options?: object) => (globalThis as Any).Bun.file(path, options);
const blobFrom = (path: string, options?: object) => Promise.resolve(blobFromSync(path, options));
Object.assign(nodeFetch, {
  AbortError: FetchAbortError,
  Blob,
  FetchBaseError,
  FetchError,
  File,
  FormData,
  Headers: NodeFetchHeaders,
  Request: NodeFetchRequest,
  Response: NodeFetchResponse,
  blobFrom,
  blobFromSync,
  fileFrom: blobFrom,
  fileFromSync: blobFromSync,
  isRedirect: (code: number) => code === 301 || code === 302 || code === 303 || code === 307 || code === 308,
  fetch: nodeFetch,
  default: nodeFetch,
});

// ---- undici
class BodyReadable extends (Readable as Any) {
  #response: Response;
  #bodyUsed: boolean;
  constructor(response: Response) {
    super({ read() {} });
    this.#response = response;
    this.#bodyUsed = response.bodyUsed;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading = false;
    // Fed from the web body once read as a stream; the body mixin below reads the response instead.
    this._read = () => {
      reader ??= (response.body ?? new ReadableStream({ start: (c) => c.close() })).getReader();
      if (reading) return;
      reading = true;
      reader.read().then(
        ({ done, value }) => {
          reading = false;
          if (done) this.push(null);
          else this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        },
        (e) => this.destroy(e),
      );
    };
  }
  get bodyUsed() {
    return this.#bodyUsed;
  }
  #consume() {
    if (this.#bodyUsed) throw new TypeError("unusable");
    this.#bodyUsed = true;
  }
  async arrayBuffer() {
    this.#consume();
    return this.#response.arrayBuffer();
  }
  async blob() {
    this.#consume();
    return this.#response.blob();
  }
  async formData() {
    this.#consume();
    return this.#response.formData();
  }
  async json() {
    this.#consume();
    return this.#response.json();
  }
  async text() {
    this.#consume();
    return this.#response.text();
  }
}

async function request(url: Any, options: Any = { method: "GET", signal: null, headers: null, query: null, reset: false, throwOnError: false, body: null }) {
  let { method = "GET", headers: inputHeaders, query, signal, reset = false, throwOnError = false, body: inputBody, maxRedirections } = options;
  if (typeof url === "string") {
    if (query) url = new URL(url);
  } else if (typeof url === "object" && url !== null) {
    if (!(url instanceof URL)) throw new Error("not implemented");
  } else throw new TypeError("url must be a string, URL, or UrlObject");
  if (typeof url === "object" && url !== null && query) url.search = new URLSearchParams(query).toString();
  method = method && typeof method === "string" ? method.toUpperCase() : null;
  if (inputBody && (method === "GET" || method === "HEAD")) throw new Error("Body not allowed for GET or HEAD requests");
  if (maxRedirections != null && (!Number.isInteger(maxRedirections) || maxRedirections < 0)) throw new Error("maxRedirections must be a positive number");
  if (signal && !(signal instanceof AbortSignal)) throw new Error("signal must be an instance of AbortSignal");
  const follow = maxRedirections != null && maxRedirections > 0;
  const resp: Any = await bunFetch(url, { signal, mode: "cors", method, headers: inputHeaders || Object.create(null), body: inputBody, redirect: follow ? "follow" : "manual", keepalive: !reset } as RequestInit);
  const { status: statusCode, headers } = resp;
  if (throwOnError && statusCode >= 400 && statusCode < 600) throw new Error(`Request failed with status code ${statusCode}`);
  return { statusCode, headers: headers.toJSON(), body: new BodyReadable(resp), trailers: resp.trailers, opaque: Object.create(null), context: Object.create(null) };
}

class Dispatcher extends EventEmitter {}
class Agent extends Dispatcher {}
class Pool extends Dispatcher {
  request() {}
}
class BalancedPool extends Dispatcher {}
class Client extends Dispatcher {
  request() {}
}
class DispatcherBase extends EventEmitter {}
class ProxyAgent extends DispatcherBase {}
class EnvHttpProxyAgent extends DispatcherBase {}
class RetryAgent extends Dispatcher {}
class RetryHandler {}
class DecoratorHandler {}
class RedirectHandler {}
class MockClient {}
class MockPool {}
class MockAgent {}
class FileReader extends EventTarget {
  static EMPTY = 0;
  static LOADING = 1;
  static DONE = 2;
}
class EventSource extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
}

class UndiciError extends Error {}
class UndiciAbortError extends UndiciError {}
class HTTPParserError extends Error {}
class HeadersTimeoutError extends UndiciError {}
class HeadersOverflowError extends UndiciError {}
class BodyTimeoutError extends UndiciError {}
class RequestContentLengthMismatchError extends UndiciError {}
class ConnectTimeoutError extends UndiciError {}
class ResponseStatusCodeError extends UndiciError {}
class InvalidArgumentError extends UndiciError {}
class InvalidReturnValueError extends UndiciError {}
class RequestAbortedError extends UndiciAbortError {}
class ClientDestroyedError extends UndiciError {}
class ClientClosedError extends UndiciError {}
class InformationalError extends UndiciError {}
class SocketError extends UndiciError {}
class NotSupportedError extends UndiciError {}
class ResponseContentLengthMismatchError extends UndiciError {}
class BalancedPoolMissingUpstreamError extends UndiciError {}
class ResponseExceededMaxSizeError extends UndiciError {}
class RequestRetryError extends UndiciError {}
class SecureProxyConnectionError extends UndiciError {}
const errors = {
  AbortError: UndiciAbortError,
  HTTPParserError,
  UndiciError,
  HeadersTimeoutError,
  HeadersOverflowError,
  BodyTimeoutError,
  RequestContentLengthMismatchError,
  ConnectTimeoutError,
  ResponseStatusCodeError,
  InvalidArgumentError,
  InvalidReturnValueError,
  RequestAbortedError,
  ClientDestroyedError,
  ClientClosedError,
  InformationalError,
  SocketError,
  NotSupportedError,
  ResponseContentLengthMismatchError,
  BalancedPoolMissingUpstreamError,
  ResponseExceededMaxSizeError,
  RequestRetryError,
  SecureProxyConnectionError,
};

let globalDispatcher: Dispatcher | undefined;
const undici: Any = {
  Agent,
  BalancedPool,
  buildConnector: () => notImplemented,
  caches: {},
  Client,
  CloseEvent: globalThis.CloseEvent,
  connect: notImplemented,
  createRedirectInterceptor: () => new RedirectHandler(),
  DecoratorHandler,
  deleteCookie: notImplemented,
  Dispatcher,
  EnvHttpProxyAgent,
  ErrorEvent: globalThis.ErrorEvent,
  errors,
  EventSource,
  fetch: function fetch(input: RequestInfo | URL, init?: RequestInit) {
    return bunFetch(input, init);
  },
  File,
  FileReader,
  FormData,
  getCookies: notImplemented,
  getGlobalDispatcher: () => (globalDispatcher ??= new Dispatcher()),
  getGlobalOrigin: () => {},
  getSetCookies: notImplemented,
  interceptors: { redirect: () => {}, retry: () => {}, dump: () => {} },
  MessageEvent: globalThis.MessageEvent,
  MockAgent,
  MockClient,
  mockErrors: () => {},
  MockPool,
  parseMIMEType: notImplemented,
  ping(ws: Any, body?: unknown) {
    if (Buffer.isBuffer(body)) {
      if (body.length > 125) throw new TypeError("A PING frame cannot have a body larger than 125 bytes.");
    } else if (body !== undefined) throw new TypeError("Expected buffer payload");
    if (!(ws instanceof globalThis.WebSocket)) throw new TypeError("Expected a WebSocket");
    // The browser's WebSocket sends no pings of its own.
  },
  pipeline: notImplemented,
  Pool,
  ProxyAgent,
  RedirectHandler,
  request,
  RetryAgent,
  RetryHandler,
  serializeAMimeType: notImplemented,
  setCookie: notImplemented,
  setGlobalDispatcher: (d: Dispatcher) => void (globalDispatcher = d),
  setGlobalOrigin: () => {},
  stream: notImplemented,
  upgrade: notImplemented,
  util: { parseHeaders: notImplemented, headerNameToString: notImplemented },
};
// The runtime's own (its WebSocket connects to the program's servers in-process), which it installs after this module runs.
for (const k of ["Headers", "Request", "Response", "WebSocket"] as const)
  Object.defineProperty(undici, k, { enumerable: true, configurable: true, get: () => globalThis[k] });
undici.default = undici;

/** The modules, by the name Bun gives them (`require.resolve`, `import.meta.resolve`); `ws` is in index.ts. */
export const bunPackages: Record<string, object> = {
  undici,
  "node-fetch": nodeFetch,
  "isomorphic-fetch": isomorphicFetch,
  "@vercel/fetch": vercelFetch,
  "utf-8-validate": utf8Validate,
  "abort-controller": AbortController,
};

/** Other specifiers Bun maps to one of them. */
export const BUN_PACKAGE_ALIASES: Record<string, string> = {
  "ws/lib/websocket": "ws",
  "abort-controller/polyfill": "abort-controller",
  "next/dist/compiled/ws": "ws",
  "next/dist/compiled/node-fetch": "node-fetch",
  "next/dist/compiled/undici": "undici",
};
