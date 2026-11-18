// `bun:sqlite` on SQLite compiled to wasm (sqliteEngine.ts, the official build), driven through the C API as Bun's
// bindings drive the native library: statements stay prepared, values bind with sqlite3_bind_*, errors carry the
// extended result code and sqlite3_error_offset. The engine loads asynchronously, so the wrapper module of
// `bun:sqlite` awaits `globalThis.__loadBunSqlite()` first; after that `new Database()` is synchronous.
// A file database is a file of the program's VFS that SQLite reads and writes in place (sqliteVfs.ts), with its
// journal or WAL next to it, so the page's file tree and storage see it as they see any file the program writes.
import { norm } from "@runbun/vfs";
import path from "./path";
import { Conn, DBCONFIG_DEFENSIVE, DBCONFIG_DQS_DDL, DBCONFIG_DQS_DML, RawError, columnBytes, createAggregate, loaded, shutdown, rcName, result, resultError, valueOf, type Stmt, type Value } from "./sqliteEngine";

type Fn = (...args: any[]) => any;

type Params = unknown[] | Record<string, unknown>;
interface Options {
  create?: boolean;
  readonly?: boolean;
  readwrite?: boolean;
  strict?: boolean;
  safeIntegers?: boolean;
}

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

// --- connections and statements (what Bun's C++ is: JSSQLStatement.cpp) -------------------------------------------

const TYPES: Record<number, string> = { 1: "INTEGER", 2: "FLOAT", 3: "TEXT", 4: "BLOB", 5: "NULL" };

/** Statement flags of a database (Bun's internal flags). */
const SAFE_INTEGERS = 1 << 1;
const STRICT = 1 << 2;
const OWNED = 1 << 3;

/** One connection, as Bun's VersionSqlite3: the database and each of its statements hold it. */
export class Handle {
  /** An error a user function threw, rethrown instead of the SQLite error it caused. */
  pending: unknown;
  /** close() was called: the connection is gone for the database, though db.prepare() statements may still run. */
  closed = false;
  /** Inside a user function or an update hook: every use of the connection is refused there. */
  busy = 0;
  statements = new Set<NativeStatement>();
  /** onInsert, onUpdate, onDelete */
  hooks: (Fn | null)[] = [null, null, null];

  constructor(public conn: Conn) {}

  /**
   * Opens `filename` (a path of the program's VFS, `:memory:`, or a `file:` URI) with sqlite3_open_v2's `flags`, set up
   * as Bun sets up a connection: extended result codes, defensive, double-quoted strings as the library has them.
   */
  static open(filename: string, flags: number): Handle {
    if (!loaded()) throw new Error("bun:sqlite is not loaded yet");
    if (!(flags & 3)) throw new SQLiteError("flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE", { code: "SQLITE_MISUSE", errno: 21, byteOffset: -1 }, INTERNAL);
    const name = filename === ":memory:" || filename === "" || filename.startsWith("file:") ? filename : "/" + norm(path.resolve(filename));
    let conn: Conn;
    try {
      conn = new Conn(name, flags);
    } catch (e) {
      throw sqliteError(e);
    }
    return new Handle(conn).configure();
  }

  /** An in-memory database holding `bytes` (sqlite3_deserialize). */
  static deserialize(bytes: Uint8Array, readonly: boolean): Handle {
    if (!loaded()) throw new Error("bun:sqlite is not loaded yet");
    if (!bytes.byteLength) throw new Error("ArrayBuffer must not be empty");
    let conn: Conn;
    try {
      conn = Conn.memory(bytes, readonly);
    } catch (e) {
      if (e instanceof RawError) throw new Error(e.errno === 1 ? "unable to deserialize database" : e.message);
      throw e;
    }
    return new Handle(conn).configure();
  }

  private configure(): this {
    this.conn.dbConfig(DBCONFIG_DEFENSIVE, 1);
    this.conn.dbConfig(DBCONFIG_DQS_DML, 1);
    this.conn.dbConfig(DBCONFIG_DQS_DDL, 1);
    return this;
  }

  /** Throws while a user callback of this connection runs. */
  idle() {
    if (this.busy) throw new TypeError("This database connection is busy executing a query");
  }

  /** The connection, unless the database was closed. */
  get live(): Conn | null {
    return this.closed ? null : this.conn;
  }

  /** Runs a user callback: the connection is busy meanwhile. */
  callback<T>(fn: () => T): T {
    this.busy++;
    try {
      return fn();
    } finally {
      this.busy--;
    }
  }

  /** What Bun throws for a SQLite error; a user function's own error passes through. */
  error(e: unknown): unknown {
    return sqliteError(e, this);
  }

  /**
   * close(force): finalizes the statements the database owns (its query cache, its transactions'), every one with
   * `force`. The connection closes once no statement is left; without `force` db.prepare() statements keep it open.
   */
  close(force: boolean) {
    for (const s of [...this.statements]) if (force || NativeStatement.owned(s)) s.finalize(true);
    this.closed = true;
    this.hooks = [null, null, null];
    this.drained();
  }

  /** Closes the connection once the database is closed and its last statement is gone. */
  drained() {
    if (this.closed && !this.statements.size && this.conn.ptr) this.conn.close();
  }
}

/** What Bun throws for a SQLite error; a user function's own error (`pending`) passes through. */
function sqliteError(e: unknown, h?: Handle): unknown {
  const own = h?.pending;
  if (h) h.pending = undefined;
  if (own !== undefined) return own;
  if (!(e instanceof RawError)) return e;
  return new SQLiteError(e.message, { code: rcName(e.errno) ?? "SQLITE_ERROR", errno: e.errno, byteOffset: e.byteOffset }, INTERNAL);
}

/** The changes a run of a statement that can write made itself (not its triggers'), as Bun counts them. */
function changesSince(conn: Conn, totalBefore: number): number {
  return conn.totalChanges() === totalBefore ? 0 : conn.changes();
}

/** `{ changes, lastInsertRowid }` of a run. */
function changesObject(conn: Conn, changes: number, safe: boolean) {
  const id = conn.lastInsertRowid();
  return { changes, lastInsertRowid: safe ? id : Number(id) };
}

/**
 * A prepared statement as Bun's C++ has it (`statement.native`): every method that runs it takes the array of
 * arguments (or nothing, to keep what is bound).
 */
class NativeStatement {
  #h: Handle;
  #s: Stmt | null;
  #cls: (new (...args: any[]) => unknown) | undefined;
  #strict: boolean;
  #safe: boolean;
  #byClose = false;
  #owned: boolean;

  /** Whether the database owns it (its query cache's, its transactions'): its close() finalizes it. */
  static owned(n: NativeStatement): boolean {
    return n.#owned;
  }

  constructor(h: Handle, s: Stmt, flags: number) {
    this.#h = h;
    this.#s = s;
    this.#strict = !!(flags & STRICT);
    this.#safe = !!(flags & SAFE_INTEGERS);
    this.#owned = !!(flags & OWNED);
    h.statements.add(this);
  }

  /** The statement, ready to use; throws when it is finalized or the connection busy. */
  #live(): Stmt {
    if (!this.#s) throw new Error(this.#byClose ? "Database has closed" : "Statement has finalized");
    this.#h.idle();
    return this.#s;
  }

  /** Resets the statement and binds `args` (an array of the call's arguments; undefined keeps what is bound). */
  #start(args: unknown[] | undefined): Stmt {
    const s = this.#live();
    s.reset();
    try {
      if (args !== undefined) bindArgs(s, args, this.#strict, true, this.#safe);
    } catch (e) {
      throw this.#h.error(e);
    }
    return s;
  }

  /** One step: true for a row; an error resets the statement and throws Bun's error. */
  #step(s: Stmt): boolean {
    try {
      return s.step();
    } catch (e) {
      throw this.#h.error(e);
    }
  }

  /** Runs to the end (or until `each` returns false), then resets. */
  #each(args: unknown[] | undefined, each: (s: Stmt) => boolean | void) {
    const s = this.#start(args);
    try {
      while (this.#step(s)) if (each(s) === false) break;
    } finally {
      s.reset();
    }
  }

  #row(s: Stmt): unknown {
    const row: Record<string, unknown> = this.#cls ? Object.create(this.#cls.prototype) : {};
    for (let i = 0, n = s.columnCount; i < n; i++) row[s.columnName(i)] = s.column(i, this.#safe);
    return row;
  }

  #values(s: Stmt): unknown[] {
    return Array.from({ length: s.columnCount }, (_, i) => s.column(i, this.#safe));
  }

  all(args?: unknown[]): unknown[] {
    const out: unknown[] = [];
    this.#each(args, (s) => void out.push(this.#row(s)));
    return out;
  }

  get(args?: unknown[]): unknown {
    let row: unknown = null;
    this.#each(args, (s) => {
      row = this.#row(s);
      return false;
    });
    return row;
  }

  values(args?: unknown[]): unknown[][] {
    const out: unknown[][] = [];
    this.#each(args, (s) => void out.push(this.#values(s)));
    return out;
  }

  /** Each row as an array of each value's bytes: INTEGER and FLOAT as 8 bytes, TEXT as UTF-8, NULL as null. */
  raw(args?: unknown[]): (Uint8Array | null)[][] {
    const out: (Uint8Array | null)[][] = [];
    this.#each(args, (s) => void out.push(Array.from({ length: s.columnCount }, (_, i) => columnBytes(s, i))));
    return out;
  }

  /** Runs it to the end: `{ changes, lastInsertRowid }`. */
  run(args?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const s = this.#start(args);
    const conn = this.#h.conn;
    const canWrite = !s.readonly;
    const before = canWrite ? conn.totalChanges() : 0;
    try {
      while (this.#step(s));
    } finally {
      s.reset();
    }
    return changesObject(conn, canWrite ? changesSince(conn, before) : 0, this.#safe);
  }

  /** The first row of a run that stays open (null when there is none): iterateNext goes on from it. */
  iterate(args?: unknown[]): unknown {
    const s = this.#start(args);
    if (this.#step(s)) return this.#row(s);
    s.reset();
    return null;
  }

  /** The next row of run `run` (see runCount), or null after the last one. */
  iterateNext(run: number): unknown {
    const s = this.#live();
    if (run !== s.runCount || !s.busy) throw new Error("This iterator was invalidated: its statement was run again. Use db.prepare() to get a statement with a cursor of its own.");
    if (this.#step(s)) return this.#row(s);
    s.reset();
    return null;
  }

  /** Ends run `run` if it is still the statement's: resets it (a RETURNING statement's reset commits, and can fail). */
  iterateEnd(run: number): void {
    const s = this.#s;
    if (!s) return;
    this.#h.idle();
    if (run === s.runCount && s.reset()) throw this.#h.error(this.#h.conn.error());
  }

  get runCount(): number {
    return this.#live().runCount;
  }

  /** Rows come back as instances of `Class` (prototype set, constructor not called). */
  as(Class?: unknown): void {
    if (Class !== undefined && (typeof Class !== "function" || !Class.prototype)) throw new TypeError("Expected class to be a constructor or undefined");
    this.#cls = Class as never;
  }

  get safeIntegers(): boolean {
    return this.#safe;
  }
  set safeIntegers(value: boolean) {
    this.#safe = !!value;
  }

  get columns(): string[] {
    const s = this.#live();
    return Array.from({ length: s.columnCount }, (_, i) => s.columnName(i));
  }

  get columnsCount(): number {
    return this.#live().columnCount;
  }

  get paramsCount(): number {
    return this.#live().paramCount;
  }

  get readonly(): boolean {
    return this.#live().readonly;
  }

  get isFinalized(): boolean {
    return !this.#s;
  }

  /** The type of each column in the first row (all "NULL" without one): the statement runs, so only one that writes nothing may. */
  get columnTypes(): string[] {
    const s = this.#live();
    if (!s.readonly) throw new Error("columnTypes is not available for non-read-only statements (INSERT, UPDATE, DELETE, etc.)");
    s.reset();
    try {
      const row = this.#step(s);
      return Array.from({ length: s.columnCount }, (_, i) => (row ? TYPES[s.type(i)] : "NULL"));
    } finally {
      s.reset();
    }
  }

  /** The declared type of each column (null for an expression or a column declared without one). */
  get declaredTypes(): (string | null)[] {
    const s = this.#live();
    return Array.from({ length: s.columnCount }, (_, i) => s.declType(i));
  }

  /** The SQL with the last bound values written in (NULL for those not bound): `sqlite3_expanded_sql`. */
  toString(): string {
    return this.#s?.expanded ?? "";
  }

  /** `byClose`: the database's close() did it (using the statement then says the database has closed). */
  finalize(byClose = false): void {
    if (!this.#s) return;
    if (!byClose) this.#h.idle();
    this.#s.finalize();
    this.#s = null;
    this.#byClose = byClose;
    this.#h.statements.delete(this);
    this.#h.drained();
  }
}

// Bun's is a plain object: no constructor of its own
delete (NativeStatement.prototype as { constructor?: unknown }).constructor;

/** Prepares the first statement of `sql` on `h`, binding `params` (the list of a call's arguments) when given. */
function prepareOn(h: Handle, sql: unknown, params: unknown[] | undefined, prepareFlags: number, flags: number): NativeStatement {
  h.idle();
  if (typeof sql !== "string") throw new Error("Expected SQL string");
  const conn = h.live;
  if (!conn) throw new RangeError("Cannot use a closed database");
  if (!sql.length) throw new RangeError("Invalid SQL statement");
  // SQLITE_PREPARE_PERSISTENT | NORMALIZE | NO_VTAB
  if (prepareFlags < 0 || prepareFlags > 7) throw new RangeError("Invalid prepare flags");
  let s: Stmt | null;
  try {
    s = conn.prepare(sql, prepareFlags);
  } catch (e) {
    throw h.error(e);
  }
  if (!s) throw new RangeError("Invalid SQL statement");
  const stmt = new NativeStatement(h, s, flags);
  if (params !== undefined) {
    try {
      bindArgs(s, params, !!(flags & STRICT), true, !!(flags & SAFE_INTEGERS));
    } catch (e) {
      // nobody gets this statement
      stmt.finalize();
      throw h.error(e);
    }
  }
  return stmt;
}

// --- Statement (Bun's sqlite.ts) ----------------------------------------------------------------------------------

export class Statement<R = unknown, P extends unknown[] = any[]> {
  #raw: NativeStatement;
  declare get: (...params: P) => R | null;
  declare all: (...params: P) => R[];
  declare iterate: (...params: P) => IterableIterator<R>;
  declare values: (...params: P) => unknown[][];
  declare raw: (...params: P) => (Uint8Array | null)[][];
  declare run: (...params: P) => { changes: number; lastInsertRowid: number | bigint };

  constructor(raw: NativeStatement) {
    this.#raw = raw;
    if (raw.paramsCount === 0) {
      this.get = () => raw.get() as R | null;
      this.all = () => raw.all() as R[];
      this.iterate = () => this.#iterate();
      this.values = () => raw.values();
      this.raw = () => raw.raw();
      this.run = () => raw.run();
    } else {
      this.get = (...args) => raw.get(args) as R | null;
      this.all = (...args) => raw.all(args) as R[];
      this.iterate = (...args) => this.#iterate(...args);
      this.values = (...args) => raw.values(args);
      this.raw = (...args) => raw.raw(args);
      this.run = (...args) => raw.run(args);
    }
  }

  /** Steps the statement as the loop asks for rows: a statement run again meanwhile invalidates it. */
  *#iterate(...args: unknown[]): Generator<R> {
    const raw = this.#raw;
    let row = raw.iterate(args.length ? args : this.#raw.paramsCount ? [] : undefined);
    const run = raw.runCount;
    try {
      for (; row; row = raw.iterateNext(run)) yield row as R;
    } finally {
      raw.iterateEnd(run);
    }
  }

  get isFinalized(): boolean {
    return this.#raw.isFinalized;
  }

  toJSON() {
    return { sql: this.native.toString(), isFinalized: this.isFinalized, paramsCount: this.paramsCount, columnNames: this.columnNames };
  }

  get [Symbol.toStringTag]() {
    return `"${this.native.toString()}"`;
  }

  toString(): string {
    return this.native.toString();
  }

  get native(): NativeStatement {
    return this.#raw;
  }

  /** With an argument: INTEGER columns come back as BigInt (and `true` binds them losslessly) from now on. Without: the current setting. */
  safeIntegers(): boolean;
  safeIntegers(value: boolean): this;
  safeIntegers(value?: boolean): boolean | this {
    if (value !== undefined) {
      this.#raw.safeIntegers = !!value;
      return this;
    }
    return this.#raw.safeIntegers;
  }

  /** Rows come back as instances of `Class` (prototype set, constructor not called). */
  as<C extends new (...args: any[]) => unknown>(Class?: C): Statement<InstanceType<C>, P> {
    this.#raw.as(Class);
    return this as never;
  }

  get columnNames(): string[] {
    return this.#raw.columns;
  }

  get columnTypes(): string[] {
    return this.#raw.columnTypes;
  }

  get declaredTypes(): (string | null)[] {
    return this.#raw.declaredTypes;
  }

  get paramsCount(): number {
    return this.#raw.paramsCount;
  }

  /** Whether it returns rows (has columns). */
  get reader(): boolean {
    return this.#raw.columnsCount > 0;
  }

  /** Whether it leaves the database as it is (sqlite3_stmt_readonly). */
  get readonly(): boolean {
    return this.#raw.readonly;
  }

  finalize(): void {
    return this.#raw.finalize();
  }

  [Symbol.iterator]() {
    return this.#iterate();
  }

  [Symbol.dispose]() {
    if (!this.isFinalized) this.finalize();
  }
}

// --- Database (Bun's sqlite.ts) -----------------------------------------------------------------------------------

const cachedCount = Symbol.for("Bun.Database.cache.count");
const handles = new WeakMap<Database, Handle>();
/** db.handle: a number per connection the program opened, from 0. */
let nextHandleNumber = 0;

/** The connection of a bun:sqlite database (for Bun.sql's SQLite adapter and node:sqlite). */
export const handleOf = (db: Database): Handle => handles.get(db)!;

const isTypedArray = ArrayBuffer.isView;

export class Database {
  #handle: Handle;
  #flags = 0;
  #number: number;
  #queryCache = new Map<string, Statement>();
  #transactions: Record<string, Record<string, NativeStatement>> | undefined;
  filename: string;
  declare exec: Database["run"];

  constructor(filenameGiven?: string | Uint8Array, options?: number | Options) {
    if (typeof filenameGiven === "undefined") {
    } else if (typeof filenameGiven !== "string") {
      if (isTypedArray(filenameGiven)) {
        let readonly = false;
        if (options && typeof options === "object") {
          if (options.strict) this.#flags |= STRICT;
          if (options.safeIntegers) this.#flags |= SAFE_INTEGERS;
          if (options.readonly) readonly = true;
        }
        const v = filenameGiven as ArrayBufferView;
        this.#handle = Handle.deserialize(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), readonly);
        this.filename = ":memory:";
        this.#number = nextHandleNumber++;
        handles.set(this, this.#handle);
        return;
      }
      throw new TypeError(`Expected 'filename' to be a string, got '${typeof filenameGiven}'`);
    }

    const filename = typeof filenameGiven === "string" ? filenameGiven.trim() : ":memory:";
    let flags = constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE;
    if (typeof options === "object" && options) {
      if ("readOnly" in options) throw new TypeError('Misspelled option "readOnly" should be "readonly"');
      // `undefined` is an option that was not given. Any other falsy value turns the option off.
      const { readonly, create, readwrite } = options;
      if (readonly || (readwrite !== undefined && !readwrite)) {
        if (create || readwrite) throw new TypeError('A read-only database ("readonly: true" or "readwrite: false") cannot have "create: true" or "readwrite: true"');
        flags = constants.SQLITE_OPEN_READONLY;
      } else if (!create && (create !== undefined || readwrite)) {
        flags = constants.SQLITE_OPEN_READWRITE;
      }
      if (options.safeIntegers) this.#flags |= SAFE_INTEGERS;
      if (options.strict) this.#flags |= STRICT;
    } else if (typeof options === "number") {
      flags = options;
    }

    const anonymous = filename === "" || filename === ":memory:";
    if (anonymous && (flags & constants.SQLITE_OPEN_READONLY) !== 0) throw new Error("Cannot open an anonymous database in read-only mode.");

    this.#handle = Handle.open(anonymous ? ":memory:" : filename, flags);
    this.filename = filename;
    this.#number = nextHandleNumber++;
    handles.set(this, this.#handle);
  }

  /** A number for the connection (Bun's index of it). */
  get handle(): number {
    this.#handle.idle();
    return this.#number;
  }

  get inTransaction(): boolean {
    const h = this.#handle;
    h.idle();
    if (!h.live) throw new Error("Database has closed");
    return !h.conn.autocommit;
  }

  static open(filename?: string | Uint8Array, options?: number | Options): Database {
    return new Database(filename, options);
  }

  loadExtension(name: unknown, _entryPoint?: string): void {
    const h = this.#handle;
    h.idle();
    if (typeof name !== "string") throw new TypeError("Expected string");
    if (!h.live) throw new RangeError("Cannot use a closed database");
    throw new Error("This build of sqlite3 does not support dynamic extension loading");
  }

  serialize(optionalName?: string): Uint8Array {
    const h = this.#handle;
    h.idle();
    const name = String(optionalName || "main");
    const conn = h.live;
    if (!conn) throw new Error("Can't do this on a closed database");
    try {
      return toBuffer(conn.serialize(name));
    } catch (e) {
      throw h.error(e);
    }
  }

  /** A database from the bytes `serialize()` returned (or any SQLite file). `true` or `{ readonly: true }` opens it read-only. */
  static deserialize(serialized: ArrayBufferView | ArrayBufferLike, options: boolean | Options | number = false): Database {
    const bytes = serialized instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && serialized instanceof SharedArrayBuffer) ? new Uint8Array(serialized) : serialized;
    if (!isTypedArray(bytes)) throw new TypeError(`Expected 'serialized' to be a TypedArray or ArrayBuffer, got '${serialized === null ? "null" : typeof serialized}'`);
    if (typeof options === "boolean") return new Database(bytes as Uint8Array, { readonly: options });
    if (options && typeof options === "object") return new Database(bytes as Uint8Array, options);
    return new Database(bytes as Uint8Array, 0);
  }

  [Symbol.dispose]() {
    this.close(true);
  }

  /** Bun's way to load another SQLite library: a no-op here, as on Linux, where Bun's SQLite is built in. */
  static setCustomSQLite(path: unknown): boolean {
    if (typeof path !== "string") throw new Error("Expected SQLite path");
    if (path.includes("\0")) throw Object.assign(new TypeError(`The argument 'path' must be a string without null bytes. Received ${JSON.stringify(path).replace(/\\u0000/g, "\\x00").replace(/^"|"$/g, "'")}`), { code: "ERR_INVALID_ARG_VALUE" });
    return false;
  }

  /**
   * sqlite3_file_control: `fileControl(op, arg)` on the main database, or `fileControl(schema, op, arg)`. `arg` is a
   * number (an int64 SQLite may read), a TypedArray of at least 8 bytes (SQLite may write to it) or null. Returns
   * SQLite's result code (SQLITE_NOTFOUND, 12, for an opcode nothing answers).
   */
  fileControl(zDbName: unknown, op?: unknown, arg?: unknown): number | undefined {
    if (typeof zDbName === "string" || arguments.length > 2) return this.#fcntl(zDbName, op, arg);
    return this.#fcntl(null, zDbName, op);
  }

  #fcntl(schema: unknown, opNumber: unknown, value: unknown): number | undefined {
    const h = this.#handle;
    h.idle();
    if (typeof opNumber !== "number") throw new Error("Expected number");
    const op = opNumber | 0;
    const conn = h.live;
    if (!conn) return undefined;
    let arg: Uint8Array | null = new Uint8Array(new BigInt64Array([-1n]).buffer);
    let view: Uint8Array | undefined;
    if (typeof value === "number") arg = new Uint8Array(new BigInt64Array([BigInt(value | 0)]).buffer);
    else if (ArrayBuffer.isView(value)) {
      if (value.byteLength < 8) throw new Error("TypedArray must be at least 8 bytes");
      arg = view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else if (value == null) {
      if (op === constants.SQLITE_FCNTL_SET_LOCKPROXYFILE) arg = null;
    } else throw new Error("Expected result to be a number, null or a TypedArray");
    // SQLite allocates the string of these two, and the caller frees it
    const owns = !view && (op === constants.SQLITE_FCNTL_VFSNAME || op === constants.SQLITE_FCNTL_TEMPFILENAME);
    if (owns) arg = new Uint8Array(8);
    const rc = conn.fileControl(typeof schema === "string" ? schema : null, op, arg, owns);
    if (rc === 1) {
      const e = conn.error();
      // (SQLite can leave no error on the connection: no code then, as in Bun)
      throw new SQLiteError(e.message, { ...(e.errno ? { code: rcName(e.errno) } : {}), errno: e.errno, byteOffset: -1 } as never, INTERNAL);
    }
    return rc;
  }

  /**
   * Closes the database: the statements it owns (query() ones, its transactions') are finalized, those of prepare()
   * stay usable until finalized (every one with `throwOnError`, which also closes the file now).
   */
  close(throwOnError = false): void {
    this.#queryCache.clear();
    this.#transactions = undefined;
    const h = this.#handle;
    h.idle();
    if (!h.conn.ptr || (h.closed && !throwOnError)) return;
    h.close(throwOnError);
  }

  clearQueryCache(): void {
    for (const s of this.#queryCache.values()) s.finalize();
    this.#queryCache.clear();
  }

  /** Runs every statement of `sql`; the first gets `params`. */
  run(query: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const h = this.#handle;
    h.idle();
    const conn = h.live;
    if (!conn) throw new Error("Database has closed");
    if (typeof query !== "string") throw new Error("Expected SQL string");
    if (!query.length) throw new Error("SQL string mustn't be blank");
    let changes: number | undefined;
    try {
      conn.eachStatement(query, (s) => {
        if (changes === undefined) bindArgs(s, params, !!(this.#flags & STRICT), false, !!(this.#flags & SAFE_INTEGERS));
        const canWrite = !s.readonly;
        const before = canWrite ? conn.totalChanges() : 0;
        while (s.step());
        changes = (changes ?? 0) + (canWrite ? changesSince(conn, before) : 0);
      });
    } catch (e) {
      throw h.error(e);
    }
    if (changes === undefined) throw new Error("Query contained no valid SQL statement; likely empty query.");
    return changesObject(conn, changes, !!(this.#flags & SAFE_INTEGERS));
  }

  /** The update hooks of SQLite (sqlite3_update_hook): called with the database, the table, the rowid and the schema. */
  get onInsert(): Fn | null {
    return this.#hook(0);
  }
  set onInsert(hook: Fn | null) {
    this.#setHook(0, hook);
  }
  get onUpdate(): Fn | null {
    return this.#hook(1);
  }
  set onUpdate(hook: Fn | null) {
    this.#setHook(1, hook);
  }
  get onDelete(): Fn | null {
    return this.#hook(2);
  }
  set onDelete(hook: Fn | null) {
    this.#setHook(2, hook);
  }

  #hook(i: number): Fn | null {
    this.#handle.idle();
    return this.#handle.hooks[i];
  }

  /**
   * One hook per kind of change, called after each row a statement inserts, updates or deletes, with the database,
   * the table, the rowid (a BigInt with safeIntegers) and the schema. What it throws is reported as an uncaught
   * error; the statement goes on.
   */
  #setHook(i: number, hook: Fn | null | undefined) {
    const h = this.#handle;
    h.idle();
    if (hook != null && typeof hook !== "function") throw new TypeError("Expected a function or null");
    const conn = h.live;
    if (!conn) throw new Error("Database has closed");
    h.hooks[i] = hook ?? null;
    const safe = !!(this.#flags & SAFE_INTEGERS);
    // SQLITE_INSERT 18, SQLITE_UPDATE 23, SQLITE_DELETE 9
    const kinds: Record<number, number> = { 18: 0, 23: 1, 9: 2 };
    conn.setUpdateHook(
      h.hooks.some(Boolean)
        ? (op, schema, table, rowid) => {
            const f = h.hooks[kinds[op]];
            if (!f) return;
            try {
              h.callback(() => f.call(this, this, table, safe ? rowid : Number(rowid), schema));
            } catch (e) {
              queueMicrotask(() => {
                throw e;
              });
            }
          }
        : null,
    );
  }

  /** A user function's result (a value Bun binds), or the TypeError it throws for one it can't. */
  #setResult(ctx: number, name: string, v: unknown, safe: boolean) {
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
  #fail = (ctx: number, e: unknown) => {
    this.#handle.pending = e;
    resultError(ctx, "");
  };

  /** The connection to define a function on. */
  #definable(): Conn {
    const h = this.#handle;
    h.idle();
    const conn = h.live;
    if (!conn) throw new Error("Database has closed");
    return conn;
  }

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
    const safe = booleanOption(options, "safeIntegers", !!(this.#flags & SAFE_INTEGERS));
    const flags = functionFlags(options);
    const nArg = booleanOption(options, "varargs") ? -1 : parameterCount(fn);
    const conn = this.#definable();
    const h = this.#handle;
    const f = fn;
    try {
      conn.createFunction(name, nArg, flags, {
        func: (ctx, argv) => {
          try {
            this.#setResult(ctx, name, h.callback(() => f(...argv.map((a) => valueOf(a, safe)))), safe);
          } catch (e) {
            this.#fail(ctx, e);
          }
        },
      });
    } catch (e) {
      throw h.error(e);
    }
    return this;
  }

  /** An aggregate: `start` (or a function making it), `step(acc, ...args)`, and `inverse` (a window function) and `result`. */
  aggregate(name: string, options: Record<string, unknown>): this {
    if (typeof name !== "string") throw new TypeError("Expected first argument to be a string");
    if (typeof options !== "object" || !options) throw new TypeError("Expected second argument to be an options object");
    if (!name) throw new TypeError("User-defined function name cannot be an empty string");
    const start = options.start;
    const step = functionOption(options, "step");
    if (!step) throw new TypeError('Missing required option "step"');
    const inverse = functionOption(options, "inverse");
    const done = functionOption(options, "result");
    const safe = booleanOption(options, "safeIntegers", !!(this.#flags & SAFE_INTEGERS));
    const flags = functionFlags(options);
    // The first parameter of `step` and `inverse` is the accumulator.
    const nArg = booleanOption(options, "varargs") ? -1 : Math.max(parameterCount(step), inverse ? parameterCount(inverse) : 0, 1) - 1;
    const conn = this.#definable();
    const h = this.#handle;
    const cb = (f: Fn) => (...a: unknown[]) => h.callback(() => f(...a));
    try {
      createAggregate(conn, name, nArg, flags, {
        start: typeof start === "function" ? cb(start as Fn) : (start ?? null),
        step: cb(step),
        inverse: inverse && cb(inverse),
        result: done && cb(done),
        self: undefined,
        keepOnUndefined: true,
        args: (argv) => argv.map((a) => valueOf(a, safe)),
        set: (ctx, v) => this.#setResult(ctx, name, v, safe),
        fail: this.#fail,
      });
    } catch (e) {
      throw h.error(e);
    }
    return this;
  }

  /** A statement of `query`, with `params` bound (an array, or an object of named values) and sqlite3_prepare_v3's `flags`. */
  prepare<R = unknown, P extends Params = any>(query: string, params?: P, flags = 0): Statement<R, P extends unknown[] ? P : [P]> {
    return new Statement(prepareOn(this.#handle, query, params == null ? undefined : [params], flags || 0, this.#flags)) as never;
  }

  #prepareOwned(query: string, flags: number): Statement {
    return new Statement(prepareOn(this.#handle, query, undefined, flags, this.#flags | OWNED));
  }

  static MAX_QUERY_CACHE_SIZE = 20;

  get [cachedCount](): number {
    return this.#queryCache.size;
  }

  /** A statement cached by its SQL (the MAX_QUERY_CACHE_SIZE last used): finalized with the database. */
  query<R = unknown, P extends Params = any>(query: string): Statement<R, P extends unknown[] ? P : [P]> {
    if (typeof query !== "string") throw new TypeError(`Expected 'query' to be a string, got '${typeof query}'`);
    if (query.length === 0) throw new Error("SQL query cannot be empty.");
    const cache = this.#queryCache;
    let stmt = cache.get(query);
    if (stmt !== undefined) {
      // LRU: re-insert so the most recently used key is last
      cache.delete(query);
      if (stmt.isFinalized) stmt = this.#prepareOwned(query, constants.SQLITE_PREPARE_PERSISTENT);
      cache.set(query, stmt);
      return stmt as never;
    }
    stmt = this.#prepareOwned(query, constants.SQLITE_PREPARE_PERSISTENT);
    const max = Database.MAX_QUERY_CACHE_SIZE;
    // A compiled statement is several times the size of its text.
    if (max > 0 && query.length <= 64 * 1024) {
      // evicted statements stay usable; close() still finalizes them
      if (cache.size >= max) cache.delete(cache.keys().next().value!);
      cache.set(query, stmt);
    }
    return stmt as never;
  }

  /**
   * `fn` in a transaction (a savepoint when already inside one) that rolls back if `fn` throws; also `.deferred`,
   * `.immediate` and `.exclusive`. An async `fn` commits when it returns its promise: unlike Bun, one rejected at once
   * (an async function that throws before its first `await`) isn't rolled back, as a promise's state can't be read.
   */
  transaction<A extends unknown[], T>(fn: (...args: A) => T, _self?: unknown) {
    if (typeof fn !== "function") throw new TypeError("Expected first argument to be a function");
    const c = (this.#transactions ??= this.#controller());
    const db = this;
    // (a method: Bun's function has no `prototype`)
    const wrap = ({ begin, commit, rollback, savepoint, release, rollbackTo }: Record<string, NativeStatement>) =>
      ({
        transaction(this: unknown, ...args: A): T {
          let before: NativeStatement, after: NativeStatement, undo: NativeStatement;
          if (db.inTransaction) {
            before = savepoint;
            after = release;
            undo = rollbackTo;
          } else {
            before = begin;
            after = commit;
            undo = rollback;
          }
          try {
            before.run();
            const result = fn.apply(this, args);
            after.run();
            return result;
          } catch (ex) {
            if (db.inTransaction) {
              undo.run();
              if (undo !== rollback) after.run();
            }
            throw ex;
          }
        },
      }).transaction;
    const properties = {
      default: { value: wrap(c.default) },
      deferred: { value: wrap(c.deferred) },
      immediate: { value: wrap(c.immediate) },
      exclusive: { value: wrap(c.exclusive) },
      database: { value: this, enumerable: true },
    };
    Object.defineProperties(properties.default.value, properties);
    Object.defineProperties(properties.deferred.value, properties);
    Object.defineProperties(properties.immediate.value, properties);
    Object.defineProperties(properties.exclusive.value, properties);
    return properties.default.value as ((...args: A) => T) & Record<"deferred" | "immediate" | "exclusive", (...args: A) => T> & { database: Database };
  }

  /** The statements of the database's transactions (prepared once, owned by the database). */
  #controller() {
    const own = (sql: string) => this.#prepareOwned(sql, 0).native;
    const shared = { commit: own("COMMIT"), rollback: own("ROLLBACK"), savepoint: own("SAVEPOINT `\t_bs3.\t`"), release: own("RELEASE `\t_bs3.\t`"), rollbackTo: own("ROLLBACK TO `\t_bs3.\t`") };
    return {
      default: { begin: own("BEGIN"), ...shared },
      deferred: { begin: own("BEGIN DEFERRED"), ...shared },
      immediate: { begin: own("BEGIN IMMEDIATE"), ...shared },
      exclusive: { begin: own("BEGIN EXCLUSIVE"), ...shared },
    };
  }
}

Database.prototype.exec = Database.prototype.run;
// How a library tells the SQLite modules of the runtimes apart. node:sqlite has it too.
(Database.prototype as unknown as Record<symbol, string>)[Symbol.for("sqlite-type")] = "bun:sqlite";

/** Closes the databases still open and sends their files to the page; the runtime calls this before Run/Stop terminates the worker. */
export function flushDatabases() {
  shutdown();
}

const toBuffer = (bytes: Uint8Array): Uint8Array => {
  const B = (globalThis as { Buffer?: { from(b: ArrayBufferLike, o: number, n: number): Uint8Array } }).Buffer;
  return B ? B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
};

// bun:sqlite's constants: open, prepare and deserialize flags, and the file control opcodes.
export const constants = {
  SQLITE_OPEN_READONLY: 0x00000001,
  SQLITE_OPEN_READWRITE: 0x00000002,
  SQLITE_OPEN_CREATE: 0x00000004,
  SQLITE_OPEN_DELETEONCLOSE: 0x00000008,
  SQLITE_OPEN_EXCLUSIVE: 0x00000010,
  SQLITE_OPEN_AUTOPROXY: 0x00000020,
  SQLITE_OPEN_URI: 0x00000040,
  SQLITE_OPEN_MEMORY: 0x00000080,
  SQLITE_OPEN_MAIN_DB: 0x00000100,
  SQLITE_OPEN_TEMP_DB: 0x00000200,
  SQLITE_OPEN_TRANSIENT_DB: 0x00000400,
  SQLITE_OPEN_MAIN_JOURNAL: 0x00000800,
  SQLITE_OPEN_TEMP_JOURNAL: 0x00001000,
  SQLITE_OPEN_SUBJOURNAL: 0x00002000,
  SQLITE_OPEN_SUPER_JOURNAL: 0x00004000,
  SQLITE_OPEN_NOMUTEX: 0x00008000,
  SQLITE_OPEN_FULLMUTEX: 0x00010000,
  SQLITE_OPEN_SHAREDCACHE: 0x00020000,
  SQLITE_OPEN_PRIVATECACHE: 0x00040000,
  SQLITE_OPEN_WAL: 0x00080000,
  SQLITE_OPEN_NOFOLLOW: 0x01000000,
  SQLITE_OPEN_EXRESCODE: 0x02000000,
  SQLITE_PREPARE_PERSISTENT: 0x01,
  SQLITE_PREPARE_NORMALIZE: 0x02,
  SQLITE_PREPARE_NO_VTAB: 0x04,

  SQLITE_DESERIALIZE_READONLY: 0x00000004,

  SQLITE_FCNTL_LOCKSTATE: 1,
  SQLITE_FCNTL_GET_LOCKPROXYFILE: 2,
  SQLITE_FCNTL_SET_LOCKPROXYFILE: 3,
  SQLITE_FCNTL_LAST_ERRNO: 4,
  SQLITE_FCNTL_SIZE_HINT: 5,
  SQLITE_FCNTL_CHUNK_SIZE: 6,
  SQLITE_FCNTL_FILE_POINTER: 7,
  SQLITE_FCNTL_SYNC_OMITTED: 8,
  SQLITE_FCNTL_WIN32_AV_RETRY: 9,
  SQLITE_FCNTL_PERSIST_WAL: 10,
  SQLITE_FCNTL_OVERWRITE: 11,
  SQLITE_FCNTL_VFSNAME: 12,
  SQLITE_FCNTL_POWERSAFE_OVERWRITE: 13,
  SQLITE_FCNTL_PRAGMA: 14,
  SQLITE_FCNTL_BUSYHANDLER: 15,
  SQLITE_FCNTL_TEMPFILENAME: 16,
  SQLITE_FCNTL_MMAP_SIZE: 18,
  SQLITE_FCNTL_TRACE: 19,
  SQLITE_FCNTL_HAS_MOVED: 20,
  SQLITE_FCNTL_SYNC: 21,
  SQLITE_FCNTL_COMMIT_PHASETWO: 22,
  SQLITE_FCNTL_WIN32_SET_HANDLE: 23,
  SQLITE_FCNTL_WAL_BLOCK: 24,
  SQLITE_FCNTL_ZIPVFS: 25,
  SQLITE_FCNTL_RBU: 26,
  SQLITE_FCNTL_VFS_POINTER: 27,
  SQLITE_FCNTL_JOURNAL_POINTER: 28,
  SQLITE_FCNTL_WIN32_GET_HANDLE: 29,
  SQLITE_FCNTL_PDB: 30,
  SQLITE_FCNTL_BEGIN_ATOMIC_WRITE: 31,
  SQLITE_FCNTL_COMMIT_ATOMIC_WRITE: 32,
  SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE: 33,
  SQLITE_FCNTL_LOCK_TIMEOUT: 34,
  SQLITE_FCNTL_DATA_VERSION: 35,
  SQLITE_FCNTL_SIZE_LIMIT: 36,
  SQLITE_FCNTL_CKPT_DONE: 37,
  SQLITE_FCNTL_RESERVE_BYTES: 38,
  SQLITE_FCNTL_CKPT_START: 39,
  SQLITE_FCNTL_EXTERNAL_READER: 40,
  SQLITE_FCNTL_CKSM_FILE: 41,
  SQLITE_FCNTL_RESET_CACHE: 42,
};

// As Bun's module object: `import Database from "bun:sqlite"` is the class.
export default { __esModule: true, Database, Statement, constants, default: Database, SQLiteError };
