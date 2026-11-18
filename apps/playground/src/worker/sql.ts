// `Bun.sql` / `SQL` (from "bun"): Bun's SQL client, with Postgres on PGlite (Postgres compiled to wasm) and SQLite on bun:sqlite.
//
// There is no network Postgres in a browser, so a `postgres://` URL (any host) names a database that lives in the tab:
// one PGlite instance per database name, started on the first query (its wasm and data files, 5.4 MB gzipped, are fetched
// then and never at boot). `pglite://<name>` is the playground-only spelling of the same, and `pglite://:memory:` a database
// that isn't kept. A database is kept in the project's VFS, in `.runbun/pglite/<name>.tar.zst`: PGlite's data directory
// as a tar (written by `snapshot`, which is synchronous: the worker may be stopped right after `process.exit`), zstd
// compressed. Postgres recovers from the write-ahead log on load, so a snapshot taken between checkpoints is sound.
//
// Everything on one connection: `reserve()` returns the same one, and a query made through `sql` while a transaction is open
// runs inside it (native Bun would use another connection of its pool). Transactions don't overlap each other.
//
// Results follow Bun's: an array of row objects with `count`, `command`, `lastInsertRowid` and `affectedRows`, int8
// as a string (BigInt with `bigint: true`), bytea as a Buffer, timestamps as Dates (UTC), JSON parsed. Parameters are
// sent as parameters, typed as Bun types them (booleans, integers, floats, bytea; strings and everything else are left
// for Postgres to infer), and the helpers (`sql(object)`, `sql(array)`) expand where Bun's do: after INSERT, SET and IN.
import type { PGlite, QueryOptions, Results } from "@electric-sql/pglite";
import pgliteWasm from "@electric-sql/pglite/pglite.wasm?url";
import initdbWasm from "@electric-sql/pglite/initdb.wasm?url";
import pgliteData from "@electric-sql/pglite/pglite.data?url";
import { holdUntil, quietTimeout } from "./loop";
import { Buffer } from "./node/buffer";
import fs from "./node/fs";
import path from "./node/path";
import process, { env as processEnv } from "./node/process";
import { Database as SqliteDatabase, SQLiteError, handleOf } from "./node/sqlite";
import { zstdCompress, zstdDecompress } from "./compress";

// --- errors ---------------------------------------------------------------------------------------------------------

export class SQLError extends Error {
  override name = "SQLError";
  code?: string;
}

/** What a Postgres error carries (PGlite's DatabaseError fields), plus Bun's `code` and `errno` (the SQLSTATE). */
const PG_FIELDS = ["severity", "detail", "hint", "position", "internalPosition", "internalQuery", "where", "schema", "table", "column", "dataType", "constraint", "file", "line", "routine"] as const;

export class PostgresError extends SQLError {
  override name = "PostgresError";
  errno?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  position?: string;
  internalPosition?: string;
  internalQuery?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  file?: string;
  line?: string;
  routine?: string;
  constructor(message: string, code = "ERR_POSTGRES_SERVER_ERROR", errno?: string) {
    super(message);
    this.code = code;
    if (errno !== undefined) this.errno = errno;
  }
}

export class MySQLError extends SQLError {
  override name = "MySQLError";
  constructor(message: string, code = "ERR_MYSQL_UNSUPPORTED") {
    super(message);
    this.code = code;
  }
}

const fromPg = (e: unknown): unknown => {
  const o = e as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.severity !== "string" || typeof o.code !== "string" || !(e instanceof Error)) return e;
  const err = new PostgresError(e.message, o.code === "42601" ? "ERR_POSTGRES_SYNTAX_ERROR" : "ERR_POSTGRES_SERVER_ERROR", o.code);
  for (const k of PG_FIELDS) if (o[k] !== undefined && o[k] !== "") (err as unknown as Record<string, unknown>)[k] = o[k];
  return err;
};

const closedError = () => new PostgresError("Connection closed", "ERR_POSTGRES_CONNECTION_CLOSED");
const unsupported = (what: string) => new SQLError(`${what} isn't supported in the browser`);

// --- results --------------------------------------------------------------------------------------------------------

/** What every query resolves to: the rows, with the command's `count`, `command` tag, `lastInsertRowid` and `affectedRows`. */
export class SQLResultArray<T = unknown> extends Array<T> {
  count = 0;
  command = "";
  lastInsertRowid: number | bigint | null = null;
  affectedRows = 0;
}

function result(rows: unknown[], count: number, command: string, affectedRows: number, lastInsertRowid: number | bigint | null = null): SQLResultArray {
  const out = new SQLResultArray();
  for (let i = 0; i < rows.length; i++) out[i] = rows[i];
  out.count = count;
  out.command = command;
  out.lastInsertRowid = lastInsertRowid;
  out.affectedRows = affectedRows;
  return out;
}

const OBJECTS = 0;
const VALUES = 1;
const RAW = 2;
type Mode = typeof OBJECTS | typeof VALUES | typeof RAW;

/** Postgres' command tag: PGlite reports its first word only (`CREATE`), Bun the whole tag (`CREATE TABLE`). */
function commandTag(first: string, text: string): string {
  if (first === "TRUNCATE") return "TRUNCATE TABLE";
  if (first !== "CREATE" && first !== "DROP" && first !== "ALTER") return first;
  const words = text
    .replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " ")
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((w) => w.toUpperCase());
  const modifiers = new Set(["OR", "REPLACE", "TEMP", "TEMPORARY", "UNIQUE", "UNLOGGED", "GLOBAL", "LOCAL", "CONCURRENTLY", "TRUSTED", "PROCEDURAL"]);
  const rest = words.filter((w, i) => !(modifiers.has(w) && words.slice(0, i).every((p) => modifiers.has(p))));
  const [a, b] = rest;
  if (!a) return first;
  if ((a === "MATERIALIZED" && b === "VIEW") || (a === "FOREIGN" && b === "TABLE") || (a === "EVENT" && b === "TRIGGER")) return `${first} ${a} ${b}`;
  return `${first} ${a}`;
}

// --- parameters -----------------------------------------------------------------------------------------------------

/** `sql(value, ...columns)`: expands by where it stands (see `part`), or quotes an identifier when it is a string. */
class Helper {
  constructor(
    readonly value: unknown,
    readonly columns: string[],
  ) {}
}

/** `sql.array(values, type)`: one Postgres array parameter. */
class ArrayParam {
  constructor(
    readonly values: unknown[],
    readonly type?: string,
  ) {}
}

/** `sql.json(value)`: one JSON parameter. */
class JsonParam {
  constructor(readonly value: unknown) {}
}

const OID = { bool: 16, bytea: 17, int8: 20, int4: 23, text: 25, json: 114, float8: 701, varchar: 1043, timestamp: 1114, timestamptz: 1184, jsonb: 3802 };

const quoteIdent = (name: string) =>
  name
    .split(".")
    .map((p) => (p === "*" ? p : `"${p.replaceAll('"', '""')}"`))
    .join(".");

/** An array parameter's text form, `{"a","b"}`. */
function arrayLiteral(values: unknown[]): string {
  const item = (v: unknown): string => {
    if (v === null || v === undefined) return "NULL";
    if (Array.isArray(v)) return arrayLiteral(v);
    let s: string;
    if (v instanceof Date) s = v.toISOString();
    else if (v instanceof Uint8Array) s = "\\x" + Buffer.from(v).toString("hex");
    else if (v instanceof JsonParam) s = JSON.stringify(v.value);
    else if (typeof v === "object") s = JSON.stringify(v);
    else s = String(v);
    return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  };
  return `{${values.map(item).join(",")}}`;
}

function inferElementType(values: unknown[]): string {
  const v = values.find((x) => x !== null && x !== undefined);
  if (typeof v === "number") return Number.isInteger(v) ? "INT" : "FLOAT8";
  if (typeof v === "bigint") return "BIGINT";
  if (typeof v === "boolean") return "BOOL";
  if (v instanceof Date) return "TIMESTAMPTZ";
  if (v instanceof Uint8Array) return "BYTEA";
  if (v !== undefined && typeof v === "object") return "JSONB";
  return "TEXT";
}

/** The SQL text and parameters a template builds. `types` has a Postgres type OID per parameter (0: let Postgres infer). */
interface Built {
  text: string;
  params: unknown[];
  types: number[];
}

/** Turns `value` into the parameter Postgres is sent, with the type Bun sends it as. */
function param(value: unknown): [unknown, number] {
  if (value === undefined || value === null) return [null, 0];
  switch (typeof value) {
    case "boolean":
      return [value, OID.bool];
    case "bigint":
      return [value.toString(), OID.int8];
    case "number":
      if (Number.isSafeInteger(value)) return [value, value >= -(2 ** 31) && value < 2 ** 31 ? OID.int4 : OID.int8];
      return [value, OID.float8];
    case "string":
      return [value, 0];
  }
  if (value instanceof Date) return [value.toISOString(), 0];
  if (value instanceof Uint8Array) return [value, OID.bytea];
  if (value instanceof ArrayBuffer) return [new Uint8Array(value), OID.bytea];
  if (Array.isArray(value)) return [arrayLiteral(value), 0];
  return [value, 0]; // objects: the serializers below (JSON)
}

interface Dialect {
  /** The placeholder of the n-th parameter (1-based). */
  placeholder(n: number): string;
  /** Postgres can type parameters and take arrays; SQLite binds values as they are. */
  pg: boolean;
}
const PG: Dialect = { placeholder: (n) => `$${n}`, pg: true };
const LITE: Dialect = { placeholder: () => "?", pg: false };

function addParam(b: Built, d: Dialect, value: unknown): string {
  if (d.pg) {
    const [v, t] = param(value);
    b.params.push(v);
    b.types.push(t);
  } else b.params.push(value instanceof Date ? value.toISOString() : value === undefined ? null : value);
  return d.placeholder(b.params.length);
}

const HELPERS = "Helpers are only allowed for INSERT, UPDATE and IN commands";

/** What a `sql(...)` helper turns into, by the SQL before it: `insert into t ${..}`, `set ${..}` or `in ${..}`. */
function helper(b: Built, d: Dialect, h: Helper): string {
  const v = h.value;
  if (typeof v === "string") return quoteIdent(v);
  const before = b.text.replace(/\s+$/, "");
  const insert = /\binsert\s+(or\s+\w+\s+)?into\s+("(?:[^"]|"")+"|[^\s(]+)(\s+as\s+\w+)?$/i.test(before);
  const update = /\bset$/i.test(before);
  const inList = /\bin$/i.test(before);
  const keysOf = (o: Record<string, unknown>) => (h.columns.length ? h.columns : Object.keys(o).filter((k) => o[k] !== undefined));
  if (insert) {
    const rows = (Array.isArray(v) ? v : [v]) as Record<string, unknown>[];
    if (!rows.length || rows.some((r) => r === null || typeof r !== "object")) throw new SyntaxError("Helper insert needs an object or an array of objects");
    const cols = keysOf(rows[0]);
    const values = rows.map((r) => `(${cols.map((c) => (r[c] === undefined && d.pg ? "DEFAULT" : addParam(b, d, r[c]))).join(", ")})`);
    return `(${cols.map(quoteIdent).join(", ")}) VALUES ${values.join(", ")}`;
  }
  if (update) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new SyntaxError("Helper update needs an object");
    const o = v as Record<string, unknown>;
    const cols = keysOf(o);
    if (!cols.length) throw new SyntaxError("Helper update needs at least one column");
    return cols.map((c) => `${quoteIdent(c)} = ${addParam(b, d, o[c])}`).join(", ");
  }
  if (inList) {
    if (!Array.isArray(v)) throw new SyntaxError(HELPERS);
    const items = h.columns.length ? v.map((o) => (o as Record<string, unknown>)[h.columns[0]]) : v;
    if (!items.length) return "(NULL)";
    return `(${items.map((x) => addParam(b, d, x)).join(", ")})`;
  }
  throw new SyntaxError(HELPERS);
}

/** Appends one template's strings and values to `b`: nested queries are inlined, helpers expanded, the rest are parameters. */
function render(b: Built, d: Dialect, strings: readonly string[], values: readonly unknown[]) {
  for (let i = 0; i < strings.length; i++) {
    b.text += strings[i];
    if (i >= values.length) break;
    const v = values[i];
    if (v instanceof Query) {
      if (v.template) render(b, d, v.template.strings, v.template.values);
      else if (v.built && !v.built.params.length) b.text += v.built.text;
      else throw new SQLError("Only a query made with a template can be put into another");
    } else if (v instanceof Helper) b.text += helper(b, d, v);
    else if (v instanceof ArrayParam) {
      if (!d.pg) throw unsupported("sql.array on SQLite");
      const type = (v.type ?? inferElementType(v.values)).toUpperCase();
      b.params.push(arrayLiteral(v.values));
      b.types.push(0);
      b.text += `${d.placeholder(b.params.length)}::${type}[]`;
    } else if (v instanceof JsonParam) {
      b.params.push(d.pg ? new JsonText(JSON.stringify(v.value)) : JSON.stringify(v.value));
      b.types.push(0);
      b.text += d.placeholder(b.params.length);
    } else b.text += addParam(b, d, v);
  }
}

/** A JSON text a parameter stands for (`sql.json`): the serializers send it as it is, not as a JSON string. */
class JsonText {
  constructor(readonly text: string) {}
  toString() {
    return this.text;
  }
}

// --- the query ------------------------------------------------------------------------------------------------------

/** What runs a query: Postgres on PGlite, or SQLite. */
interface Driver {
  dialect: Dialect;
  run(b: Built, mode: Mode, simple: boolean, bigint: boolean): Promise<SQLResultArray | SQLResultArray[]>;
}

/** A query: lazy, it runs when awaited (or `.execute()`d), and can be put inside another template instead. */
export class Query implements PromiseLike<SQLResultArray> {
  private mode: Mode = OBJECTS;
  private isSimple = false;
  private promise?: Promise<SQLResultArray>;
  built?: Built;
  constructor(
    private run: (q: Query) => Promise<SQLResultArray | SQLResultArray[]>,
    readonly template?: { strings: readonly string[]; values: readonly unknown[] },
    built?: Built,
  ) {
    this.built = built;
  }
  get modeValue() {
    return this.mode;
  }
  get simpleValue() {
    return this.isSimple;
  }
  values() {
    this.mode = VALUES;
    return this;
  }
  raw() {
    this.mode = RAW;
    return this;
  }
  simple() {
    this.isSimple = true;
    return this;
  }
  cancel() {
    return this;
  }
  execute() {
    this.start();
    return this;
  }
  private start(): Promise<SQLResultArray> {
    return (this.promise ??= (async () => (await this.run(this)) as SQLResultArray)());
  }
  then<A = SQLResultArray, B = never>(ok?: ((v: SQLResultArray) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.start().then(ok, err);
  }
  catch<B = never>(err?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<SQLResultArray | B> {
    return this.start().catch(err);
  }
  finally(fn?: (() => void) | null): Promise<SQLResultArray> {
    return this.start().finally(fn);
  }
}

// --- Postgres on PGlite ---------------------------------------------------------------------------------------------

const FLUSH_MS = 1000;
const DIR = ".runbun/pglite";

interface Loaded {
  PGlite: typeof PGlite;
  pg: WebAssembly.Module;
  initdb: WebAssembly.Module;
  data: Blob;
}
let loaded: Promise<Loaded> | undefined;

const asUrl = (u: string) => new URL(u, location.href).href;

async function compile(url: string): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(asUrl(url)));
  } catch {
    // A server that doesn't send application/wasm.
    const res = await fetch(asUrl(url));
    if (!res.ok) throw new Error(`failed to load ${url}: HTTP ${res.status}`);
    return WebAssembly.compile(await res.arrayBuffer());
  }
}

/** The PGlite package and its three binary files, fetched once, on the first query. */
function loadPglite(): Promise<Loaded> {
  return (loaded ??= Promise.all([
    import("@electric-sql/pglite"),
    compile(pgliteWasm),
    compile(initdbWasm),
    fetch(asUrl(pgliteData)).then(async (r) => {
      if (!r.ok) throw new Error(`failed to load pglite.data: HTTP ${r.status}`);
      return r.blob();
    }),
  ]).then(([mod, pg, initdb, data]) => ({ PGlite: mod.PGlite, pg, initdb, data })));
}

// A minimal tar (ustar) writer over PGlite's Emscripten filesystem: the same format `dumpDataDir()` makes and
// `loadDataDir` reads, but synchronous.
interface EmFS {
  readdir(p: string): string[];
  stat(p: string): { mode: number; mtime: Date };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  readFile(p: string, o: { encoding: "binary" }): Uint8Array;
}

function tar(FS: EmFS, root: string): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const header = (name: string, size: number, dir: boolean, mode: number, mtime: number) => {
    const h = new Uint8Array(512);
    const put = (s: string, at: number, len: number) => h.set(enc.encode(s).subarray(0, len), at);
    const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
    put(name, 0, 100);
    put(oct(mode & 0o7777, 8), 100, 8);
    put(oct(0, 8), 108, 8);
    put(oct(0, 8), 116, 8);
    put(oct(size, 12), 124, 12);
    put(oct(mtime, 12), 136, 12);
    put("        ", 148, 8);
    h[156] = dir ? 53 : 48;
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const b of h) sum += b;
    put(oct(sum, 7) + " ", 148, 8);
    return h;
  };
  const walk = (dir: string) => {
    for (const n of FS.readdir(dir)) {
      if (n === "." || n === "..") continue;
      const p = `${dir}/${n}`;
      const st = FS.stat(p);
      const rel = p.slice(root.length + 1);
      const mtime = Math.floor(st.mtime.getTime() / 1000);
      if (FS.isDir(st.mode)) {
        parts.push(header(`${rel}/`, 0, true, st.mode, mtime));
        walk(p);
      } else if (FS.isFile(st.mode)) {
        const data = FS.readFile(p, { encoding: "binary" });
        parts.push(header(rel, data.length, false, st.mode, mtime), data, new Uint8Array((512 - (data.length % 512)) % 512));
      }
    }
  };
  walk(root);
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The parsers every query gets (Bun's types: int8 a string or BigInt, bytea a Buffer, timestamps in UTC), and the raw ones. */
function parsers(bigint: boolean, pg: PGlite, raw: boolean): Record<number, (v: string) => unknown> {
  const stock = (pg as unknown as { parsers: Record<number, (v: string) => unknown> }).parsers;
  if (raw) {
    // Text as it comes, but bytea's bytes: `.raw()` gives each value as a Buffer.
    const out: Record<number, (v: string) => unknown> = {};
    for (const k of Object.keys(stock)) out[+k] = (v) => v;
    out[OID.bytea] = stock[OID.bytea];
    return out;
  }
  return {
    [OID.int8]: bigint ? (v: string) => BigInt(v) : (v: string) => v,
    [OID.bytea]: (v: string) => Buffer.from(stock[OID.bytea](v) as Uint8Array),
    // PGlite reads a timestamp without a zone in the local zone; Postgres' value is the same wall clock, taken as UTC.
    [OID.timestamp]: (v: string) => new Date(v.replace(" ", "T") + "Z"),
  };
}

const textSerializer = (v: unknown) => (v instanceof JsonText ? v.text : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
const jsonSerializer = (v: unknown) => (v instanceof JsonText ? v.text : JSON.stringify(v));
const SERIALIZERS = { [OID.text]: textSerializer, [OID.varchar]: textSerializer, [OID.json]: jsonSerializer, [OID.jsonb]: jsonSerializer };

const isWrite = (sql: string) => !/^\s*(select|show|explain|values|set|begin|start|commit|end|rollback|savepoint|release)\b/i.test(sql);

/** One database: a PGlite instance (shared by every `SQL` that names it), and where it is kept. */
class PgDb {
  pg?: PGlite;
  ready?: Promise<PGlite>;
  refs = 0;
  private dirty = false;
  private inTx = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The VFS key of the snapshot; undefined for `:memory:`. */
  readonly file: string | undefined;
  private txTail: Promise<unknown> = Promise.resolve();
  closing?: Promise<void>;

  constructor(readonly name: string) {
    this.file = name === ":memory:" ? undefined : path.resolve(process.cwd(), DIR, `${encodeURIComponent(name)}.tar.zst`);
  }

  open(): Promise<PGlite> {
    return (this.ready ??= holdUntil(this.boot()));
  }

  private async boot(): Promise<PGlite> {
    await this.closing;
    const lib = await loadPglite();
    let loadDataDir: Blob | undefined;
    if (this.file && fs.existsSync(this.file)) {
      const packed = fs.readFileSync(this.file) as Uint8Array;
      const raw = zstdDecompress(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
      if (typeof raw === "number") throw new SQLError(`${this.file} is damaged (zstd error ${raw}): delete it to start over with an empty database`);
      loadDataDir = new Blob([raw as BlobPart], { type: "application/x-tar" });
    }
    this.pg = new lib.PGlite({ pgliteWasmModule: lib.pg, initdbWasmModule: lib.initdb, fsBundle: lib.data, loadDataDir });
    await this.pg.waitReady;
    openDbs.add(this);
    return this.pg;
  }

  /** Runs one statement or, without parameters, `text` as a simple query (any number of statements). */
  async query(b: Built, mode: Mode, simple: boolean, bigint: boolean): Promise<SQLResultArray | SQLResultArray[]> {
    const pg = await this.open();
    const opts: QueryOptions = { rowMode: mode === OBJECTS ? "object" : "array", parsers: parsers(bigint, pg, mode === RAW), serializers: SERIALIZERS };
    if (b.types.some(Boolean)) opts.paramTypes = b.types;
    const shape = (r: Results, text: string): SQLResultArray => {
      let rows: unknown[] = r.rows;
      if (mode === RAW) {
        rows = (rows as unknown[][]).map((row) => row.map((v) => (v === null || v === undefined ? null : v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v)))));
      }
      const command = commandTag((r as unknown as { command?: string }).command ?? "", text);
      const dml = command === "INSERT" || command === "UPDATE" || command === "DELETE" || command === "MERGE";
      const affected = r.affectedRows ?? 0;
      return result(rows, dml ? affected : command === "SELECT" || r.fields.length ? rows.length : affected, command, dml ? affected : 0);
    };
    try {
      let out: SQLResultArray | SQLResultArray[];
      if (!b.params.length) {
        const rs = await pg.exec(b.text, opts);
        // Statements as `text` splits them: the tags tell which is which, and the text of each only matters for DDL's tag.
        const parts = rs.length > 1 ? splitStatements(b.text) : [b.text];
        const all = rs.map((r, i) => shape(r, parts[i] ?? b.text));
        out = all.length === 1 ? all[0] : all;
      } else out = shape(await pg.query(b.text, b.params, opts), b.text);
      if (isWrite(b.text)) this.touch();
      this.note(b.text);
      return out;
    } catch (e) {
      throw fromPg(e);
    }
  }

  /** `fn` once any transaction before it has ended. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.txTail;
    let end!: () => void;
    this.txTail = new Promise<void>((r) => (end = r));
    await prev;
    try {
      return await fn();
    } finally {
      end();
    }
  }

  private note(sql: string) {
    if (/^\s*(begin|start)\b/i.test(sql)) this.inTx = true;
    else if (/^\s*(commit|end|rollback)\b(?!\s+(transaction\s+)?to\b)/i.test(sql)) this.inTx = false;
  }

  private touch() {
    if (!this.file) return;
    this.dirty = true;
    this.timer ??= quietTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Writes the data directory to the VFS now (synchronously: nothing may run between a `process.exit` and the worker's end). */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file || !this.dirty || !this.pg) return;
    if (this.inTx) return void this.touch();
    this.dirty = false;
    const FS = (this.pg as unknown as { mod: { FS: EmFS } }).mod.FS;
    const bytes = zstdCompress(tar(FS, "/pglite/data"), 3);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, bytes);
  }

  async release() {
    if (--this.refs > 0) return;
    this.flush();
    const pg = this.pg;
    dbs.delete(this.name);
    openDbs.delete(this);
    this.closing = pg ? pg.close().catch(() => {}) : Promise.resolve();
    await this.closing;
  }
}

const dbs = new Map<string, PgDb>();
/** Databases started: written back by flushSql. */
const openDbs = new Set<PgDb>();

/** Writes every kept database back now (the runtime calls this as the program ends, and when the page is about to stop it). */
export function flushSql() {
  for (const db of openDbs) db.flush();
}

function acquire(name: string): PgDb {
  let db = dbs.get(name);
  if (!db) dbs.set(name, (db = new PgDb(name)));
  db.refs++;
  return db;
}

// --- SQLite ---------------------------------------------------------------------------------------------------------

/** bun:sqlite behind the same `Driver`, opened on the first query. */
function liteDriver(filename: string, bigint: boolean): Driver & { close(): void } {
  let db: SqliteDatabase | undefined;
  const open = async () => {
    if (db) return db;
    await (globalThis as unknown as { __loadBunSqlite(): Promise<void> }).__loadBunSqlite();
    return (db = new SqliteDatabase(filename, { safeIntegers: bigint }));
  };
  return {
    dialect: LITE,
    async run(b, mode) {
      const d = await open();
      const word = (/^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(\w+)/.exec(b.text)?.[1] ?? "").toUpperCase();
      const returning = /\breturning\b/i.test(b.text);
      const reads = returning || ["SELECT", "PRAGMA", "WITH", "VALUES", "EXPLAIN"].includes(word);
      const command = word === "WITH" ? "SELECT" : commandTag(word, b.text);
      if (!reads) {
        const r = d.query(b.text).run(...b.params);
        return result([], r.changes, command, r.changes, r.lastInsertRowid);
      }
      const stmt = d.query(b.text);
      const rows = (mode === OBJECTS ? stmt.all(...b.params) : stmt.values(...b.params)) as unknown[];
      const id = returning ? handleOf(d).conn.lastInsertRowid() : undefined;
      return result(rows, rows.length, command, returning ? rows.length : 0, id === undefined ? null : bigint ? id : Number(id));
    },
    close() {
      db?.close();
      db = undefined;
    },
  };
}

// --- the SQL object -------------------------------------------------------------------------------------------------

type Adapter = "postgres" | "sqlite" | "mysql" | "mariadb";

interface SQLOptions {
  url?: string | URL;
  adapter?: Adapter;
  hostname?: string;
  host?: string;
  port?: number | string;
  username?: string;
  user?: string;
  password?: string;
  database?: string;
  db?: string;
  path?: string;
  filename?: string;
  bigint?: boolean;
  max?: number;
  [k: string]: unknown;
}

/** Splits `text` into statements at top-level semicolons (outside quotes and comments), for the DDL tags of a multi-statement query. */
function splitStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      i = close < 0 ? text.length : close + 1;
    } else if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (c === ";") {
      out.push(text.slice(start, i));
      start = ++i;
    } else i++;
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out;
}

const env = (): Record<string, string | undefined> => processEnv;

const SUPPORTED = 'Supported adapters: "postgres", "sqlite", "mysql", "mariadb"';

const ENV_URLS: Record<Adapter, string[]> = {
  postgres: ["POSTGRES_URL", "PGURL", "PG_URL", "TLS_POSTGRES_DATABASE_URL"],
  mysql: ["MYSQL_URL", "TLS_MYSQL_DATABASE_URL"],
  mariadb: ["MARIADB_URL", "TLS_MARIADB_DATABASE_URL"],
  sqlite: ["SQLITE_URL"],
};

/** The connection Bun picks when nothing says otherwise: the URL variables in Bun's order, else the PG* ones. */
function fromEnv(adapter?: Adapter): SQLOptions {
  const e = env();
  const names = ["DATABASE_URL", "TLS_DATABASE_URL", ...(adapter ? ENV_URLS[adapter] : Object.values(ENV_URLS).flat())];
  const url = names.map((n) => e[n]).find(Boolean);
  if (url) return { url };
  const username = e.PGUSER || e.USER || e.USERNAME || "postgres";
  return { hostname: e.PGHOST || "localhost", port: Number(e.PGPORT) || 5432, username, password: e.PGPASSWORD || "", database: e.PGDATABASE || username };
}

interface Config {
  adapter: Adapter;
  /** The database's name (Postgres), or the file (SQLite). */
  name: string;
  options: Record<string, unknown>;
}

const PROTOCOLS: Record<string, Adapter> = { postgres: "postgres", postgresql: "postgres", sqlite: "sqlite", file: "sqlite", mysql: "mysql", mysql2: "mysql", mariadb: "mariadb" };

function configure(input: string | URL | SQLOptions | undefined, extra?: SQLOptions): Config {
  let o: SQLOptions = typeof input === "string" || input instanceof URL ? { ...extra, url: input } : { ...extra, ...input };
  const names = o.url !== undefined || o.hostname || o.host || o.path || o.filename || o.database || o.db;
  if (!names) o = { ...fromEnv(o.adapter), ...o };
  let adapter = o.adapter;
  let name: string | undefined;
  const url = o.url === undefined ? undefined : String(o.url);
  const pglite = url && /^pglite:(?:\/\/)?([^?#]*)/i.exec(url);
  if (pglite) {
    adapter = "postgres";
    name = decodeURIComponent(pglite[1].replace(/^\/+/, "")) || "postgres";
  } else if (url) {
    const proto = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
    if (url === ":memory:" || (!proto && /\.(db|sqlite3?)$/i.test(url))) {
      adapter = "sqlite";
      name = url;
    } else {
      if (!proto) throw new TypeError(`Invalid URL '${url}'`);
      const found = PROTOCOLS[proto];
      if (!found) throw new Error(`Unsupported protocol: ${proto}. ${SUPPORTED}`);
      adapter = found;
      if (found === "sqlite") name = decodeURIComponent(url.replace(/^(sqlite|file):(\/\/)?/i, "").replace(/[?#].*$/, "")) || ":memory:";
      else {
        const u = new URL(url.replace(/^postgresql:/i, "postgres:"));
        o = { ...o, hostname: o.hostname ?? (u.hostname || undefined), port: o.port ?? (u.port || undefined), username: o.username ?? (decodeURIComponent(u.username) || undefined), password: o.password ?? (decodeURIComponent(u.password) || undefined), database: o.database ?? (decodeURIComponent(u.pathname.replace(/^\//, "")) || undefined) };
      }
    }
  }
  adapter ??= o.filename || o.path ? "sqlite" : "postgres";
  const e = env();
  const username = o.username ?? o.user ?? (adapter === "postgres" ? e.PGUSER || e.USER || "postgres" : undefined);
  if (adapter === "sqlite") name ??= o.filename ?? o.path ?? ":memory:";
  else name ??= o.database ?? o.db ?? username ?? "postgres";
  const options = { adapter, hostname: o.hostname ?? o.host ?? "localhost", port: Number(o.port) || (adapter === "mysql" || adapter === "mariadb" ? 3306 : 5432), username, password: o.password ?? "", database: name, bigint: !!o.bigint, max: o.max ?? 10, prepare: true };
  return { adapter, name, options };
}

/** The `sql` function: a tagged template, or a helper (`sql(object)`, `sql(array)`, `sql("identifier")`), with the methods. */
type Tag = ((strings: TemplateStringsArray | unknown, ...values: unknown[]) => unknown) & Record<string, unknown>;

interface Core {
  config: Config;
  closed: boolean;
  pg?: PgDb;
  lite?: ReturnType<typeof liteDriver>;
}

function driverOf(core: Core): Driver {
  const { config } = core;
  if (config.adapter === "mysql" || config.adapter === "mariadb") {
    const who = config.adapter === "mysql" ? "MySQL" : "MariaDB";
    return {
      dialect: PG,
      run: () => Promise.reject(new MySQLError(`${config.adapter}:// isn't supported in the browser: the playground has no network path to a ${who} server. Use postgres:// (a database in this tab, on PGlite) or sqlite:// instead.`)),
    };
  }
  if (config.adapter === "sqlite") return (core.lite ??= liteDriver(config.name, !!config.options.bigint));
  const db = (core.pg ??= acquire(config.name));
  return { dialect: PG, run: (b, mode, simple, bigint) => db.query(b, mode, simple, bigint) };
}

/** Builds the callable `SQL` instance; `resolve` gives its configuration on first use (the default `sql` reads the environment then). */
function makeSQL(resolve: () => Config, proto: object): Tag {
  let core: Core | undefined;
  const get = (): Core => (core ??= { config: resolve(), closed: false });
  let savepoints = 0;

  const run = (b: Built, mode: Mode, simple: boolean, c: Core) => {
    if (c.closed) return Promise.reject(c.config.adapter === "sqlite" ? new SQLiteError("Connection closed") : closedError());
    return holdUntil(driverOf(c).run(b, mode, simple, !!c.config.options.bigint));
  };

  const queryOf = (strings: readonly string[], values: readonly unknown[]): Query => {
    const c = get();
    return new Query(
      (q) => {
        const b: Built = { text: "", params: [], types: [] };
        try {
          render(b, driverOf(c).dialect, strings, values);
        } catch (e) {
          return Promise.reject(e);
        }
        return run(b, q.modeValue, q.simpleValue, c);
      },
      { strings, values },
    );
  };

  const unsafe = (text: string, params: unknown[] = []): Query => {
    const c = get();
    const b: Built = { text, params: [], types: [] };
    // `unsafe`'s parameters are an array, referred to as $1, $2 ... in the text.
    for (const p of params) addParam(b, driverOf(c).dialect, p);
    return new Query((q) => run(b, q.modeValue, q.simpleValue, c), undefined, b);
  };

  const file = (name: string | URL, params: unknown[] = []) => {
    const c = get();
    return new Query((q) => {
      const b: Built = { text: "", params: [], types: [] };
      try {
        b.text = fs.readFileSync(typeof name === "string" ? name : decodeURIComponent(name.pathname), "utf8") as string;
      } catch (e) {
        return Promise.reject(e);
      }
      for (const p of params) addParam(b, driverOf(c).dialect, p);
      return run(b, q.modeValue, q.simpleValue, c);
    });
  };

  const tag = function (first: unknown, ...rest: unknown[]) {
    if (Array.isArray(first) && "raw" in first) return queryOf(first as unknown as TemplateStringsArray, rest);
    if (first === undefined || first === null) throw new TypeError("sql() needs a value to expand");
    return new Helper(first, rest.flat().map(String));
  } as Tag;
  Object.setPrototypeOf(tag, proto);

  /** `begin` (depth 0) runs `fn` in a transaction; inside one, a savepoint. Rolls back, and rethrows, when `fn` throws. */
  const transact = async (depth: number, options: string | undefined, fn: (tx: Tag) => unknown): Promise<unknown> => {
    const c = get();
    const exec = (text: string) => run({ text, params: [], types: [] }, OBJECTS, false, c);
    const name = `runbun_sp_${++savepoints}`;
    const inner = async () => {
      await exec(depth === 0 ? (options ? `BEGIN ${options}` : "BEGIN") : `SAVEPOINT ${name}`);
      try {
        let r = await fn(tx);
        if (Array.isArray(r)) r = await Promise.all(r);
        await exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
        return r;
      } catch (e) {
        try {
          await exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${name}`);
          if (depth > 0) await exec(`RELEASE SAVEPOINT ${name}`);
        } catch {
          // The connection is gone: the error to report is the one `fn` threw.
        }
        throw e;
      }
    };
    const tx = handle((f, opt) => transact(depth + 1, opt, f));
    // Transactions don't overlap on the one connection; a savepoint belongs to the one it is in.
    return depth === 0 && c.pg ? c.pg.exclusive(inner) : inner();
  };

  /** What `begin`'s callback and `reserve()` give: the same queries on the same connection, with `savepoint` and a nested `begin`. */
  const handle = (nested: (fn: (tx: Tag) => unknown, options?: string) => Promise<unknown>): Tag => {
    const h = function (...args: unknown[]) {
      return (tag as unknown as (...a: unknown[]) => unknown)(...args);
    } as Tag;
    Object.setPrototypeOf(h, proto);
    for (const k of ["unsafe", "file", "array", "json", "close", "end", "options", "flush"]) Object.defineProperty(h, k, Object.getOwnPropertyDescriptor(tag, k)!);
    const sp = (a: string | ((tx: Tag) => unknown), b?: (tx: Tag) => unknown) => (typeof a === "function" ? nested(a) : nested(b!));
    h.savepoint = sp;
    h.begin = sp;
    return h;
  };

  const begin = (a: string | ((tx: Tag) => unknown), b?: (tx: Tag) => unknown) => (typeof a === "function" ? transact(0, undefined, a) : transact(0, a, b!));
  const distributed = () => Promise.reject(new SQLError("Distributed transactions aren't supported in the browser"));
  const close = async (_options?: { timeout?: number }) => {
    const c = get();
    if (c.closed) return;
    c.closed = true;
    c.lite?.close();
    await c.pg?.release();
  };

  Object.assign(tag, {
    unsafe,
    file,
    array: (values: unknown[], type?: string) => new ArrayParam(values, type),
    json: (value: unknown) => new JsonParam(value),
    begin,
    transaction: begin,
    reserve: async () => {
      if (get().closed) throw closedError();
      const h = handle((fn, opt) => transact(1, opt, fn));
      // Reserved is the one connection there is; `release()` has nothing to hand back.
      h.begin = begin;
      return Object.assign(h, { release() {}, [Symbol.dispose]() {}, [Symbol.asyncDispose]: async () => {} });
    },
    connect: async () => {
      const c = get();
      if (c.config.adapter === "postgres") await holdUntil((c.pg ??= acquire(c.config.name)).open());
      return tag;
    },
    flush: () => {},
    close,
    end: close,
    beginDistributed: distributed,
    commitDistributed: distributed,
    rollbackDistributed: distributed,
    distributed,
  });
  Object.defineProperty(tag, "options", { get: () => get().config.options, enumerable: true });
  return tag;
}

export class SQL {
  static readonly PostgresError = PostgresError;
  static readonly SQLiteError = SQLiteError;
  static readonly MySQLError = MySQLError;
  static readonly SQLError = SQLError;
  constructor(input?: string | URL | SQLOptions, options?: SQLOptions) {
    const config = configure(input, options);
    return makeSQL(() => config, SQL.prototype) as unknown as SQL;
  }
}

// An instance is a function (`sql\`...\``), so it inherits `call`, `apply` and `bind`; and `sql instanceof SQL` holds.
Object.setPrototypeOf(SQL.prototype, Function.prototype);

/** `Bun.sql`: a `SQL` that reads the environment (DATABASE_URL, POSTGRES_URL, PG* ...) when it is first used. */
export const sql: Tag = makeSQL(() => configure(undefined), SQL.prototype);

// Class names survive a minified build (`error.constructor.name` is what programs print).
for (const [cls, name] of [[SQLError, "SQLError"], [PostgresError, "PostgresError"], [MySQLError, "MySQLError"], [SQLResultArray, "SQLResultArray"], [Query, "Query"], [SQL, "SQL"]] as const) Object.defineProperty(cls, "name", { value: name });
