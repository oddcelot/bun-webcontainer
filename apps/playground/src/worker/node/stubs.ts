import EventEmitter from "events";
import { codeError, stubModule } from "./errors";

const lookup = (host: string, opts?: unknown, cb?: (...a: unknown[]) => void) => {
  const done = typeof opts === "function" ? opts : cb;
  if (host === "localhost") queueMicrotask(() => done?.(null, "127.0.0.1", 4));
  else queueMicrotask(() => done?.(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", syscall: "getaddrinfo", hostname: host })));
};

export const dns = stubModule("dns", "resolve resolve4 resolve6 reverse setServers getServers Resolver", {
  lookup,
  promises: {
    lookup: async (host: string) => {
      if (host === "localhost") return { address: "127.0.0.1", family: 4 };
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", syscall: "getaddrinfo", hostname: host });
    },
  },
  setDefaultResultOrder() {},
  getDefaultResultOrder: () => "verbatim",
});

export const http2 = stubModule("http2", "connect createServer createSecureServer getDefaultSettings getPackedSettings getUnpackedSettings Http2ServerRequest Http2ServerResponse", { constants: {}, sensitiveHeaders: Symbol("nodejs.http2.sensitiveHeaders") });
export const tls = stubModule("tls", "connect createServer createSecureContext checkServerIdentity getCiphers TLSSocket Server", { DEFAULT_MIN_VERSION: "TLSv1.2", DEFAULT_MAX_VERSION: "TLSv1.3", rootCertificates: [] });

/** The primary of a cluster without workers: an EventEmitter, as Bun's, whose `fork` throws (no processes to fork). */
export const cluster = Object.assign(new EventEmitter(), stubModule("cluster", "fork disconnect setupPrimary setupMaster Worker"), { isPrimary: true, isMaster: true, isWorker: false, workers: {}, settings: {}, SCHED_NONE: 1, SCHED_RR: 2, schedulingPolicy: 2 });

/** A UDP socket can be made, but not bound or used: a browser has no UDP. */
class DgramSocket extends EventEmitter {
  constructor(readonly type: string) {
    super();
  }
  close(cb?: () => void) {
    if (cb) this.once("close", cb);
    queueMicrotask(() => this.emit("close"));
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
for (const k of "bind connect send address remoteAddress setBroadcast setTTL setMulticastTTL setMulticastLoopback setMulticastInterface addMembership dropMembership setRecvBufferSize setSendBufferSize getRecvBufferSize getSendBufferSize".split(" ")) {
  (DgramSocket.prototype as unknown as Record<string, unknown>)[k] = function () {
    throw new Error(`node:dgram socket.${k} is not supported in the playground: a browser has no UDP`);
  };
}
export const dgram = {
  Socket: DgramSocket,
  createSocket(type: string | { type: string }, listener?: (...a: unknown[]) => void) {
    const s = new DgramSocket(typeof type === "string" ? type : type?.type);
    if (listener) s.on("message", listener);
    return s;
  },
};

export const repl = stubModule("repl", "start REPLServer Recoverable", { REPL_MODE_SLOPPY: Symbol("repl-sloppy"), REPL_MODE_STRICT: Symbol("repl-strict"), builtinModules: [] });

/** node:trace_events: categories turn on and off as Bun's do; nothing records events. */
const enabledCategories = new Map<string, number>();
class Tracing {
  #categories: string[];
  #enabled = false;
  constructor(categories: string[]) {
    this.#categories = categories;
    Object.defineProperties(this, { enabled: { value: false, enumerable: true, configurable: true }, categories: { value: categories.join(","), enumerable: true, configurable: true } });
  }
  #set(on: boolean) {
    if (this.#enabled === on) return;
    this.#enabled = on;
    Object.defineProperty(this, "enabled", { value: on, enumerable: true, configurable: true });
    for (const c of this.#categories) {
      const n = (enabledCategories.get(c) ?? 0) + (on ? 1 : -1);
      if (n > 0) enabledCategories.set(c, n);
      else enabledCategories.delete(c);
    }
  }
  enable() {
    this.#set(true);
  }
  disable() {
    this.#set(false);
  }
}
export const trace_events = {
  createTracing(options: { categories: string[] }) {
    if (typeof options !== "object" || options === null) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options" argument must be of type object.`);
    const { categories } = options;
    if (!Array.isArray(categories) || categories.some((c) => typeof c !== "string")) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.categories" property must be of type string[].`);
    if (!categories.length) throw codeError(TypeError, "ERR_TRACE_EVENTS_CATEGORY_REQUIRED", "At least one category is required");
    return new Tracing(categories.slice());
  },
  getEnabledCategories: () => (enabledCategories.size ? [...enabledCategories.keys()].join(",") : undefined),
};

export { async_hooks } from "./asyncHooks";
