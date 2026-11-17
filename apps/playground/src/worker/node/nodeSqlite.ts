// node:sqlite (`DatabaseSync`, `StatementSync`) as Bun has it, over bun:sqlite's `Database` (sqlite.ts: sql.js, the
// file read from and written back to the VFS) and its SQL helpers. Statements bind and read the way Node's do:
// named parameters from an object (with or without their prefix), the rest positional, booleans and undefined
// refused, integers as numbers unless `readBigInts` (and an error past 2^53), rows as null-prototype objects.
// sql.js binds an integral number as an INTEGER where Node binds a REAL, which only `typeof()` in SQL tells apart.
import type { Database as SqlJsDb } from "sql.js";
import { Database, classify, paramTokens, type Param } from "./sqlite";
import fs from "./fs";
import path from "./path";
import { fileURLToPath } from "./url";

type Row = Record<string, unknown>;
type Fn = (...args: any[]) => any;
type RawStatement = ReturnType<SqlJsDb["prepare"]>;

/** sql.js 1.16 reads INTEGER columns as exact BigInt with `useBigInt`; its typings predate that. */
interface Loose {
  get(params: null, config: object): unknown[];
  getAsObject(params: null, config: object): Record<string, unknown>;
}
const BIG = { useBigInt: true };

/** An error with a Node `code` that, as in Bun, isn't one of its enumerable keys. */
function nodeError<E extends Error>(err: E, code: string, extra: object = {}): E {
  Object.assign(err, extra);
  Object.defineProperty(err, "code", { value: code, writable: true, configurable: true, enumerable: false });
  return err;
}
const invalidState = (message: string) => nodeError(new Error(message), "ERR_INVALID_STATE");
const argType = (message: string) => nodeError(new TypeError(message), "ERR_INVALID_ARG_TYPE");

// sqlite3_errstr of each primary result code.
const ERRSTR: Record<number, string> = {
  1: "SQL logic error",
  3: "access permission denied",
  4: "query aborted",
  5: "database is locked",
  6: "database table is locked",
  7: "out of memory",
  8: "attempt to write a readonly database",
  9: "interrupted",
  10: "disk I/O error",
  11: "database disk image is malformed",
  13: "database or disk is full",
  14: "unable to open database file",
  18: "string or blob too big",
  19: "constraint failed",
  20: "datatype mismatch",
  21: "bad parameter or other API misuse",
  25: "column index out of range",
  26: "file is not a database",
};

function sqliteError(message: string, errcode: number): Error {
  return nodeError(new Error(message), "ERR_SQLITE_ERROR", { errcode, errstr: ERRSTR[errcode & 0xff] ?? "unknown error" });
}

/** What sql.js threw (`Error(sqlite3_errmsg)`), as Node's error; a user function's own error passes through. */
function fromSqlJs(e: unknown, db: DatabaseSync): unknown {
  const own = db[PENDING];
  db[PENDING] = undefined;
  if (own !== undefined) return own;
  if (!(e instanceof Error) || e.name !== "Error" || "code" in e) return e;
  return sqliteError(e.message, classify(e.message, db[RAW]?._raw));
}

const INTERNAL = Symbol("node:sqlite");
const RAW = Symbol("raw");
const PENDING = Symbol("pending");
const NOTE = Symbol("note");
const FINALIZE = Symbol("finalize");

const isBool = (o: Record<string, unknown>, k: string) => {
  if (o[k] !== undefined && typeof o[k] !== "boolean") throw argType(`The "options.${k}" argument must be a boolean.`);
  return o[k] as boolean | undefined;
};

function pathOf(p: unknown): string {
  let s: string | undefined;
  if (typeof p === "string") s = p;
  else if (p instanceof URL && p.protocol === "file:") s = fileURLToPath(p);
  else if (p instanceof Uint8Array) s = new TextDecoder().decode(p);
  if (s === undefined || s.includes("\0")) throw argType('The "path" argument must be a string, Uint8Array, or URL without null bytes.');
  return s;
}

interface Options {
  open?: boolean;
  readOnly?: boolean;
  enableForeignKeyConstraints?: boolean;
  enableDoubleQuotedStringLiterals?: boolean;
  allowExtension?: boolean;
  readBigInts?: boolean;
  returnArrays?: boolean;
  allowBareNamedParameters?: boolean;
  allowUnknownNamedParameters?: boolean;
  timeout?: number;
}

const TX = /\b(begin|commit|end|rollback|savepoint|release)\b/i;

export class DatabaseSync {
  [RAW]: Database | undefined;
  [PENDING]: unknown;
  #file: string;
  #opts: Required<Pick<Options, "readOnly" | "enableForeignKeyConstraints" | "allowExtension" | "readBigInts" | "returnArrays" | "allowBareNamedParameters" | "allowUnknownNamedParameters">>;
  #extensions = false;
  #statements = new Set<StatementSync>();

  constructor(location: string | Uint8Array | URL, options: Options = {}) {
    this.#file = pathOf(location);
    if (options === null || typeof options !== "object") throw argType('The "options" argument must be an object.');
    const o = options as Record<string, unknown>;
    for (const k of ["open", "enableDoubleQuotedStringLiterals"]) isBool(o, k);
    if (o.timeout !== undefined && !Number.isInteger(o.timeout)) throw argType('The "options.timeout" argument must be an integer.');
    this.#opts = {
      readOnly: isBool(o, "readOnly") ?? false,
      enableForeignKeyConstraints: isBool(o, "enableForeignKeyConstraints") ?? true,
      allowExtension: isBool(o, "allowExtension") ?? false,
      readBigInts: isBool(o, "readBigInts") ?? false,
      returnArrays: isBool(o, "returnArrays") ?? false,
      allowBareNamedParameters: isBool(o, "allowBareNamedParameters") ?? true,
      allowUnknownNamedParameters: isBool(o, "allowUnknownNamedParameters") ?? false,
    };
    if (options.open !== false) this.open();
  }

  /** The bun:sqlite database, open. */
  get #db(): Database {
    if (!this[RAW]) throw invalidState("database is not open");
    return this[RAW];
  }

  open() {
    if (this[RAW]) throw invalidState("database is already open");
    try {
      this[RAW] = new Database(this.#file, { readonly: this.#opts.readOnly, create: !this.#opts.readOnly });
    } catch (e) {
      if (e instanceof Error && e.name === "SQLiteError") throw sqliteError(e.message, (e as Error & { errno: number }).errno);
      throw e;
    }
    if (this.#opts.enableForeignKeyConstraints) this[RAW]._raw.run("pragma foreign_keys = on");
  }

  close() {
    const db = this.#db;
    for (const s of this.#statements) s[FINALIZE]();
    this.#statements.clear();
    this[RAW] = undefined;
    db.close();
  }

  [Symbol.dispose]() {
    if (this[RAW]) this.close();
  }

  get isOpen(): boolean {
    return !!this[RAW];
  }

  /** sql.js doesn't export sqlite3_get_autocommit: BEGIN fails exactly when a transaction is open. */
  get isTransaction(): boolean {
    const raw = this.#db._raw;
    try {
      raw.run("begin");
    } catch {
      return true;
    }
    raw.run("commit");
    return false;
  }

  location(dbName = "main"): string | null {
    this.#db;
    if (dbName !== "main" || this.#file === ":memory:" || this.#file === "") return null;
    return path.resolve(this.#file);
  }

  /** After SQL ran: bun:sqlite's Database flushes to the VFS when no transaction is open. */
  [NOTE](sql: string) {
    const db = this.#db;
    db._note(sql);
    if (TX.test(sql)) (db as unknown as { inTx: boolean }).inTx = this.isTransaction;
  }

  exec(sql: string) {
    if (typeof sql !== "string") throw argType('The "sql" argument must be a string.');
    const db = this.#db;
    try {
      db._raw.run(sql);
    } catch (e) {
      throw fromSqlJs(e, this);
    } finally {
      this[NOTE](sql);
    }
  }

  prepare(sql: string): StatementSync {
    if (typeof sql !== "string") throw argType('The "sql" argument must be a string.');
    const db = this.#db;
    try {
      db._raw.prepare(sql).free();
    } catch (e) {
      throw fromSqlJs(e, this);
    }
    const s = new StatementSync(INTERNAL, this, sql, this.#opts);
    this.#statements.add(s);
    return s;
  }

  /** A user function: its errors reach the caller as thrown, its result must be a SQLite value. */
  #wrap(fn: Fn, bigArgs: boolean): Fn {
    return (...args: unknown[]) => {
      try {
        const r = fn(...(bigArgs ? args.map((a) => (typeof a === "number" && Number.isInteger(a) ? BigInt(a) : a)) : args));
        if (r === undefined || r === null) return null;
        if (typeof r === "number" || typeof r === "string") return r;
        if (typeof r === "bigint") return r;
        if (ArrayBuffer.isView(r)) return new Uint8Array(r.buffer, r.byteOffset, r.byteLength);
      } catch (e) {
        this[PENDING] = e;
        throw e;
      }
      throw new Error("Returned JavaScript value cannot be converted to a SQLite value");
    };
  }

  function(name: string, options: { varargs?: boolean; useBigIntArguments?: boolean; deterministic?: boolean; directOnly?: boolean } | Fn, fn?: Fn) {
    if (typeof options === "function") (fn = options), (options = {});
    if (typeof name !== "string") throw argType('The "name" argument must be a string.');
    if (typeof fn !== "function") throw argType('The "function" argument must be a function.');
    const wrapped = this.#wrap(fn, !!options?.useBigIntArguments);
    Object.defineProperty(wrapped, "length", { value: options?.varargs ? -1 : fn.length });
    this.#db._raw.create_function(name, wrapped);
  }

  aggregate(name: string, options: { start?: unknown; step: Fn; result?: Fn; inverse?: Fn; varargs?: boolean; useBigIntArguments?: boolean }) {
    if (typeof name !== "string") throw argType('The "name" argument must be a string.');
    if (!options || typeof options !== "object") throw argType('The "options" argument must be an object.');
    if (typeof options.step !== "function") throw argType('The "options.step" argument must be a function.');
    const { start, step, result } = options;
    const big = !!options.useBigIntArguments;
    const stepFn = (acc: unknown, ...args: unknown[]) => {
      try {
        return step(acc, ...(big ? args.map((a) => (typeof a === "number" && Number.isInteger(a) ? BigInt(a) : a)) : args));
      } catch (e) {
        this[PENDING] = e;
        throw e;
      }
    };
    Object.defineProperty(stepFn, "length", { value: options.varargs ? 0 : step.length });
    const finalize = this.#wrap((acc: unknown) => (result ? result(acc) : acc), false);
    (this.#db._raw as unknown as { create_aggregate(n: string, o: object): void }).create_aggregate(name, { init: () => (typeof start === "function" ? start() : start), step: stepFn, finalize });
  }

  serialize(_dbName = "main"): Uint8Array {
    return new Uint8Array(this.#db.serialize());
  }

  deserialize(buffer: Uint8Array, _options?: object) {
    if (!(buffer instanceof Uint8Array)) throw argType('The "buffer" argument must be an instance of Uint8Array.');
    const db = this.#db;
    const next = new Database(buffer);
    db._raw.close();
    db._raw = next._raw;
    db._note("insert");
  }

  createTagStore(maxSize = 1000): SQLTagStore {
    return new SQLTagStore(INTERNAL, this, maxSize);
  }

  enableLoadExtension(allow: boolean) {
    if (typeof allow !== "boolean") throw argType('The "allow" argument must be a boolean.');
    if (allow && !this.#opts.allowExtension) throw invalidState("Cannot enable extension loading because it was disabled at database creation.");
    this.#extensions = allow;
  }

  loadExtension(_path: string, _entryPoint?: string) {
    this.#db;
    if (!this.#extensions) throw invalidState("extension loading is not allowed");
    throw new Error("node:sqlite.loadExtension is not supported in the playground: no native code in a browser");
  }

  enableDefensive(_active: boolean) {
    this.#db;
  }

  setAuthorizer(callback: Fn | null) {
    this.#db;
    if (callback !== null && callback !== undefined) throw new Error("node:sqlite.setAuthorizer is not supported in the playground");
  }

  createSession(): never {
    this.#db;
    throw new Error("node:sqlite sessions are not supported in the playground");
  }

  applyChangeset(): never {
    this.#db;
    throw new Error("node:sqlite sessions are not supported in the playground");
  }
}

/** A value Node binds, or the TypeError it throws for parameter `index`. */
function bindable(v: unknown, index: number): unknown {
  switch (typeof v) {
    case "number":
    case "string":
      return v;
    case "bigint":
      if (v > 2n ** 63n - 1n || v < -(2n ** 63n)) throw nodeError(new TypeError("BigInt value is too large to bind."), "ERR_INVALID_ARG_VALUE");
      return v;
    case "object":
      if (v === null) return null;
      if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  throw argType(`Provided value cannot be bound to SQLite parameter ${index}.`);
}

/** SQLite's literal for a value in `sqlite3_expanded_sql`: a number is a REAL as Node binds it (`5.0`, `1.0e+20`). */
function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof Uint8Array) return `x'${[...v].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return v > 0 ? "Inf" : v < 0 ? "-Inf" : "NULL";
    const s = v.toPrecision(15).replace(/(\.\d*?)0+(e|$)/, "$1$2").replace(/\.(e|$)/, "$1");
    const [m, e] = s.split("e");
    const mant = m.includes(".") ? m : `${m}.0`;
    return e === undefined ? mant : `${mant}e${e[0] === "-" ? "-" : "+"}${e.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return String(v);
}

export class StatementSync {
  #db: DatabaseSync;
  #sql: string;
  #tokens: { params: Param[]; count: number };
  #values = new Map<number, unknown>();
  #done = false;
  #readBigInts: boolean;
  #returnArrays: boolean;
  #allowBare: boolean;
  #allowUnknown: boolean;

  constructor(token: symbol, db: DatabaseSync, sql: string, o: { readBigInts: boolean; returnArrays: boolean; allowBareNamedParameters: boolean; allowUnknownNamedParameters: boolean }) {
    if (token !== INTERNAL) throw nodeError(new TypeError("Illegal constructor"), "ERR_ILLEGAL_CONSTRUCTOR");
    this.#db = db;
    this.#sql = sql;
    this.#tokens = paramTokens(sql);
    this.#readBigInts = o.readBigInts;
    this.#returnArrays = o.returnArrays;
    this.#allowBare = o.allowBareNamedParameters;
    this.#allowUnknown = o.allowUnknownNamedParameters;
  }

  [FINALIZE]() {
    this.#done = true;
  }

  get sourceSQL(): string {
    return this.#sql;
  }

  /** The SQL with the bound values written in (NULL for those not bound), as `sqlite3_expanded_sql`. */
  get expandedSQL(): string {
    let out = "";
    let at = 0;
    for (const p of this.#tokens.params) {
      out += this.#sql.slice(at, p.start) + literal(this.#values.get(p.index));
      at = p.end;
    }
    return out + this.#sql.slice(at);
  }

  /** The values by SQLite's parameter index: an object's by name, then the rest of the arguments for the unnamed ones. */
  #bind(args: unknown[]): unknown[] {
    const values = new Map<number, unknown>();
    const { params, count } = this.#tokens;
    let positional = args;
    const first = args[0];
    if (first !== null && typeof first === "object" && !ArrayBuffer.isView(first)) {
      positional = args.slice(1);
      for (const key of Object.keys(first)) {
        const p = params.find((x) => x.name !== undefined && x.text === key) ?? (this.#allowBare ? params.find((x) => x.name === key) : undefined);
        if (!p) {
          if (this.#allowUnknown) continue;
          throw invalidState(`Unknown named parameter '${key}'`);
        }
        values.set(p.index, bindable((first as Row)[key], p.index));
      }
    }
    const named = new Set(params.filter((p) => p.name !== undefined).map((p) => p.index));
    let index = 1;
    for (const v of positional) {
      while (named.has(index)) index++;
      if (index > count) throw sqliteError("column index out of range", 25);
      values.set(index, bindable(v, index));
      index++;
    }
    this.#values = values;
    return Array.from({ length: count }, (_, i) => (values.has(i + 1) ? values.get(i + 1) : null));
  }

  /** The prepared sql.js statement with `args` bound; the caller frees it. */
  #start(args: unknown[]): RawStatement {
    if (this.#done) throw invalidState("statement has been finalized");
    const raw = this.#db[RAW]!;
    const bind = this.#bind(args);
    let s: RawStatement;
    try {
      s = raw._raw.prepare(this.#sql);
    } catch (e) {
      throw fromSqlJs(e, this.#db);
    }
    try {
      if (bind.length) s.bind(bind as never);
    } catch (e) {
      s.free();
      throw fromSqlJs(e, this.#db);
    }
    return s;
  }

  /** The next row, or undefined at the end. */
  #step(s: RawStatement): unknown {
    try {
      if (!s.step()) return undefined;
    } catch (e) {
      throw fromSqlJs(e, this.#db);
    }
    if (this.#returnArrays) return (s as unknown as Loose).get(null, BIG).map((v) => this.#value(v));
    const row = (s as unknown as Loose).getAsObject(null, BIG);
    const out: Row = Object.create(null);
    for (const k of Object.keys(row)) out[k] = this.#value(row[k]);
    return out;
  }

  #value(v: unknown): unknown {
    if (typeof v !== "bigint" || this.#readBigInts) return v;
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw nodeError(new RangeError(`Value is too large to be represented as a JavaScript number: ${v}`), "ERR_OUT_OF_RANGE");
    return Number(v);
  }

  #each<T>(args: unknown[], fn: (s: RawStatement) => T): T {
    const s = this.#start(args);
    try {
      return fn(s);
    } finally {
      s.free();
      this.#db[NOTE](this.#sql);
    }
  }

  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.#each(args, (s) => {
      while (this.#step(s) !== undefined);
      const raw = this.#db[RAW]!._raw;
      const changes = raw.getRowsModified();
      const id = (raw as unknown as { exec(sql: string, p: null, c: object): { values: unknown[][] }[] }).exec("select last_insert_rowid()", null, BIG)[0].values[0][0] as bigint;
      return this.#readBigInts ? { changes: BigInt(changes), lastInsertRowid: id } : { changes, lastInsertRowid: Number(id) };
    });
  }

  get(...args: unknown[]): unknown {
    return this.#each(args, (s) => this.#step(s));
  }

  all(...args: unknown[]): unknown[] {
    return this.#each(args, (s) => {
      const rows: unknown[] = [];
      for (let r; (r = this.#step(s)) !== undefined; ) rows.push(r);
      return rows;
    });
  }

  /** Rows one step at a time, as an iterator (`[object Iterator]`) with `next` and `return`. */
  iterate(...args: unknown[]): Iterator<unknown> {
    let s: RawStatement | undefined = this.#start(args);
    const done = () => Object.assign(Object.create(null), { done: true, value: null });
    const finish = () => {
      s?.free();
      s = undefined;
      this.#db[NOTE](this.#sql);
    };
    const it = Object.create(ITERATOR);
    it.next = () => {
      if (!s) return done();
      let value;
      try {
        value = this.#step(s);
      } catch (e) {
        finish();
        throw e;
      }
      if (value === undefined) return finish(), done();
      return Object.assign(Object.create(null), { done: false, value });
    };
    it.return = () => (finish(), done());
    return it;
  }

  /** The result columns: names only (sql.js has no sqlite3_column_table_name or _decltype), the rest null. */
  columns(): { column: null; database: null; name: string; table: null; type: null }[] {
    if (this.#done) throw invalidState("statement has been finalized");
    const s = this.#db[RAW]!._raw.prepare(this.#sql);
    try {
      return s.getColumnNames().map((name) => Object.assign(Object.create(null), { column: null, database: null, name, table: null, type: null }));
    } finally {
      s.free();
    }
  }

  setReadBigInts(enabled: boolean) {
    if (typeof enabled !== "boolean") throw argType('The "readBigInts" argument must be a boolean.');
    this.#readBigInts = enabled;
  }

  setReturnArrays(enabled: boolean) {
    if (typeof enabled !== "boolean") throw argType('The "returnArrays" argument must be a boolean.');
    this.#returnArrays = enabled;
  }

  setAllowBareNamedParameters(enabled: boolean) {
    if (typeof enabled !== "boolean") throw argType('The "allowBareNamedParameters" argument must be a boolean.');
    this.#allowBare = enabled;
  }

  setAllowUnknownNamedParameters(enabled: boolean) {
    if (typeof enabled !== "boolean") throw argType('The "enabled" argument must be a boolean.');
    this.#allowUnknown = enabled;
  }
}

/** The prototype of `iterate()`'s iterators: Iterator.prototype's helpers (`map`, `toArray`) where the engine has them. */
const ITERATOR = Object.create((globalThis as { Iterator?: { prototype: object } }).Iterator?.prototype ?? Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())));

/** `db.createTagStore()`: tagged templates over a cache of prepared statements, the values bound as parameters. */
class SQLTagStore {
  #db: DatabaseSync;
  #max: number;
  #cache = new Map<string, StatementSync>();
  constructor(token: symbol, db: DatabaseSync, max: number) {
    if (token !== INTERNAL) throw nodeError(new TypeError("Illegal constructor"), "ERR_ILLEGAL_CONSTRUCTOR");
    this.#db = db;
    this.#max = max;
  }
  #statement(strings: TemplateStringsArray): StatementSync {
    const sql = strings.join("?");
    let s = this.#cache.get(sql);
    if (s) this.#cache.delete(sql);
    else s = this.#db.prepare(sql);
    this.#cache.set(sql, s);
    if (this.#cache.size > this.#max) this.#cache.delete(this.#cache.keys().next().value!);
    return s;
  }
  get(strings: TemplateStringsArray, ...values: unknown[]) {
    return this.#statement(strings).get(...values);
  }
  all(strings: TemplateStringsArray, ...values: unknown[]) {
    return this.#statement(strings).all(...values);
  }
  iterate(strings: TemplateStringsArray, ...values: unknown[]) {
    return this.#statement(strings).iterate(...values);
  }
  run(strings: TemplateStringsArray, ...values: unknown[]) {
    return this.#statement(strings).run(...values);
  }
  clear() {
    this.#cache.clear();
  }
  get size() {
    return this.#cache.size;
  }
  get capacity() {
    return this.#max;
  }
}

/** Sessions need sqlite3session, which sql.js doesn't build. */
export class Session {
  constructor() {
    throw nodeError(new TypeError("Illegal constructor"), "ERR_ILLEGAL_CONSTRUCTOR");
  }
}

/** `backup(db, path)`: the database's bytes written to `path`; resolves with the number of pages copied. */
async function backup(source: DatabaseSync, dest: string | Uint8Array | URL, _options?: object): Promise<number> {
  if (!(source instanceof DatabaseSync)) throw argType('The "sourceDb" argument must be an object.');
  const bytes = source.serialize();
  fs.writeFileSync(pathOf(dest), bytes);
  const pageSize = (bytes[16] << 8) | bytes[17];
  return bytes.length / (pageSize === 1 ? 65536 : pageSize || 4096);
}

const constants: Record<string, number> = Object.assign(Object.create(null), {
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5,
  SQLITE_OK: 0,
  SQLITE_DENY: 1,
  SQLITE_IGNORE: 2,
  ...Object.fromEntries(
    "CREATE_INDEX CREATE_TABLE CREATE_TEMP_INDEX CREATE_TEMP_TABLE CREATE_TEMP_TRIGGER CREATE_TEMP_VIEW CREATE_TRIGGER CREATE_VIEW DELETE DROP_INDEX DROP_TABLE DROP_TEMP_INDEX DROP_TEMP_TABLE DROP_TEMP_TRIGGER DROP_TEMP_VIEW DROP_TRIGGER DROP_VIEW INSERT PRAGMA READ SELECT TRANSACTION UPDATE ATTACH DETACH ALTER_TABLE REINDEX ANALYZE CREATE_VTABLE DROP_VTABLE FUNCTION SAVEPOINT"
      .split(" ")
      .map((k, i) => [`SQLITE_${k}`, i + 1]),
  ),
  SQLITE_COPY: 0,
  SQLITE_RECURSIVE: 33,
});

export default { DatabaseSync, StatementSync, Session, backup, constants };
