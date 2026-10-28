import EventEmitter from "events";
import { stubModule } from "./errors";

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
export const child_process = stubModule("child_process", "spawn exec execFile fork spawnSync execSync execFileSync ChildProcess");
export const zlib = stubModule("zlib", "createGzip createGunzip createDeflate createInflate createDeflateRaw createInflateRaw createBrotliCompress createBrotliDecompress createUnzip gzip gunzip deflate inflate deflateRaw inflateRaw brotliCompress brotliDecompress unzip gzipSync gunzipSync deflateSync inflateSync deflateRawSync inflateRawSync brotliCompressSync brotliDecompressSync unzipSync crc32", { constants: {} });
export const v8 = stubModule("v8", "getHeapStatistics getHeapSpaceStatistics getHeapSnapshot writeHeapSnapshot serialize deserialize setFlagsFromString cachedDataVersionTag");
export const readline = stubModule("readline", "createInterface Interface clearLine clearScreenDown cursorTo moveCursor emitKeypressEvents", { promises: stubModule("readline/promises", "createInterface Interface") });
export const vm = stubModule("vm", "runInThisContext runInNewContext runInContext createContext isContext compileFunction Script SourceTextModule measureMemory");
export const inspector = stubModule("inspector", "open close url waitForDebugger Session", { console });
export const cluster = stubModule("cluster", "fork disconnect setupPrimary setupMaster Worker", { isPrimary: true, isMaster: true, isWorker: false, workers: {}, settings: {} });

export const constants = {};

class AsyncLocalStorage<T> {
  private store: T | undefined;
  getStore() {
    return this.store;
  }
  run<R>(store: T, fn: (...a: unknown[]) => R, ...args: unknown[]): R {
    const prev = this.store;
    this.store = store;
    try {
      const r = fn(...args);
      if (r instanceof Promise) {
        // The store is only tracked synchronously: restore it once the call returns.
      }
      return r;
    } finally {
      this.store = prev;
    }
  }
  exit<R>(fn: (...a: unknown[]) => R, ...args: unknown[]): R {
    const prev = this.store;
    this.store = undefined;
    try {
      return fn(...args);
    } finally {
      this.store = prev;
    }
  }
  enterWith(store: T) {
    this.store = store;
  }
  disable() {
    this.store = undefined;
  }
  static bind<F extends Function>(fn: F): F {
    return fn;
  }
  static snapshot() {
    return <R>(fn: (...a: unknown[]) => R, ...args: unknown[]) => fn(...args);
  }
}

class AsyncResource {
  constructor(public type: string) {}
  runInAsyncScope<R>(fn: (...a: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return fn.apply(thisArg, args);
  }
  emitDestroy() {
    return this;
  }
  asyncId = () => 1;
  triggerAsyncId = () => 0;
  bind<F extends Function>(fn: F): F {
    return fn;
  }
  static bind<F extends Function>(fn: F): F {
    return fn;
  }
}

export const async_hooks = {
  AsyncLocalStorage,
  AsyncResource,
  createHook: () => ({ enable() {}, disable() {} }),
  executionAsyncId: () => 1,
  triggerAsyncId: () => 0,
  executionAsyncResource: () => ({}),
};

class Channel extends EventEmitter {
  hasSubscribers = false;
  constructor(readonly name: string) {
    super();
  }
  publish() {}
  subscribe() {}
  unsubscribe() {
    return false;
  }
  bindStore() {}
  unbindStore() {}
  runStores<R>(_data: unknown, fn: (...a: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return fn.apply(thisArg, args);
  }
}

export const diagnostics_channel = {
  channel: (name: string) => new Channel(name),
  hasSubscribers: () => false,
  subscribe() {},
  unsubscribe: () => false,
  tracingChannel: (name: string) => ({ start: new Channel(name + ":start"), end: new Channel(name + ":end"), asyncStart: new Channel(name + ":asyncStart"), asyncEnd: new Channel(name + ":asyncEnd"), error: new Channel(name + ":error"), hasSubscribers: false, subscribe() {}, unsubscribe: () => false, traceSync: <R>(fn: (...a: unknown[]) => R, _ctx?: unknown, thisArg?: unknown, ...args: unknown[]) => fn.apply(thisArg, args), tracePromise: <R>(fn: (...a: unknown[]) => R, _ctx?: unknown, thisArg?: unknown, ...args: unknown[]) => fn.apply(thisArg, args), traceCallback: <R>(fn: (...a: unknown[]) => R, _pos?: unknown, _ctx?: unknown, thisArg?: unknown, ...args: unknown[]) => fn.apply(thisArg, args) }),
  Channel,
};
