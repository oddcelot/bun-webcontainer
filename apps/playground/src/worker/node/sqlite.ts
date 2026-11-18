// `bun:sqlite` on SQLite compiled to wasm (sqliteEngine.ts, the official build), driven through the C API as Bun's
// bindings drive the native library: statements stay prepared, values bind with sqlite3_bind_*, errors carry the
// extended result code and sqlite3_error_offset. The engine loads asynchronously, so the wrapper module of
// `bun:sqlite` awaits `globalThis.__loadBunSqlite()` first; after that `new Database()` is synchronous.
// File databases persist: the bytes are read from the worker's VFS on open and written back with sqlite3_serialize
// (debounced after a write, and on close). Writes go through the fs shim, so the page's file tree and OPFS mirror see them.
import { norm } from "@runbun/vfs";
import fs from "./fs";
import path from "./path";
import { quietTimeout } from "../loop";
import { Conn, DBCONFIG_DEFENSIVE, DBCONFIG_DQS_DDL, DBCONFIG_DQS_DML, RawError, createAggregate, loaded, rcName, result, resultError, valueOf, type Stmt, type Value } from "./sqliteEngine";

type Fn = (...args: any[]) => any;

type Params = unknown[] | Record<string, unknown>;
interface Options {
  create?: boolean;
  readonly?: boolean;
  readwrite?: boolean;
  strict?: boolean;
  safeIntegers?: boolean;
}

const FLUSH_MS = 200;

// --- SQLiteError -------------------------------------------------------------------------------------------------

const INTERNAL = Symbol("bun:sqlite");

export class SQLiteError extends Error {
  code!: string;
  errno!: number;
  byteOffset!: number;
  constructor(message: string, init?: { code: string; errno: number; byteOffset: number }, token?: symbol) {
    if (token !== INTERNAL) throw new Error("SQLiteError can only be constructed by bun:sqlite");
    super(message);
    Object.defineProperty(this, "name", { value: "SQLiteError", writable: true, configurable: true });
    Object.assign(this, init);
  }
}

/** What Bun throws for a SQLite error; a user function's own error (`pending`) passes through. */
function sqliteError(e: unknown, db?: Database): unknown {
  const own = db?._pending;
  if (db) db._pending = undefined;
  if (own !== undefined) return own;
  if (!(e instanceof RawError)) return e;
  return new SQLiteError(e.message, { code: rcName(e.errno) ?? "SQLITE_ERROR", errno: e.errno, byteOffset: e.byteOffset }, INTERNAL);
}

function cantOpen(): SQLiteError {
  return new SQLiteError("unable to open database file", { code: "SQLITE_CANTOPEN", errno: 14, byteOffset: -1 }, INTERNAL);
}

// --- parameters --------------------------------------------------------------------------------------------------

export interface Param {
  /** The name as written (`$a`, `:a`, `@a`); undefined for `?`/`?N`. */
  text?: string;
  /** SQLite's 1-based index for it (named parameters share one per name). */
  index: number;
  /** The name without its prefix; undefined for `?`/`?N`. */
  name?: string;
}

/** The parameters of statement `s`, as SQLite numbers them. */
export function paramsOf(s: Stmt): { params: Param[]; count: number } {
  const count = s.paramCount;
  const params: Param[] = [];
  for (let i = 1; i <= count; i++) {
    const text = s.paramName(i);
    params.push(text === null || text[0] === "?" ? { index: i } : { text, index: i, name: text.slice(1) });
  }
  return { params, count };
}

const BIGINT_MAX = 2n ** 63n - 1n;
const BIGINT_MIN = -(2n ** 63n);

/** `safe` (safeIntegers): a BigInt outside the 64-bit range is an error; without it Bun binds its low 64 bits. */
function bindable(v: unknown, safe = false): Value {
  switch (typeof v) {
    case "undefined":
      return null;
    case "boolean":
      return +v;
    case "string":
    case "number":
      return v;
    case "bigint":
      if (safe && (v > BIGINT_MAX || v < BIGINT_MIN)) throw new RangeError(`BigInt value '${v}' is out of range`);
      return v;
    case "object":
      if (v === null) return null;
      if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
  }
  throw new TypeError("Binding expected string, TypedArray, boolean, number, bigint or null");
}

const isNamed = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer) && !Array.isArray(v) && !(v instanceof Date);

/**
 * Binds the arguments of `all(...)`, `run(...)` and friends to `s`: an array or several values bind to `?` in order,
 * an object by name (a key may drop its `$`/`:`/`@` prefix; with `strict`, a name the object lacks is an error, else
 * NULL). No arguments leave the last call's values bound.
 */
function bindArgs(s: Stmt, args: unknown[], strict: boolean, checkCount: boolean, safe: boolean) {
  if (!args.length) return;
  const first = args[0];
  const toks = paramsOf(s);
  if (args.length === 1 && isNamed(first)) {
    s.clearBindings();
    for (const p of toks.params) {
      if (!p.name) continue;
      const has = p.text! in first ? p.text! : p.name in first ? p.name : undefined;
      if (has === undefined) {
        if (strict) throw new Error(`Missing parameter "${p.name}"`);
        continue;
      }
      s.bind(p.index, bindable(first[has], safe));
    }
    return;
  }
  const list = args.length === 1 && Array.isArray(first) ? first : args;
  if (checkCount && list.length && list.length !== toks.count) throw new Error(`SQLite query expected ${toks.count} values, received ${list.length}`);
  s.clearBindings();
  list.forEach((v, i) => s.bind(i + 1, bindable(v, safe)));
}

// --- user functions ----------------------------------------------------------------------------------------------

function booleanOption(options: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = options[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`Expected the "${key}" option to be a boolean`);
  return value;
}

function functionOption(options: Record<string, unknown>, key: string): Fn | undefined {
  const value = options[key];
  if (value == null) return undefined;
  if (typeof value !== "function") throw new TypeError(`Expected the "${key}" option to be a function`);
  return value as Fn;
}

function parameterCount(fn: Fn): number {
  const length = fn.length;
  if (!Number.isInteger(length) || length < 0) throw new TypeError("Expected function.length to be a positive integer");
  return length;
}

/** SQLITE_DETERMINISTIC | SQLITE_DIRECTONLY */
const functionFlags = (options: Record<string, unknown>) => (booleanOption(options, "deterministic") ? 0x800 : 0) | (booleanOption(options, "directOnly") ? 0x80000 : 0);

// --- statements --------------------------------------------------------------------------------------------------

const TYPES: Record<number, string> = { 1: "INTEGER", 2: "FLOAT", 3: "TEXT", 4: "BLOB", 5: "NULL" };

export class Statement<R = unknown, P extends unknown[] = any[]> {
  private cls: (new (...args: any[]) => unknown) | undefined;
  private safe: boolean;
  /** The prepared statement; null once finalized. */
  private s: Stmt | null;

  constructor(
    private db: Database,
    readonly native: string,
    s: Stmt,
  ) {
    this.safe = db._safe;
    this.s = s;
  }

  private live(): Stmt {
    if (!this.s) throw new Error("Statement has finalized");
    this.db._open("Database has closed", Error);
    return this.s;
  }

  /** Runs the statement, calling `fn` for each row until it returns false. */
  private each(params: unknown[], fn: (s: Stmt) => boolean | void): void {
    const s = this.live();
    s.reset();
    try {
      bindArgs(s, params, this.db._strict, true, this.safe);
      if (!s.readonly) this.db._wrote();
      while (s.step()) if (fn(s) === false) break;
    } catch (e) {
      throw sqliteError(e, this.db);
    } finally {
      s.reset();
    }
  }

  private row(s: Stmt): R {
    const row: Record<string, unknown> = this.cls ? Object.create(this.cls.prototype) : {};
    for (let i = 0, n = s.columnCount; i < n; i++) row[s.columnName(i)] = s.column(i, this.safe);
    return row as R;
  }

  private list(s: Stmt): unknown[] {
    return Array.from({ length: s.columnCount }, (_, i) => s.column(i, this.safe));
  }

  get columnNames(): string[] {
    const s = this.live();
    return Array.from({ length: s.columnCount }, (_, i) => s.columnName(i));
  }

  /** The type of each column in the first row (all "NULL" without one): the statement runs, so only one that writes nothing may. */
  get columnTypes(): string[] {
    const s = this.live();
    if (!s.readonly) throw new Error("columnTypes is not available for non-read-only statements (INSERT, UPDATE, DELETE, etc.)");
    s.reset();
    try {
      const row = s.step();
      return Array.from({ length: s.columnCount }, (_, i) => (row ? TYPES[s.type(i)] : "NULL"));
    } catch (e) {
      throw sqliteError(e, this.db);
    } finally {
      s.reset();
    }
  }

  /** The declared type of each column (null for an expression or a column declared without one). */
  get declaredTypes(): (string | null)[] {
    const s = this.live();
    return Array.from({ length: s.columnCount }, (_, i) => s.declType(i));
  }

  get paramsCount(): number {
    return this.live().paramCount;
  }

  get isFinalized(): boolean {
    return !this.s;
  }

  /** Rows come back as instances of `Class` (prototype set, constructor not called). */
  as<C extends new (...args: any[]) => unknown>(Class?: C): Statement<InstanceType<C>, P> {
    if (Class !== undefined && (typeof Class !== "function" || !Class.prototype)) throw new TypeError("Expected class to be a constructor or undefined");
    this.cls = Class;
    return this as never;
  }

  /** With an argument: INTEGER columns come back as BigInt (and `true` binds them losslessly) from now on. Without: the current setting. */
  safeIntegers(): boolean;
  safeIntegers(value: boolean): this;
  safeIntegers(value?: boolean): boolean | this {
    if (value === undefined) return this.safe;
    this.safe = !!value;
    return this;
  }

  all(...params: P): R[] {
    const out: R[] = [];
    this.each(params, (s) => void out.push(this.row(s)));
    return out;
  }

  get(...params: P): R | null {
    let row: R | null = null;
    this.each(params, (s) => {
      row = this.row(s);
      return false;
    });
    return row;
  }

  values(...params: P): unknown[][] {
    const out: unknown[][] = [];
    this.each(params, (s) => void out.push(this.list(s)));
    return out;
  }

  *iterate(...params: P): IterableIterator<R> {
    yield* this.all(...params);
  }

  run(...params: P): { changes: number; lastInsertRowid: number | bigint } {
    const before = this.db._changes();
    this.each(params, () => {});
    return this.db._meta(before, this.safe);
  }

  /** The SQL with the last bound values written in (NULL for those not bound): `sqlite3_expanded_sql`. */
  toString(): string {
    return this.live().expanded;
  }

  toJSON(): string {
    return this.toString();
  }

  finalize(): void {
    this.s?.finalize();
    this.s = null;
    this.db._forget(this);
  }
}

/** File databases still open: flushed when the worker is about to be stopped (see flushDatabases). */
const openFiles = new Set<Database>();

/** Writes every open file database back now; the runtime calls this before Run/Stop terminates the worker. */
export function flushDatabases() {
  for (const db of openFiles) db.flush();
}

const toBuffer = (bytes: Uint8Array): Uint8Array => {
  const B = (globalThis as { Buffer?: { from(b: ArrayBufferLike, o: number, n: number): Uint8Array } }).Buffer;
  return B ? B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
};

export class Database {
  _conn: Conn;
  _strict: boolean;
  _safe: boolean;
  /** An error a user function threw, rethrown instead of the SQLite error it caused. */
  _pending: unknown;
  readonly filename: string;
  private cache = new Map<string, Statement>();
  /** VFS key of the backing file; undefined for in-memory databases and readonly ones (which never write back). */
  private file: string | undefined;
  private dirty = false;
  private closed = false;
  private depth = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(filename: string | Uint8Array = ":memory:", options: number | Options = {}) {
    if (!loaded()) throw new Error("bun:sqlite is not loaded yet");
    const o: Options = typeof options === "object" && options ? options : {};
    this._strict = !!o.strict;
    this._safe = !!o.safeIntegers;
    let readonly = o.readonly === true || o.readwrite === false;
    let create = o.create ?? (o.readwrite !== true && !readonly);
    if (typeof options === "number") {
      // SQLITE_OPEN_READONLY = 1, SQLITE_OPEN_READWRITE = 2, SQLITE_OPEN_CREATE = 4
      readonly = !!(options & 1);
      create = !!(options & 4);
    } else if (readonly && (o.create || o.readwrite)) throw new TypeError('A read-only database ("readonly: true" or "readwrite: false") cannot have "create: true" or "readwrite: true"');
    this.filename = filename instanceof Uint8Array ? "" : String(filename);
    let image: Uint8Array | undefined;
    let key: string | undefined;
    if (filename instanceof Uint8Array) image = filename;
    else if (filename !== "" && filename !== ":memory:") {
      key = norm(path.resolve(String(filename)));
      if (fs.existsSync(key)) {
        try {
          image = fs.readFileSync(key) as Uint8Array;
        } catch {
          throw cantOpen();
        }
      } else if (!create) throw cantOpen();
    }
    try {
      this._conn = new Conn(image?.byteLength ? image : undefined, readonly);
    } catch (e) {
      throw sqliteError(e);
    }
    // As Bun opens a database: defensive, and double-quoted string literals as the library has them (on).
    this._conn.dbConfig(DBCONFIG_DEFENSIVE, 1);
    this._conn.dbConfig(DBCONFIG_DQS_DML, 1);
    this._conn.dbConfig(DBCONFIG_DQS_DDL, 1);
    if (key !== undefined && !readonly) {
      this.file = key;
      openFiles.add(this);
      if (!image) this.touch(); // Bun creates the file on open
    }
  }

  /** A database from the bytes `serialize()` returned (or any SQLite file). `true` or `{ readonly: true }` opens it read-only. */
  static deserialize(data: Uint8Array | ArrayBuffer, options?: boolean | number | Options): Database {
    if (!ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) throw new TypeError(`Expected 'serialized' to be a TypedArray or ArrayBuffer, got '${data === null ? "null" : typeof data}'`);
    const bytes = bindable(data) as Uint8Array;
    if (!bytes.byteLength) throw new Error("ArrayBuffer must not be empty");
    const o: Options = typeof options === "object" && options ? options : { readonly: options === true || (typeof options === "number" && !!(options & 1)) };
    return new Database(bytes, o);
  }

  /** Runs `fn` on the connection, throwing what Bun throws for a SQLite error. */
  private raw<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw sqliteError(e, this);
    }
  }

  _open(message = "Cannot use a closed database", E: new (m: string) => Error = RangeError) {
    if (this.closed) throw new E(message);
  }

  private touch() {
    this.dirty = true;
    this.timer ??= quietTimeout(() => this.flush(), FLUSH_MS);
  }

  /** A statement that can write is about to run: the file needs writing back. */
  _wrote() {
    if (this.file) this.touch();
  }

  get inTransaction(): boolean {
    this._open();
    return !this._conn.autocommit;
  }

  /** Write the database back to the VFS now (later when a transaction is open: its writes aren't committed yet). */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file || !this.dirty || this.closed) return;
    if (!this._conn.autocommit) return void this.touch();
    this.dirty = false;
    fs.writeFileSync(this.file, this._conn.serialize());
  }

  _changes(): number {
    return this._conn.totalChanges();
  }

  /** `changes` is what the statement changed (as SQLite's total_changes grew), not the last write's count. */
  _meta(before: number, safe = this._safe) {
    const id = this._conn.lastInsertRowid();
    return { changes: this._changes() - before, lastInsertRowid: safe ? id : Number(id) };
  }

  _forget(s: Statement) {
    for (const [k, v] of this.cache) if (v === s) this.cache.delete(k);
  }

  /** Runs every statement of `sql`; the first gets `params`. */
  run(sql: string, ...params: unknown[]) {
    this._open();
    if (!sql.trim()) throw new Error("SQL string mustn't be blank");
    const before = this._changes();
    this.raw(() =>
      this._conn.eachStatement(sql, (s, i) => {
        if (i === 0) bindArgs(s, params, this._strict, false, this._safe);
        if (!s.readonly) this._wrote();
        while (s.step());
      }),
    );
    return this._meta(before);
  }

  exec = this.run;

  /** The prepared first statement of `sql`; fails now, as Bun does, when it doesn't compile. */
  private compile(sql: string): Stmt {
    this._open();
    if (!sql.trim()) throw new Error("SQL query cannot be empty.");
    const s = this.raw(() => this._conn.prepare(sql));
    if (!s) throw new RangeError("Invalid SQL statement");
    return s;
  }

  query<R = unknown, P extends Params = any>(sql: string): Statement<R, P extends unknown[] ? P : [P]> {
    let s = this.cache.get(sql);
    if (!s) this.cache.set(sql, (s = new Statement(this, sql, this.compile(sql))));
    return s as never;
  }

  prepare<R = unknown, P extends Params = any>(sql: string): Statement<R, P extends unknown[] ? P : [P]> {
    return new Statement(this, sql, this.compile(sql)) as never;
  }

  clearQueryCache(): void {
    for (const s of this.cache.values()) s.finalize();
    this.cache.clear();
  }

  /** `fn` in a transaction (a savepoint when already inside one); it rolls back if `fn` throws. Also `.deferred`, `.immediate`, `.exclusive`. */
  transaction<A extends unknown[], T>(fn: (...args: A) => T) {
    const make = (mode: string) =>
      (...args: A): T => {
        this._open();
        const nested = !this._conn.autocommit;
        const sp = `bun_sqlite_${this.depth++}`;
        try {
          this.raw(() => this._conn.exec(nested ? `savepoint ${sp}` : `begin ${mode}`));
          try {
            const r = fn(...args);
            this.raw(() => this._conn.exec(nested ? `release ${sp}` : "commit"));
            this._wrote();
            return r;
          } catch (e) {
            try {
              this._conn.exec(nested ? `rollback to ${sp}; release ${sp}` : "rollback");
            } catch {}
            throw e;
          }
        } finally {
          this.depth--;
        }
      };
    return Object.assign(make(""), { deferred: make("deferred"), immediate: make("immediate"), exclusive: make("exclusive") });
  }

  /** A user function's result (a value Bun binds), or the TypeError it throws for one it can't. */
  private setResult(ctx: number, name: string, v: unknown, safe: boolean) {
    let value: Value;
    try {
      value = bindable(v, safe);
    } catch (e) {
      if (e instanceof TypeError) throw new TypeError(`User-defined function ${name}() returned an invalid value`);
      throw e;
    }
    result(ctx, value);
  }

  /** The callback threw `e`: the statement fails, and rethrows `e`. */
  private fail = (ctx: number, e: unknown) => {
    this._pending = e;
    resultError(ctx, "");
  };

  /** `fn` as SQL function `name`: `deterministic`, `directOnly`, `varargs` and `safeIntegers` (INTEGER arguments as BigInts). */
  function(name: string, options: Record<string, unknown> | Fn | undefined, fn?: Fn): this {
    if (typeof options === "function") {
      fn = options;
      options = undefined;
    }
    options ??= {};
    if (typeof name !== "string") throw new TypeError("Expected first argument to be a string");
    if (typeof fn !== "function") throw new TypeError("Expected last argument to be a function");
    if (typeof options !== "object") throw new TypeError("Expected second argument to be an options object");
    if (!name) throw new TypeError("User-defined function name cannot be an empty string");
    const safe = booleanOption(options, "safeIntegers", this._safe);
    const flags = functionFlags(options);
    const nArg = booleanOption(options, "varargs") ? -1 : parameterCount(fn);
    this._open("Database has closed", Error);
    const f = fn;
    this.raw(() =>
      this._conn.createFunction(name, nArg, flags, {
        func: (ctx, argv) => {
          try {
            this.setResult(ctx, name, f(...argv.map((a) => valueOf(a, safe))), safe);
          } catch (e) {
            this.fail(ctx, e);
          }
        },
      }),
    );
    return this;
  }

  /** An aggregate: `start` (or a function making it), `step(acc, ...args)`, and `inverse` (a window function) and `result`. */
  aggregate(name: string, options: Record<string, unknown>): this {
    if (typeof name !== "string") throw new TypeError("Expected first argument to be a string");
    if (typeof options !== "object" || !options) throw new TypeError("Expected second argument to be an options object");
    if (!name) throw new TypeError("User-defined function name cannot be an empty string");
    const step = functionOption(options, "step");
    if (!step) throw new TypeError('Missing required option "step"');
    const inverse = functionOption(options, "inverse");
    const done = functionOption(options, "result");
    const safe = booleanOption(options, "safeIntegers", this._safe);
    const flags = functionFlags(options);
    // The first parameter of `step` and `inverse` is the accumulator.
    const nArg = booleanOption(options, "varargs") ? -1 : Math.max(parameterCount(step), inverse ? parameterCount(inverse) : 0, 1) - 1;
    this._open("Database has closed", Error);
    this.raw(() =>
      createAggregate(this._conn, name, nArg, flags, {
        start: options.start ?? null,
        step,
        inverse,
        result: done,
        self: undefined,
        keepOnUndefined: true,
        args: (argv) => argv.map((a) => valueOf(a, safe)),
        set: (ctx, v) => this.setResult(ctx, name, v, safe),
        fail: this.fail,
      }),
    );
    return this;
  }

  serialize(name = "main"): Uint8Array {
    this._open();
    return toBuffer(this.raw(() => this._conn.serialize(name)));
  }

  loadExtension(_name: string, _entryPoint?: string): void {
    this._open();
    throw new Error("This build of sqlite3 does not support dynamic extension loading");
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    openFiles.delete(this);
    this.closed = true;
    this.cache.clear();
    this._conn.close();
  }
}

// bun:sqlite's constants (the SQLITE_OPEN_* flags `new Database(path, flags)` takes)
export const constants = {
  SQLITE_OPEN_READONLY: 1,
  SQLITE_OPEN_READWRITE: 2,
  SQLITE_OPEN_CREATE: 4,
};

export default { Database, Statement, SQLiteError, constants };
