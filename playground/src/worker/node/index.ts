import assert from "./assert";
import buffer from "./buffer";
import crypto from "./crypto";
import { diagnostics_channel, async_hooks, child_process, cluster, constants, dns, http2, inspector, readline, tls, v8, vm, zlib } from "./stubs";
import events from "./events";
import fs from "./fs";
import http, { https } from "./http";
import net from "./net";
import ws from "./ws";
import { createModule } from "./module";
import os from "./os";
import path from "./path";
import perf_hooks from "./perf_hooks";
import process from "./process";
import querystring from "./querystring";
import stream, { promises as streamPromises } from "./stream";
import string_decoder from "./string_decoder";
import timers, { promises as timersPromises } from "./timers";
import tty from "./tty";
import url from "./url";
import util from "./util";
import worker_threads from "./worker_threads";

/** Node built-ins by specifier (without `node:`). Evaluating this must have no side effects: the page imports it for export names. */
export const builtins: Record<string, object> = {
  assert,
  "assert/strict": (assert as { strict?: object }).strict!,
  async_hooks,
  buffer,
  child_process,
  cluster,
  constants,
  crypto,
  diagnostics_channel,
  dns,
  "dns/promises": dns.promises as object,
  events,
  fs,
  "fs/promises": fs.promises,
  http,
  http2,
  https,
  inspector,
  module: undefined as unknown as object,
  net,
  os,
  path,
  "path/posix": path,
  perf_hooks,
  process,
  querystring,
  readline,
  "readline/promises": readline.promises as object,
  stream,
  "stream/promises": streamPromises,
  string_decoder,
  timers,
  "timers/promises": timersPromises,
  tls,
  tty,
  url,
  util,
  "util/types": util.types,
  v8,
  vm,
  "bun:ws": ws,
  worker_threads,
  zlib,
};
builtins.module = createModule(builtins);

export { setFs } from "./fs";
export { setStdio } from "./process";
export { installTimers } from "./timers";

/** Names that can be `export const { name }` from a wrapper module. */
const RESERVED = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval".split(" "));
export const exportNames = (spec: string) => Object.keys(builtins[spec] ?? {}).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k));
