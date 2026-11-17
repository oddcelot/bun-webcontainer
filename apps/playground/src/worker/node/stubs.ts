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
export const v8 = stubModule("v8", "getHeapStatistics getHeapSpaceStatistics getHeapSnapshot writeHeapSnapshot serialize deserialize setFlagsFromString cachedDataVersionTag");
export const inspector = stubModule("inspector", "open close url waitForDebugger Session", { console });
export const cluster = stubModule("cluster", "fork disconnect setupPrimary setupMaster Worker", { isPrimary: true, isMaster: true, isWorker: false, workers: {}, settings: {} });

export const constants = {};

export { async_hooks } from "./asyncHooks";
