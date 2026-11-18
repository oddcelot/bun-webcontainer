// node:sqlite (`DatabaseSync`, `StatementSync`) as Bun has it, over bun:sqlite's `Database` (sqlite.ts: the file read
// from and written back to the VFS) and the SQLite C API (sqliteEngine.ts). Statements bind and read the way Node's
// do: named parameters from an object (with or without their prefix), the rest positional, booleans and undefined
// refused, every number as a REAL, integers read as numbers unless `readBigInts` (and an error past 2^53), rows as
// null-prototype objects.
import { Database, paramsOf, type Param } from "./sqlite";
import { DBCONFIG_DEFENSIVE, DBCONFIG_DQS_DDL, DBCONFIG_DQS_DML, DBCONFIG_ENABLE_FKEY, Conn, RawError, aggregateKey, errstr, result, resultError, valueOf, type Stmt, type Value } from "./sqliteEngine";
import fs from "./fs";
import path from "./path";
import { fileURLToPath } from "./url";

type Row = Record<string, unknown>;
type Fn = (...args: any[]) => any;

/** An error with a Node `code` that, as in Bun, isn't one of its enumerable keys. */
function nodeError<E extends Error>(err: E, code: string, extra: object = {}): E {
  Object.assign(err, extra);
  Object.defineProperty(err, "code", { value: code, writable: true, configurable: true, enumerable: false });
  return err;
}
const invalidState = (message: string) => nodeError(new Error(message), "ERR_INVALID_STATE");
const argType = (message: string) => nodeError(new TypeError(message), "ERR_INVALID_ARG_TYPE");

/** Node's error for SQLite result code `errcode` (the extended one) with `message`. */
function sqliteError(message: string, errcode: number): Error {
  return nodeError(new Error(message), "ERR_SQLITE_ERROR", { errcode, errstr: errstr(errcode) });
}

/** A SQLite error as Node's; a user function's own error (`pending`) passes through. */
function fromRaw(e: unknown, db: DatabaseSync): unknown {
  const raw = db[RAW];
  const own = raw?._pending;
  if (raw) raw._pending = undefined;
  if (own !== undefined) return own;
  if (!(e instanceof RawError)) return e;
  return sqliteError(e.message, e.errno);
}

const INTERNAL = Symbol("node:sqlite");
const RAW = Symbol("raw");
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

/** A user function's arguments: integers as BigInts with `big`, else as numbers (an error past 2^53). */
function argsOf(args: number[], big: boolean): unknown[] {
  return args.map((a) => {
    const v = valueOf(a, true);
    return typeof v === "bigint" && !big ? toNumber(v) : v;
  });
}

function toNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw nodeError(new RangeError(`Value is too large to be represented as a JavaScript number: ${v}`), "ERR_OUT_OF_RANGE");
  return Number(v);
}

export class DatabaseSync {
  [RAW]: Database | undefined;
  #file: string;
  #opts: Required<Pick<Options, "readOnly" | "enableForeignKeyConstraints" | "allowExtension" | "readBigInts" | "returnArrays" | "allowBareNamedParameters" | "allowUnknownNamedParameters">>;
  #extensions = false;
  #dqs: boolean;
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
    this.#dqs = options.enableDoubleQuotedStringLiterals === true;
    if (options.open !== false) this.open();
  }

  /** The bun:sqlite database, open. */
  get #db(): Database {
    if (!this[RAW]) throw invalidState("database is not open");
    return this[RAW];
  }

  get #conn(): Conn {
    return this.#db._conn;
  }

  open() {
    if (this[RAW]) throw invalidState("database is already open");
    try {
      this[RAW] = new Database(this.#file, { readonly: this.#opts.readOnly, create: !this.#opts.readOnly });
    } catch (e) {
      if (e instanceof Error && e.name === "SQLiteError") throw sqliteError(e.message, (e as Error & { errno: number }).errno);
      throw e;
    }
    this.#configure();
  }

  /** What Node sets on a connection it opens: double-quoted strings, foreign keys, defensive mode. */
  #configure() {
    const c = this.#conn;
    c.dbConfig(DBCONFIG_DQS_DML, +this.#dqs);
    c.dbConfig(DBCONFIG_DQS_DDL, +this.#dqs);
    c.dbConfig(DBCONFIG_ENABLE_FKEY, +this.#opts.enableForeignKeyConstraints);
    c.dbConfig(DBCONFIG_DEFENSIVE, 1);
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

  get isTransaction(): boolean {
    return !this.#conn.autocommit;
  }

  location(dbName = "main"): string | null {
    this.#db;
    if (dbName !== "main" || this.#file === ":memory:" || this.#file === "") return null;
    return path.resolve(this.#file);
  }

  exec(sql: string) {
    if (typeof sql !== "string") throw argType('The "sql" argument must be a string.');
    const db = this.#db;
    try {
      db._conn.eachStatement(sql, (s) => {
        if (!s.readonly) db._wrote();
        while (s.step());
      });
    } catch (e) {
      throw fromRaw(e, this);
    }
  }

  prepare(sql: string): StatementSync {
    if (typeof sql !== "string") throw argType('The "sql" argument must be a string.');
    let raw: Stmt | null;
    try {
      raw = this.#conn.prepare(sql);
    } catch (e) {
      throw fromRaw(e, this);
    }
    const s = new StatementSync(INTERNAL, this, sql, raw, this.#opts);
    this.#statements.add(s);
    return s;
  }

  /** A user function's result as SQLite's, or the error Node gives for a value it can't store. */
  #result(ctx: number, r: unknown) {
    // A number is a REAL, as Node binds one
    if (r === undefined || r === null || typeof r === "number" || typeof r === "string") return result(ctx, (r ?? null) as Value, true);
    if (typeof r === "bigint") {
      if (r <= 2n ** 63n - 1n && r >= -(2n ** 63n)) return result(ctx, r);
      return this.#fail(ctx, new Error("BigInt value is too large for SQLite"), false);
    }
    if (ArrayBuffer.isView(r)) return result(ctx, new Uint8Array(r.buffer, r.byteOffset, r.byteLength));
    this.#fail(ctx, new Error(r instanceof Promise ? "Asynchronous user-defined functions are not supported" : "Returned JavaScript value cannot be converted to a SQLite value"), false);
  }

  /** The function failed with `e`: rethrown as is when it is the program's own error (`own`), else as Node's. */
  #fail(ctx: number, e: unknown, own = true) {
    const db = this[RAW];
    if (own && db) db._pending = e;
    resultError(ctx, e instanceof Error ? e.message : String(e));
  }

  function(name: string, options: { varargs?: boolean; useBigIntArguments?: boolean; deterministic?: boolean; directOnly?: boolean } | Fn, fn?: Fn) {
    if (typeof options === "function") (fn = options), (options = {});
    if (typeof name !== "string") throw argType('The "name" argument must be a string.');
    if (typeof fn !== "function") throw argType('The "function" argument must be a function.');
    const big = !!options?.useBigIntArguments;
    const f = fn;
    const flags = (options?.deterministic ? 0x800 : 0) | (options?.directOnly ? 0x80000 : 0);
    try {
      this.#conn.createFunction(name, options?.varargs ? -1 : f.length, flags, {
        func: (ctx, args) => {
          let r;
          try {
            r = f(...argsOf(args, big));
          } catch (e) {
            return this.#fail(ctx, e);
          }
          this.#result(ctx, r);
        },
      });
    } catch (e) {
      throw fromRaw(e, this);
    }
  }

  aggregate(name: string, options: { start?: unknown; step: Fn; result?: Fn; inverse?: Fn; varargs?: boolean; useBigIntArguments?: boolean; deterministic?: boolean; directOnly?: boolean }) {
    if (typeof name !== "string") throw argType('The "name" argument must be a string.');
    if (!options || typeof options !== "object") throw argType('The "options" argument must be an object.');
    if (typeof options.step !== "function") throw argType('The "options.step" argument must be a function.');
    const { start, step, result: done, inverse } = options;
    if (start === undefined) throw argType('The "options.start" argument must be a function or a primitive value.');
    const big = !!options.useBigIntArguments;
    const flags = (options.deterministic ? 0x800 : 0) | (options.directOnly ? 0x80000 : 0);
    // The accumulator of each group, by its sqlite3_aggregate_context.
    const accs = new Map<number, unknown>();
    const acc = (ctx: number) => {
      const key = aggregateKey(ctx, true);
      if (!accs.has(key)) accs.set(key, typeof start === "function" ? start.call(null) : start);
      return key;
    };
    const update = (f: Fn) => (ctx: number, args: number[]) => {
      try {
        const key = acc(ctx);
        accs.set(key, f(accs.get(key), ...argsOf(args, big)));
      } catch (e) {
        this.#fail(ctx, e);
      }
    };
    const value = (final: boolean) => (ctx: number) => {
      let r;
      try {
        const key = acc(ctx);
        const v = accs.get(key);
        if (final) accs.delete(key);
        r = done ? done.call(null, v) : v;
      } catch (e) {
        return this.#fail(ctx, e);
      }
      this.#result(ctx, r);
    };
    const nArg = options.varargs ? -1 : Math.max(step.length, inverse?.length ?? 0, 1) - 1;
    try {
      this.#conn.createFunction(name, nArg, flags, { step: update(step), final: value(true), ...(inverse ? { value: value(false), inverse: update(inverse) } : {}) });
    } catch (e) {
      throw fromRaw(e, this);
    }
  }

  serialize(dbName = "main"): Uint8Array {
    this.#db;
    try {
      return this.#conn.serialize(dbName);
    } catch (e) {
      throw fromRaw(e, this);
    }
  }

  deserialize(buffer: Uint8Array, _options?: object) {
    if (!(buffer instanceof Uint8Array)) throw argType('The "buffer" argument must be an instance of Uint8Array.');
    const db = this.#db;
    try {
      db._conn.load(buffer);
    } catch (e) {
      throw fromRaw(e, this);
    }
    db._wrote();
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

  enableDefensive(active: boolean) {
    if (typeof active !== "boolean") throw argType('The "active" argument must be a boolean.');
    this.#conn.dbConfig(DBCONFIG_DEFENSIVE, +active);
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
function bindable(v: unknown, index: number): Value {
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

export class StatementSync {
  #db: DatabaseSync;
  #sql: string;
  #raw: Stmt | null;
  #tokens: { params: Param[]; count: number };
  #done = false;
  #readBigInts: boolean;
  #returnArrays: boolean;
  #allowBare: boolean;
  #allowUnknown: boolean;

  constructor(token: symbol, db: DatabaseSync, sql: string, raw: Stmt | null, o: { readBigInts: boolean; returnArrays: boolean; allowBareNamedParameters: boolean; allowUnknownNamedParameters: boolean }) {
    if (token !== INTERNAL) throw nodeError(new TypeError("Illegal constructor"), "ERR_ILLEGAL_CONSTRUCTOR");
    this.#db = db;
    this.#sql = sql;
    this.#raw = raw;
    this.#tokens = raw ? paramsOf(raw) : { params: [], count: 0 };
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

  /** The SQL with the bound values written in (NULL for those not bound): `sqlite3_expanded_sql`. */
  get expandedSQL(): string {
    return this.#raw ? this.#raw.expanded : this.#sql;
  }

  /** Binds an object's values by name, then the rest of the arguments to the unnamed parameters. */
  #bind(s: Stmt, args: unknown[]) {
    const { params, count } = this.#tokens;
    s.clearBindings();
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
        s.bind(p.index, bindable((first as Row)[key], p.index), true);
      }
    }
    const named = new Set(params.filter((p) => p.name !== undefined).map((p) => p.index));
    let index = 1;
    for (const v of positional) {
      while (named.has(index)) index++;
      if (index > count) throw sqliteError("column index out of range", 25);
      s.bind(index, bindable(v, index), true);
      index++;
    }
  }

  /** The prepared statement, reset, with `args` bound. */
  #start(args: unknown[]): Stmt | null {
    if (this.#done) throw invalidState("statement has been finalized");
    const raw = this.#db[RAW]!;
    const s = this.#raw;
    if (!s) return null;
    s.reset();
    try {
      this.#bind(s, args);
    } catch (e) {
      throw fromRaw(e, this.#db);
    }
    if (!s.readonly) raw._wrote();
    return s;
  }

  /** The next row, or undefined at the end. */
  #step(s: Stmt): unknown {
    try {
      if (!s.step()) return undefined;
    } catch (e) {
      throw fromRaw(e, this.#db);
    }
    const n = s.columnCount;
    if (this.#returnArrays) return Array.from({ length: n }, (_, i) => this.#value(s.column(i, true)));
    const out: Row = Object.create(null);
    for (let i = 0; i < n; i++) out[s.columnName(i)] = this.#value(s.column(i, true));
    return out;
  }

  #value(v: unknown): unknown {
    if (typeof v !== "bigint" || this.#readBigInts) return v;
    return toNumber(v);
  }

  #each<T>(args: unknown[], fn: (s: Stmt | null) => T): T {
    const s = this.#start(args);
    try {
      return fn(s);
    } finally {
      s?.reset();
    }
  }

  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.#each(args, (s) => {
      if (s) while (this.#step(s) !== undefined);
      const conn = this.#db[RAW]!._conn;
      const changes = conn.changes();
      const id = conn.lastInsertRowid();
      return this.#readBigInts ? { changes: BigInt(changes), lastInsertRowid: id } : { changes, lastInsertRowid: Number(id) };
    });
  }

  get(...args: unknown[]): unknown {
    return this.#each(args, (s) => (s ? this.#step(s) : undefined));
  }

  all(...args: unknown[]): unknown[] {
    return this.#each(args, (s) => {
      const rows: unknown[] = [];
      if (s) for (let r; (r = this.#step(s)) !== undefined; ) rows.push(r);
      return rows;
    });
  }

  /** Rows one step at a time, as an iterator (`[object Iterator]`) with `next` and `return`. */
  iterate(...args: unknown[]): Iterator<unknown> {
    let s: Stmt | null | undefined = this.#start(args);
    const done = () => Object.assign(Object.create(null), { done: true, value: null });
    const finish = () => {
      s?.reset();
      s = undefined;
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

  /** The result columns: name, and the database, table, column and declared type it comes from (null for an expression). */
  columns(): { column: string | null; database: string | null; name: string; table: string | null; type: string | null }[] {
    if (this.#done) throw invalidState("statement has been finalized");
    const s = this.#raw;
    if (!s) return [];
    return Array.from({ length: s.columnCount }, (_, i) => Object.assign(Object.create(null), { column: s.originName(i), database: s.databaseName(i), name: s.columnName(i), table: s.tableName(i), type: s.declType(i) }));
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

/** Sessions are not supported yet. */
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
