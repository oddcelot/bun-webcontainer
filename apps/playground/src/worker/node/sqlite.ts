// `bun:sqlite` on SQLite compiled to wasm (sqliteEngine.ts, the official build), driven through the C API as Bun's
// bindings drive the native library: statements stay prepared, values bind with sqlite3_bind_*, errors carry the
// extended result code and sqlite3_error_offset. The engine loads asynchronously, so the wrapper module of
// `bun:sqlite` awaits `globalThis.__loadBunSqlite()` first; after that `new Database()` is synchronous.
// A file database is a file of the program's VFS that SQLite reads and writes in place (sqliteVfs.ts), with its
// journal or WAL next to it, so the page's file tree and storage see it as they see any file the program writes.
import { norm } from "@runbun/vfs";
import path from "./path";
import { Conn, DBCONFIG_DEFENSIVE, DBCONFIG_DQS_DDL, DBCONFIG_DQS_DML, RawError, createAggregate, loaded, shutdown, rcName, result, resultError, valueOf, type Stmt, type Value } from "./sqliteEngine";

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

/** What Bun throws for a SQLite error; a user function's own error (`pending`) passes through. */
function sqliteError(e: unknown, db?: Database): unknown {
  const own = db?._pending;
  if (db) db._pending = undefined;
  if (own !== undefined) return own;
  if (!(e instanceof RawError)) return e;
  return new SQLiteError(e.message, { code: rcName(e.errno) ?? "SQLITE_ERROR", errno: e.errno, byteOffset: e.byteOffset }, INTERNAL);
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

/** Closes the databases still open and sends their files to the page; the runtime calls this before Run/Stop terminates the worker. */
export function flushDatabases() {
  shutdown();
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
  private closed = false;
  private depth = 0;
  /** Inside a user function or an update hook: Bun refuses every use of the connection there. */
  private busy = 0;
  /** onInsert, onUpdate, onDelete */
  private hooks: (Fn | null)[] = [null, null, null];

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
    const name = filename instanceof Uint8Array || filename === "" || filename === ":memory:" ? ":memory:" : "/" + norm(path.resolve(String(filename)));
    try {
      if (filename instanceof Uint8Array) this._conn = Conn.memory(filename, readonly);
      else this._conn = new Conn(name, readonly ? 1 : create ? 6 : 2);
    } catch (e) {
      throw sqliteError(e);
    }
    // As Bun opens a database: defensive, and double-quoted string literals as the library has them (on).
    this._conn.dbConfig(DBCONFIG_DEFENSIVE, 1);
    this._conn.dbConfig(DBCONFIG_DQS_DML, 1);
    this._conn.dbConfig(DBCONFIG_DQS_DDL, 1);
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
    this._idle();
    if (this.closed) throw new E(message);
  }

  _idle() {
    if (this.busy) throw new TypeError("This database connection is busy executing a query");
  }

  /** Runs a user callback (a function, an aggregate's step, an update hook): the connection is busy meanwhile. */
  _callback<T>(fn: () => T): T {
    this.busy++;
    try {
      return fn();
    } finally {
      this.busy--;
    }
  }

  get onInsert(): Fn | null {
    return this.hook(0);
  }
  set onInsert(hook: Fn | null) {
    this.setHook(0, hook);
  }
  get onUpdate(): Fn | null {
    return this.hook(1);
  }
  set onUpdate(hook: Fn | null) {
    this.setHook(1, hook);
  }
  get onDelete(): Fn | null {
    return this.hook(2);
  }
  set onDelete(hook: Fn | null) {
    this.setHook(2, hook);
  }

  private hook(i: number): Fn | null {
    this._idle();
    return this.hooks[i];
  }

  /**
   * The update hook of SQLite (sqlite3_update_hook), one per kind of change: called with the database, the table,
   * the rowid (a BigInt with safeIntegers) and the schema after each row a statement inserts, updates or deletes. What
   * it throws is reported as an uncaught error; the statement goes on.
   */
  private setHook(i: number, hook: Fn | null | undefined) {
    this._idle();
    if (hook != null && typeof hook !== "function") throw new TypeError("Expected a function or null");
    if (this.closed) throw new Error("Database has closed");
    this.hooks[i] = hook ?? null;
    const safe = this._safe;
    // SQLITE_INSERT 18, SQLITE_UPDATE 23, SQLITE_DELETE 9
    const kinds: Record<number, number> = { 18: 0, 23: 1, 9: 2 };
    this._conn.setUpdateHook(
      this.hooks.some(Boolean)
        ? (op, schema, table, rowid) => {
            const f = this.hooks[kinds[op]];
            if (!f) return;
            try {
              this._callback(() => f.call(this, this, table, safe ? rowid : Number(rowid), schema));
            } catch (e) {
              queueMicrotask(() => {
                throw e;
              });
            }
          }
        : null,
    );
  }

  get inTransaction(): boolean {
    this._open();
    return !this._conn.autocommit;
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
            this.setResult(ctx, name, this._callback(() => f(...argv.map((a) => valueOf(a, safe)))), safe);
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
        start: typeof options.start === "function" ? (...a: unknown[]) => this._callback(() => (options.start as Fn)(...a)) : (options.start ?? null),
        step: (...a: unknown[]) => this._callback(() => step(...a)),
        inverse: inverse && ((...a: unknown[]) => this._callback(() => inverse(...a))),
        result: done && ((...a: unknown[]) => this._callback(() => done(...a))),
        self: undefined,
        keepOnUndefined: true,
        args: (argv) => argv.map((a) => valueOf(a, safe)),
        set: (ctx, v) => this.setResult(ctx, name, v, safe),
        fail: this.fail,
      }),
    );
    return this;
  }

  /**
   * sqlite3_file_control: `fileControl(op, arg)` on the main database, or `fileControl(schema, op, arg)`. `arg` is a
   * number (an int64 SQLite may read), a TypedArray of at least 8 bytes (SQLite may write to it) or null. Returns
   * SQLite's result code (SQLITE_NOTFOUND, 12, for an opcode nothing answers).
   */
  fileControl(zDbName: unknown, op?: unknown, arg?: unknown): number | undefined {
    if (typeof zDbName === "string" || arguments.length > 2) return this.fcntl(zDbName, op, arg);
    return this.fcntl(null, zDbName, op);
  }

  private fcntl(schema: unknown, opNumber: unknown, value: unknown): number | undefined {
    this._idle();
    if (typeof opNumber !== "number") throw new Error("Expected number");
    const op = opNumber | 0;
    if (this.closed) return undefined;
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
    const rc = this._conn.fileControl(typeof schema === "string" ? schema : null, op, arg, owns);
    if (rc === 1) {
      const e = this._conn.error();
      // (SQLite can leave no error on the connection: no code then, as in Bun)
      throw new SQLiteError(e.message, { ...(e.errno ? { code: rcName(e.errno) } : {}), errno: e.errno, byteOffset: -1 } as never, INTERNAL);
    }
    return rc;
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
    this._idle();
    if (this.closed) return;
    this.closed = true;
    this.hooks = [null, null, null];
    this.cache.clear();
    this._conn.close();
  }
}

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

export default { Database, Statement, SQLiteError, constants };
