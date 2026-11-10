import EventEmitter from "events";
import { Duplex } from "./stream";
import { hold, release } from "../loop";

const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const v6 = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(([0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::(([0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?)(%\w+)?$/i;
export const isIPv4 = (s: string) => typeof s === "string" && v4.test(s);
export const isIPv6 = (s: string) => typeof s === "string" && v6.test(s);

/** No sockets exist: a stream that never connects. */
export class Socket extends (Duplex as any) {
  remoteAddress = "127.0.0.1";
  remotePort = 0;
  localAddress = "127.0.0.1";
  localPort = 0;
  encrypted = false;
  connecting = false;
  _read() {}
  _write(_c: unknown, _e: unknown, cb: () => void) {
    cb();
  }
  connect() {
    throw new Error("node:net.Socket#connect is not supported in the playground");
  }
  setTimeout() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  address() {
    return { address: this.localAddress, family: "IPv4", port: this.localPort };
  }
}

let nextPort = 49152;

/** A listening server that accepts no connections; `http.Server` builds on it. */
export class Server extends EventEmitter {
  listening = false;
  #refed = true;
  protected _addr: { address: string; family: string; port: number } | null = null;
  maxConnections = 0;
  constructor(opts?: unknown, listener?: (...a: any[]) => void) {
    super();
    const l = typeof opts === "function" ? opts : listener;
    if (l) this.on("connection", l as (...a: any[]) => void);
  }
  /** Binds `port`/`host`; subclasses hook `onListen`/`onClose`. */
  listen(...args: any[]): this {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    const o = typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined };
    if (this.listening) throw Object.assign(new Error("Listen method has been called more than once without closing."), { code: "ERR_SERVER_ALREADY_LISTEN" });
    const port = Number(o.port) || nextPort++;
    const host = o.host ?? "::";
    this._addr = { address: host === "localhost" ? "127.0.0.1" : host, family: host.includes(":") ? "IPv6" : "IPv4", port };
    this.listening = true;
    if (this.#refed) hold(this);
    this.onListen();
    if (cb) this.once("listening", cb as () => void);
    queueMicrotask(() => this.emit("listening"));
    return this;
  }
  protected onListen() {}
  protected onClose() {}
  address() {
    return this._addr;
  }
  close(cb?: (err?: Error) => void): this {
    const was = this.listening;
    if (was) this.onClose();
    this.listening = false;
    this._addr = null;
    release(this);
    if (cb) this.once("close", (...a: unknown[]) => cb(was ? undefined : Object.assign(new Error("Server is not running."), { code: "ERR_SERVER_NOT_RUNNING" })));
    queueMicrotask(() => this.emit("close"));
    return this;
  }
  getConnections(cb: (err: Error | null, n: number) => void) {
    queueMicrotask(() => cb(null, 0));
    return this;
  }
  /** A listening server holds the program (loop.ts) until `unref()`. */
  ref() {
    this.#refed = true;
    if (this.listening) hold(this);
    return this;
  }
  unref() {
    this.#refed = false;
    release(this);
    return this;
  }
  [Symbol.asyncDispose]() {
    return new Promise<void>((r) => this.close(() => r()));
  }
}

const net = {
  isIP: (s: string) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
  isIPv4,
  isIPv6,
  Socket,
  Server,
  Stream: Socket,
  createServer: (opts?: unknown, listener?: (...a: any[]) => void) => new Server(opts, listener),
  connect() {
    throw new Error("node:net.connect is not supported in the playground");
  },
  createConnection() {
    throw new Error("node:net.createConnection is not supported in the playground");
  },
  setDefaultAutoSelectFamily() {},
  getDefaultAutoSelectFamily: () => true,
  setDefaultAutoSelectFamilyAttemptTimeout() {},
  getDefaultAutoSelectFamilyAttemptTimeout: () => 250,
  BlockList: class BlockList {},
  SocketAddress: class SocketAddress {},
};
export default net;
