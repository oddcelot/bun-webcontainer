import assert from "./assert";
import buffer from "./buffer";
import crypto from "./crypto";
import diagnostics_channel from "./diagnosticsChannel";
import { async_hooks, cluster, dgram, dns, http2, repl, tls, trace_events } from "./stubs";
import wasi from "./wasi";
import domain from "./domain";
import inspector, { inspectorPromises } from "./inspector";
import v8 from "./v8";
import vm from "./vm";
import events from "./events";
import fs from "./fs";
import http, { https } from "./http";
import net from "./net";
import sqlite from "./sqlite";
import nodeSqlite from "./nodeSqlite";
import test from "./test";
import nodeTest from "./nodeTest";
import ws from "./ws";
import { createModule } from "./module";
import { codeError } from "./errors";
import os from "./os";
import path from "./path";
import perf_hooks from "./perf_hooks";
import process from "./process";
import punycode from "./punycode";
import readline, { promises as readlinePromises } from "./readline";
import querystring from "./querystring";
import stream, { promises as streamPromises } from "./stream";
import string_decoder from "./string_decoder";
import timers, { promises as timersPromises } from "./timers";
import tty from "./tty";
import url from "./url";
import util from "./util";
import worker_threads from "./worker_threads";
import child_process from "./child_process";
import zlib from "./zlib";
import { withBrotliZstd } from "../compress";

/** node:stream/web re-exports the web stream classes, which are globals here. */
const streamWeb = Object.fromEntries(
  "ReadableStream ReadableStreamDefaultReader ReadableStreamBYOBReader ReadableStreamBYOBRequest ReadableByteStreamController ReadableStreamDefaultController TransformStream TransformStreamDefaultController WritableStream WritableStreamDefaultWriter WritableStreamDefaultController ByteLengthQueuingStrategy CountQueuingStrategy TextEncoderStream TextDecoderStream CompressionStream DecompressionStream"
    .split(" ")
    .map((k) => [k, (globalThis as Record<string, unknown>)[k]])
    .filter(([, v]) => v !== undefined),
);

// CompressionStream and DecompressionStream, with "brotli" and "zstd" too (compress.ts); the worker installs these as globals.
export const compressionStreams: Record<string, unknown> = {};
if (typeof CompressionStream !== "undefined") compressionStreams.CompressionStream = streamWeb.CompressionStream = withBrotliZstd(CompressionStream, true);
if (typeof DecompressionStream !== "undefined") compressionStreams.DecompressionStream = streamWeb.DecompressionStream = withBrotliZstd(DecompressionStream, false);

/** What `Bun` has; runtime.ts types the global against this list. */
export const BUN_NAMES = ["version", "env", "gc", "main", "argv", "stdout", "stderr", "stdin", "inspect", "deepEquals", "escapeHTML", "which", "spawn", "spawnSync", "sleep", "nanoseconds", "semver", "file", "write", "serve", "build", "CryptoHasher", "gzipSync", "gunzipSync", "deflateSync", "inflateSync", "zstdCompress", "zstdCompressSync", "zstdDecompress", "zstdDecompressSync", "hash", "Transpiler", "resolveSync", "resolve", "Glob", "YAML", "TOML", "JSONC", "JSON5", "password", "Cookie", "CookieMap", "sleepSync", "revision", "JSONL", "XML", "markdown", "$", "S3Client", "s3", "sql", "SQL", "randomUUIDv7", "FileSystemRouter", "plugin"] as const;
/** `import ... from "bun"`: the worker copies the `Bun` global in once it exists; the page only needs the names. */
const bun: Record<string, unknown> = Object.fromEntries(BUN_NAMES.map((k) => [k, undefined]));

/** node:constants, the deprecated module: os.constants' groups, then fs's and crypto's, flattened as in Node and Bun. */
const constants = { ...os.constants.dlopen, ...os.constants.errno, ...os.constants.priority, ...os.constants.signals, ...fs.constants, ...(crypto as { constants: object }).constants };

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
  dgram,
  diagnostics_channel,
  dns,
  "dns/promises": dns.promises as object,
  domain,
  events,
  fs,
  "fs/promises": fs.promises,
  http,
  http2,
  https,
  inspector,
  "inspector/promises": inspectorPromises,
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
  "readline/promises": readlinePromises,
  repl,
  stream,
  "stream/promises": streamPromises,
  "stream/web": streamWeb,
  string_decoder,
  sys: util,
  timers,
  "timers/promises": timersPromises,
  tls,
  trace_events,
  tty,
  url,
  util,
  "util/types": util.types,
  v8,
  vm,
  wasi,
  bun,
  sqlite: nodeSqlite,
  "bun:sqlite": sqlite,
  test: nodeTest,
  "bun:test": test,
  "bun:ws": ws,
  worker_threads,
  zlib,
};
/** Built-ins with only a `node:` name, as in Bun: bare, `sqlite` and `test` are npm packages. */
export const NODE_PREFIXED = ["sqlite", "test"];

/** The key in `builtins` of specifier `spec` (`fs`, `node:fs`, `bun:sqlite`, `node:sqlite`), or undefined if it isn't one. */
export function builtinName(spec: string): string | undefined {
  const name = spec.startsWith("node:") ? spec.slice(5) : spec;
  if (!Object.hasOwn(builtins, name) || (name === spec && NODE_PREFIXED.includes(name))) return undefined;
  return name;
}

/**
 * Packages Bun serves from its own modules when they aren't installed (an installed one wins): the key in `builtins`
 * of `spec`, or undefined. Bun also has `undici`, `node-fetch` and others; the playground has only `ws`.
 */
export const bunFallback = (spec: string): string | undefined => (spec === "ws" ? "bun:ws" : undefined);

/** `require("module").builtinModules`: the `node:`-only ones with their prefix; Bun leaves out `node:test`. */
export const builtinModuleNames = () => Object.keys(builtins).filter((k) => k !== "test").map((k) => (NODE_PREFIXED.includes(k) ? `node:${k}` : k));

builtins.module = createModule(builtins, builtinName, builtinModuleNames, bunFallback);
/** `process.getBuiltinModule(id)`: what `require(id)` gives for a built-in (`node:` or not, `bun:*`), else undefined. */
process.getBuiltinModule = function getBuiltinModule(id: unknown) {
  if (typeof id !== "string") {
    const received = id === null ? "null" : id === undefined ? "undefined" : typeof id === "object" ? `an instance of ${id.constructor?.name ?? "Object"}` : `type ${typeof id} (${String(id)})`;
    throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "moduleName" argument must be of type string. Received ${received}`);
  }
  const name = builtinName(id);
  return name === undefined ? undefined : builtins[name];
};

export { setFs } from "./fs";
export { setRequire } from "./module";
export { setExit, setRawStdio, setStdio } from "./process";
export { installTimers } from "./timers";
export { installAsyncContext } from "./asyncHooks";

/** Names that can be `export const { name }` from a wrapper module. */
const RESERVED = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval".split(" "));
export const exportNames = (spec: string) => Object.keys(builtins[spec] ?? {}).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k));
