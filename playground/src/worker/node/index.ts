import assert from "./assert";
import buffer from "./buffer";
import crypto from "./crypto";
import { diagnostics_channel, async_hooks, child_process, cluster, constants, dns, http2, inspector, readline, tls, v8, vm } from "./stubs";
import events from "./events";
import fs from "./fs";
import http, { https } from "./http";
import net from "./net";
import sqlite from "./sqlite";
import test from "./test";
import ws from "./ws";
import { createModule } from "./module";
import os from "./os";
import path from "./path";
import perf_hooks from "./perf_hooks";
import process from "./process";
import punycode from "./punycode";
import querystring from "./querystring";
import stream, { promises as streamPromises } from "./stream";
import string_decoder from "./string_decoder";
import timers, { promises as timersPromises } from "./timers";
import tty from "./tty";
import url from "./url";
import util from "./util";
import worker_threads from "./worker_threads";
import zlib from "./zlib";

/** node:stream/web re-exports the web stream classes, which are globals here. */
const streamWeb = Object.fromEntries(
  "ReadableStream ReadableStreamDefaultReader ReadableStreamBYOBReader ReadableStreamBYOBRequest ReadableByteStreamController ReadableStreamDefaultController TransformStream TransformStreamDefaultController WritableStream WritableStreamDefaultWriter WritableStreamDefaultController ByteLengthQueuingStrategy CountQueuingStrategy TextEncoderStream TextDecoderStream CompressionStream DecompressionStream"
    .split(" ")
    .map((k) => [k, (globalThis as Record<string, unknown>)[k]])
    .filter(([, v]) => v !== undefined),
);

/** What `Bun` has; runtime.ts types the global against this list. */
export const BUN_NAMES = ["version", "env", "gc", "main", "argv", "stdout", "stderr", "inspect", "deepEquals", "escapeHTML", "which", "sleep", "nanoseconds", "semver", "file", "write", "serve", "build", "CryptoHasher", "gzipSync", "gunzipSync", "deflateSync", "inflateSync"] as const;
/** `import ... from "bun"`: the worker copies the `Bun` global in once it exists; the page only needs the names. */
const bun: Record<string, unknown> = Object.fromEntries(BUN_NAMES.map((k) => [k, undefined]));

/** Node built-ins by specifier (without `node:`). Evaluating this must have no side effects: the page imports it for export names. */
export const builtins: Record<string, object> = {
  assert,
  "assert/strict": (assert as { strict?: object }).strict!,
  async_hooks,
  buffer,
  child_process,
  cluster,
  console: globalThis.console,
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
  punycode,
  querystring,
  readline,
  "readline/promises": readline.promises as object,
  stream,
  "stream/promises": streamPromises,
  "stream/web": streamWeb,
  string_decoder,
  sys: util,
  timers,
  "timers/promises": timersPromises,
  tls,
  tty,
  url,
  util,
  "util/types": util.types,
  v8,
  vm,
  bun,
  "bun:sqlite": sqlite,
  "bun:test": test,
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
