import EventEmitter from "events";
import { Buffer } from "buffer";
import { Duplex } from "./stream";
import fs from "./fs";
import { hold, release } from "../loop";

const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const v6 = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(([0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::(([0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?)(%\w+)?$/i;
export const isIPv4 = (s: string) => typeof s === "string" && v4.test(s);
export const isIPv6 = (s: string) => typeof s === "string" && v6.test(s);

/** Where a plain `net.Server` listens: a socket path, or a port. */
type Address = string | number;

/**
 * The runtime's side of connections between processes: the page hands a `connect` to a server of another process of
 * the run (runner.ts, "net-connect"), which `accept`s it; `changed` reports this one's servers to the page.
 */
export const netHooks: { connect(address: Address, port: MessagePort): void; changed(): void } = {
  connect: (_address, port) => port.postMessage({ type: "refused" }),
  changed() {},
};

/** This process's plain `net.Server`s, by where they listen. */
const listening = new Map<Address, Server>();
export const netAddresses = () => [...listening.keys()];

/** A connection for `address` from another process: its server's, or refused. */
export function acceptConnection(address: Address, port: MessagePort) {
  const server = listening.get(address);
  if (server) server.accept(port);
  else port.postMessage({ type: "refused" });
}

/** A path, as `listen` and `connect` take one: a string that isn't a port number. */
const pathOf = (a: unknown) => (typeof a === "string" && !/^\d+$/.test(a) ? a : undefined);

/**
 * A stream socket. Connected (`connect`, or accepted by a `net.Server`), its peer is the other end of a MessageChannel:
 * a server of this process, or of another process of the run (a worker_threads thread's, a child's) through the page.
 * Otherwise it never connects (`http`'s requests carry one).
 */
export class Socket extends (Duplex as any) {
  remoteAddress = "127.0.0.1";
  remotePort = 0;
  localAddress = "127.0.0.1";
  localPort = 0;
  encrypted = false;
  connecting = false;
  #peer?: MessagePort;
  #refed = true;
  _read() {}
  _write(c: Uint8Array | string, enc: BufferEncoding, cb: () => void) {
    if (this.#peer) {
      const data = new Uint8Array(typeof c === "string" ? Buffer.from(c, enc) : c).buffer;
      this.#peer.postMessage({ type: "data", data }, [data]);
    }
    cb();
  }
  _final(cb: () => void) {
    this.#peer?.postMessage({ type: "end" });
    cb();
  }
  _destroy(err: Error | null, cb: (err: Error | null) => void) {
    this.#peer?.postMessage({ type: "close" });
    this.#peer?.close();
    this.#peer = undefined;
    release(this);
    cb(err);
  }
  /** Talks to the other end over `port`; an open connection holds the program, as in Node, until `unref()`. */
  attach(port: MessagePort) {
    this.#peer = port;
    if (this.#refed) hold(this);
    port.onmessage = ({ data }) => {
      if (data.type === "data") this.push(Buffer.from(data.data));
      else if (data.type === "end") this.push(null);
      else if (data.type === "close") this.destroy();
      else if (data.type === "accepted") {
        this.connecting = false;
        this.emit("connect");
        this.emit("ready");
      } else if (data.type === "refused") this.destroy(this.#refused);
    };
  }
  #refused?: Error;
  connect(...args: any[]): this {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    const o = typeof args[0] === "object" && args[0] !== null ? args[0] : pathOf(args[0]) ? { path: args[0] } : { port: args[0], host: args[1] };
    const address: Address = o.path ?? Number(o.port);
    // Node's errors: no server on a path is ENOENT, none on a port ECONNREFUSED.
    const host = o.host === undefined || o.host === "localhost" ? "127.0.0.1" : o.host;
    const [code, errno, at] = typeof address === "string" ? ["ENOENT", -2, address] : ["ECONNREFUSED", -61, `${host}:${address}`];
    this.#refused = Object.assign(new Error(`connect ${code} ${at}`), { errno, code, syscall: "connect", address: typeof address === "string" ? address : host, ...(typeof address === "number" && { port: address }) });
    if (cb) this.once("connect", cb);
    this.connecting = true;
    if (typeof address === "number") this.remotePort = address;
    const { port1, port2 } = new MessageChannel();
    this.attach(port1);
    const server = listening.get(address);
    if (server) queueMicrotask(() => server.accept(port2));
    else netHooks.connect(address, port2);
    return this;
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
    this.#refed = true;
    if (this.#peer) hold(this);
    return this;
  }
  unref() {
    this.#refed = false;
    release(this);
    return this;
  }
  address() {
    return { address: this.localAddress, family: "IPv4", port: this.localPort };
  }
}

let nextPort = 49152;

/**
 * A listening server. A plain one accepts connections from `connect` (in this process or another of the run);
 * `http.Server` builds on it, and takes the preview's requests and fetches instead.
 */
export class Server extends EventEmitter {
  listening = false;
  #refed = true;
  #at?: Address;
  protected _addr: { address: string; family: string; port: number } | string | null = null;
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
    const host = o.host ?? "::";
    const path = pathOf(o.path ?? o.port);
    let port: number;
    try {
      // Port 0 (or none) is the subclass's to pick (http.Server: the runtime's), else the next free one.
      const own = this.onListen(Number(o.port) || 0);
      port = own ?? (Number(o.port) || nextPort++);
      if (own === undefined) this.#bind(path ?? port);
    } catch (e) {
      // EADDRINUSE and the like: an "error" event, as Node's listen reports them.
      queueMicrotask(() => this.emit("error", e));
      return this;
    }
    this._addr = this.#at === path && path ? path : { address: host === "localhost" ? "127.0.0.1" : host, family: host.includes(":") ? "IPv6" : "IPv4", port };
    this.listening = true;
    if (this.#refed) hold(this);
    if (cb) this.once("listening", cb as () => void);
    queueMicrotask(() => this.emit("listening"));
    return this;
  }
  /** Binds `port` (0: any); returns the port it got, or nothing to leave that to `listen`. Throws if it can't. */
  protected onListen(_port: number): number | void {}
  protected onClose() {}
  /** A plain server takes connections at `at`. A socket path is a file while it listens, as in Node. */
  #bind(at: Address) {
    if (listening.has(at) || (typeof at === "string" && fs.existsSync(at)))
      throw Object.assign(new Error(`listen EADDRINUSE: address already in use ${at}`), { code: "EADDRINUSE", errno: -48, syscall: "listen", address: at });
    if (typeof at === "string") fs.writeFileSync(at, "");
    listening.set(at, this);
    this.#at = at;
    netHooks.changed();
  }
  /** A connection on `port` (see Socket#connect): a socket of its own, as the "connection" event gives it. */
  accept(port: MessagePort) {
    if (!this.listening) return port.postMessage({ type: "refused" });
    const socket = new Socket();
    socket.attach(port);
    port.postMessage({ type: "accepted" });
    this.emit("connection", socket);
  }
  address() {
    return this._addr;
  }
  close(cb?: (err?: Error) => void): this {
    const was = this.listening;
    if (was) this.onClose();
    if (this.#at !== undefined) {
      listening.delete(this.#at);
      if (typeof this.#at === "string") fs.rmSync(this.#at, { force: true });
      this.#at = undefined;
      netHooks.changed();
    }
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
  connect: (...args: any[]) => new Socket().connect(...args),
  createConnection: (...args: any[]) => new Socket().connect(...args),
  setDefaultAutoSelectFamily() {},
  getDefaultAutoSelectFamily: () => true,
  setDefaultAutoSelectFamilyAttemptTimeout() {},
  getDefaultAutoSelectFamilyAttemptTimeout: () => 250,
  BlockList: class BlockList {},
  SocketAddress: class SocketAddress {},
};
export default net;
