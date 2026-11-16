// `bun:sqlite` on top of sql.js (SQLite compiled to wasm). sql.js loads asynchronously, so the wrapper module of
// `bun:sqlite` awaits `globalThis.__loadBunSqlite()` first; after that `new Database()` is synchronous.
// File databases persist: the bytes are read from the worker's VFS on open and written back with `db.export()`
// (debounced after a write, and on close). Writes go through the fs shim, so the page's file tree and OPFS mirror see them.
//
// What sql.js does not expose is rebuilt here: the extended result code of an error (SQLiteError derives it from the
// message), the bound-parameter count and expanded SQL (a small tokenizer over the SQL text), and the autocommit state
// (tracked from the transaction statements that run). Exact 64-bit integers come from sql.js's `useBigInt` reads.
import type { BindParams, Database as SqlJsDb, SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { norm } from "@runbun/vfs";
import fs from "./fs";
import path from "./path";
import { quietTimeout } from "../loop";

let SQL: SqlJsStatic | undefined;

(globalThis as Record<string, unknown>).__loadBunSqlite = async () => {
  if (SQL) return;
  const { default: init } = await import("sql.js");
  SQL = await init({ locateFile: () => new URL(wasmUrl, location.href).href });
};

type Params = unknown[] | Record<string, unknown>;
interface Options {
  create?: boolean;
  readonly?: boolean;
  readwrite?: boolean;
  strict?: boolean;
  safeIntegers?: boolean;
}

const FLUSH_MS = 200;
const isRead = (sql: string) => /^\s*(select|explain|values)\b|^\s*pragma\s+[\w.]+\s*(;|$)/i.test(sql);

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

const CODES: Record<number, string> = {
  1: "SQLITE_ERROR",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM",
  8: "SQLITE_READONLY",
  9: "SQLITE_INTERRUPT",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  25: "SQLITE_RANGE",
  26: "SQLITE_NOTADB",
  275: "SQLITE_CONSTRAINT_CHECK",
  787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1299: "SQLITE_CONSTRAINT_NOTNULL",
  1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  1811: "SQLITE_CONSTRAINT_TRIGGER",
  2067: "SQLITE_CONSTRAINT_UNIQUE",
};

const utf8 = new TextEncoder();

/** The result code of an error sql.js threw (it only keeps sqlite3_errmsg): the extended one for constraints. */
function classify(message: string, db: SqlJsDb | undefined): number {
  const unique = /^UNIQUE constraint failed: (.+)$/.exec(message);
  if (unique) {
    // A PRIMARY KEY violation has the same message; it is one when the failed columns are the table's key
    const cols = unique[1].split(", ").map((c) => c.split("."));
    const table = cols[0][0];
    try {
      const info = db?.exec(`pragma table_info(${JSON.stringify(table)})`)[0];
      if (info && cols.every(([, c]) => info.values.some((r) => r[1] === c && (r[5] as number) > 0)) && !/^index /.test(unique[1])) return 1555;
    } catch {}
    return 2067;
  }
  if (/^NOT NULL constraint failed/.test(message)) return 1299;
  if (/^CHECK constraint failed/.test(message)) return 275;
  if (/^FOREIGN KEY constraint failed/.test(message)) return 787;
  if (/constraint failed/.test(message)) return 19;
  if (/readonly database/.test(message)) return 8;
  if (/unable to open database file/.test(message)) return 14;
  if (/file is not a database/.test(message)) return 26;
  if (/database is locked/.test(message)) return 5;
  if (/database table is locked/.test(message)) return 6;
  if (/database or disk is full/.test(message)) return 13;
  if (/datatype mismatch/.test(message)) return 20;
  if (/string or blob too big/.test(message)) return 18;
  if (/column index out of range|bind or column index/.test(message)) return 25;
  if (/malformed|corrupt/.test(message)) return 11;
  if (/^interrupted/.test(message)) return 9;
  return 1;
}

/** sql.js throws `Error(sqlite3_errmsg)`; turn that into what Bun throws. `sql` is the text that was being prepared. */
function sqliteError(e: unknown, sql: string | undefined, db: SqlJsDb | undefined): unknown {
  if (e instanceof SQLiteError || !(e instanceof Error) || e.name !== "Error") return e;
  const errno = classify(e.message, db);
  const near = /^near "([^"]*)": syntax error$/.exec(e.message);
  const at = near && sql !== undefined ? sql.indexOf(near[1]) : -1;
  const byteOffset = at >= 0 ? utf8.encode(sql!.slice(0, at)).length : -1;
  return new SQLiteError(e.message, { code: CODES[errno] ?? "SQLITE_ERROR", errno, byteOffset }, INTERNAL);
}

function cantOpen(): SQLiteError {
  return new SQLiteError("unable to open database file", { code: "SQLITE_CANTOPEN", errno: 14, byteOffset: -1 }, INTERNAL);
}

// --- parameters --------------------------------------------------------------------------------------------------

interface Param {
  /** The token as written (`?`, `?3`, `$a`, `:a`, `@a`). */
  text: string;
  start: number;
  end: number;
  /** SQLite's 1-based index for it (named parameters share one per name). */
  index: number;
  /** The name without its prefix; undefined for `?`/`?N`. */
  name?: string;
}

/** The parameter tokens of `sql`, skipping strings, quoted identifiers and comments, numbered as SQLite numbers them. */
function paramTokens(sql: string): { params: Param[]; count: number } {
  const params: Param[] = [];
  const named = new Map<string, number>();
  let count = 0;
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] !== close) continue;
        if (c === "[" || sql[j + 1] !== close) break;
        j++; // a doubled quote is an escaped one
      }
      i = j + 1;
    } else if (two === "--") {
      const j = sql.indexOf("\n", i);
      i = j < 0 ? sql.length : j + 1;
    } else if (two === "/*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? sql.length : j + 2;
    } else if (c === "?") {
      let j = i + 1;
      while (/\d/.test(sql[j] ?? "")) j++;
      const n = j > i + 1 ? Number(sql.slice(i + 1, j)) : ++count;
      count = Math.max(count, n);
      params.push({ text: sql.slice(i, j), start: i, end: j, index: n });
      i = j;
    } else if ((c === ":" || c === "@" || c === "$") && /[\w]/.test(sql[i + 1] ?? "") && !(c === "$" && /\w/.test(sql[i - 1] ?? ""))) {
      let j = i + 1;
      while (/\w/.test(sql[j] ?? "")) j++;
      const text = sql.slice(i, j);
      let n = named.get(text);
      if (n === undefined) named.set(text, (n = ++count));
      params.push({ text, start: i, end: j, index: n, name: text.slice(1) });
      i = j;
    } else i++;
  }
  return { params, count };
}

const BIGINT_MAX = 2n ** 63n - 1n;
const BIGINT_MIN = -(2n ** 63n);

/** `safe` (safeIntegers): a BigInt outside the 64-bit range is an error; without it Bun binds whatever fits. */
function bindable(v: unknown, safe = false): unknown {
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

const isNamed = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer) && !Array.isArray(v);

/**
 * What the arguments of `all(...)`, `run(...)` and friends bind: an array or several values bind to `?` in order, an
 * object by name (a key may drop its `$`/`:`/`@` prefix; with `strict`, a name the object lacks is an error, else NULL).
 */
function bindings(args: unknown[], tokens: { params: Param[]; count: number }, strict: boolean, checkCount: boolean, safe: boolean): { bind: BindParams; values: Map<number, unknown> } {
  const values = new Map<number, unknown>();
  const first = args[0];
  if (args.length === 1 && isNamed(first)) {
    const out: Record<string, unknown> = {};
    for (const p of tokens.params) {
      if (!p.name) continue;
      const has = p.text in first ? p.text : p.name in first ? p.name : undefined;
      if (has === undefined) {
        if (strict) throw new Error(`Missing parameter "${p.name}"`);
        out[p.text] = null;
      } else out[p.text] = bindable(first[has], safe);
      values.set(p.index, out[p.text]);
    }
    return { bind: out as BindParams, values };
  }
  const list = args.length === 1 && Array.isArray(first) ? first : args;
  if (checkCount && list.length && list.length !== tokens.count) throw new Error(`SQLite query expected ${tokens.count} values, received ${list.length}`);
  const out = list.map((v) => bindable(v, safe));
  out.forEach((v, i) => values.set(i + 1, v));
  return { bind: out as BindParams, values };
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof Uint8Array) return `x'${[...v].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  return String(v);
}

// --- statements --------------------------------------------------------------------------------------------------

/** sql.js 1.16 reads INTEGER columns as exact BigInt with `useBigInt`; its typings predate that. */
const rows = (safe: boolean) => ({ useBigInt: safe });
interface Loose {
  get(params: null, config: object): unknown[];
  getAsObject(params: null, config: object): Record<string, unknown>;
  exec(sql: string, params: null, config: object): { values: unknown[][] }[];
}

export class Statement<R = unknown, P extends unknown[] = any[]> {
  private cls: (new (...args: any[]) => unknown) | undefined;
  private safe: boolean;
  private done = false;
  private tokens: ReturnType<typeof paramTokens> | undefined;
  private lastValues = new Map<number, unknown>();

  constructor(
    private db: Database,
    readonly native: string,
  ) {
    this.safe = db._safe;
  }

  private get toks() {
    return (this.tokens ??= paramTokens(this.native));
  }

  /** Runs the statement, calling `fn` with the open sql.js statement for each row until it returns false. */
  private each(params: unknown[], fn: (s: ReturnType<SqlJsDb["prepare"]>) => boolean | void): void {
    if (this.done) throw new Error("Statement has finalized");
    this.db._open("Database has closed", Error);
    this.db._note(this.native);
    const { bind, values } = bindings(params, this.toks, this.db._strict, true, this.safe);
    this.lastValues = values;
    let s: ReturnType<SqlJsDb["prepare"]>;
    try {
      s = this.db._raw.prepare(this.native);
    } catch (e) {
      throw sqliteError(e, this.native, this.db._raw);
    }
    try {
      s.bind(bind);
      while (s.step()) if (fn(s) === false) break;
    } catch (e) {
      throw sqliteError(e, undefined, this.db._raw);
    } finally {
      s.free();
    }
  }

  private row(s: ReturnType<SqlJsDb["prepare"]>): R {
    const row = (s as unknown as Loose).getAsObject(null, rows(this.safe)) as R;
    if (this.cls) Object.setPrototypeOf(row, this.cls.prototype);
    return row;
  }

  get columnNames(): string[] {
    if (this.done) throw new Error("Statement has finalized");
    this.db._open("Database has closed", Error);
    try {
      const s = this.db._raw.prepare(this.native);
      try {
        return s.getColumnNames();
      } finally {
        s.free();
      }
    } catch (e) {
      throw sqliteError(e, this.native, this.db._raw);
    }
  }

  get paramsCount(): number {
    return this.toks.count;
  }

  get isFinalized(): boolean {
    return this.done;
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
    this.each(params, (s) => void out.push((s as unknown as Loose).get(null, rows(this.safe))));
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

  /** The SQL with the last bound values written in (NULL for those not bound), as SQLite's `sqlite3_expanded_sql`. */
  toString(): string {
    let out = "";
    let at = 0;
    for (const p of this.toks.params) {
      out += this.native.slice(at, p.start) + literal(this.lastValues.get(p.index));
      at = p.end;
    }
    return out + this.native.slice(at);
  }

  toJSON(): string {
    return this.toString();
  }

  finalize(): void {
    this.done = true;
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
  _raw: SqlJsDb;
  _strict: boolean;
  _safe: boolean;
  readonly filename: string;
  private cache = new Map<string, Statement>();
  /** VFS key of the backing file; undefined for in-memory databases and readonly ones (which never write back). */
  private file: string | undefined;
  private dirty = false;
  private inTx = false;
  private closed = false;
  private depth = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(filename: string | Uint8Array = ":memory:", options: number | Options = {}) {
    if (!SQL) throw new Error("bun:sqlite is not loaded yet");
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
    if (filename instanceof Uint8Array || filename === "" || filename === ":memory:") {
      this._raw = new SQL.Database(filename instanceof Uint8Array ? filename : undefined);
    } else {
      const key = norm(path.resolve(String(filename)));
      let bytes: Uint8Array | undefined;
      if (fs.existsSync(key)) {
        try {
          bytes = fs.readFileSync(key) as Uint8Array;
        } catch {
          throw cantOpen();
        }
      } else if (!create) throw cantOpen();
      this._raw = new SQL.Database(bytes?.byteLength ? bytes : undefined);
      if (!readonly) {
        this.file = key;
        openFiles.add(this);
        if (!bytes) this.touch(); // Bun creates the file on open
      }
    }
    if (readonly) this._raw.run("pragma query_only = 1");
  }

  /** A database from the bytes `serialize()` returned (or any SQLite file). `true` or `{ readonly: true }` opens it read-only. */
  static deserialize(data: Uint8Array | ArrayBuffer, options?: boolean | number | Options): Database {
    if (!ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) throw new TypeError(`Expected 'serialized' to be a TypedArray or ArrayBuffer, got '${data === null ? "null" : typeof data}'`);
    const bytes = bindable(data) as Uint8Array;
    if (!bytes.byteLength) throw new Error("ArrayBuffer must not be empty");
    const o: Options = typeof options === "object" && options ? options : { readonly: options === true || (typeof options === "number" && !!(options & 1)) };
    return new Database(bytes, o);
  }

  /** Runs `fn` on the raw database, throwing what Bun throws for a SQLite error. */
  private raw<T>(sql: string | undefined, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw sqliteError(e, sql, this._raw);
    }
  }

  _open(message = "Cannot use a closed database", E: new (m: string) => Error = RangeError) {
    if (this.closed) throw new E(message);
  }

  private touch() {
    this.dirty = true;
    this.timer ??= quietTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Called with the SQL of everything that runs: reads leave the database clean, transaction statements move `inTransaction`. */
  _note(sql: string) {
    if (/^\s*(begin|savepoint)\b/i.test(sql)) this.inTx = true;
    else if (/^\s*(commit|end|rollback)\b(?!\s+(transaction\s+)?to\b)/i.test(sql)) this.inTx = false;
    if (!this.file || isRead(sql)) return;
    this.touch();
  }

  get inTransaction(): boolean {
    this._open();
    return this.inTx;
  }

  /** Write the database back to the VFS now. sql.js `export()` closes and reopens the connection, so skip it mid-transaction. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file || !this.dirty) return;
    if (this.inTx) return void this.touch();
    this.dirty = false;
    fs.writeFileSync(this.file, this.bytes());
  }

  /** The database file's bytes. `export()` also resets per-connection pragmas, so put `foreign_keys` back. */
  private bytes(): Uint8Array {
    const fk = this._raw.exec("pragma foreign_keys")[0]?.values[0][0];
    const bytes = this._raw.export();
    if (fk) this._raw.run("pragma foreign_keys = on");
    return bytes;
  }

  _changes(): number {
    return this._raw.exec("select total_changes()")[0].values[0][0] as number;
  }

  /** `changes` is what the statement changed (as SQLite's total_changes grew), not the last write's count. */
  _meta(before: number, safe = this._safe) {
    const id = (this._raw as unknown as Loose).exec("select last_insert_rowid()", null, rows(true))[0].values[0][0] as bigint;
    return { changes: this._changes() - before, lastInsertRowid: safe ? id : Number(id) };
  }

  _forget(s: Statement) {
    for (const [k, v] of this.cache) if (v === s) this.cache.delete(k);
  }

  run(sql: string, ...params: unknown[]) {
    this._open();
    if (!sql.trim()) throw new Error("SQL string mustn't be blank");
    this._note(sql);
    const before = this._changes();
    const { bind } = bindings(params, paramTokens(sql), this._strict, false, this._safe);
    this.raw(sql, () => (params.length ? this._raw.run(sql, bind) : this._raw.run(sql)));
    return this._meta(before);
  }

  exec = this.run;

  /** Fail now, as Bun does, when `sql` does not compile. */
  private check(sql: string) {
    this._open();
    if (!sql.trim()) throw new Error("SQL query cannot be empty.");
    this.raw(sql, () => this._raw.prepare(sql).free());
  }

  query<R = unknown, P extends Params = any>(sql: string): Statement<R, P extends unknown[] ? P : [P]> {
    let s = this.cache.get(sql);
    if (!s) {
      this.check(sql);
      this.cache.set(sql, (s = new Statement(this, sql)));
    }
    return s as never;
  }

  prepare<R = unknown, P extends Params = any>(sql: string): Statement<R, P extends unknown[] ? P : [P]> {
    this.check(sql);
    return new Statement(this, sql) as never;
  }

  clearQueryCache(): void {
    this.cache.clear();
  }

  /** `fn` in a transaction (a savepoint when already inside one); it rolls back if `fn` throws. Also `.deferred`, `.immediate`, `.exclusive`. */
  transaction<A extends unknown[], T>(fn: (...args: A) => T) {
    const make = (mode: string) =>
      (...args: A): T => {
        this._open();
        const nested = this.inTx;
        const sp = `bun_sqlite_${this.depth++}`;
        try {
          this.raw(undefined, () => this._raw.run(nested ? `savepoint ${sp}` : `begin ${mode}`));
          this.inTx = true;
          try {
            const r = fn(...args);
            this.raw(undefined, () => this._raw.run(nested ? `release ${sp}` : "commit"));
            this.inTx = nested;
            this._note("insert"); // the transaction wrote something
            return r;
          } catch (e) {
            try {
              this._raw.run(nested ? `rollback to ${sp}; release ${sp}` : "rollback");
            } catch {}
            this.inTx = nested;
            throw e;
          }
        } finally {
          this.depth--;
        }
      };
    return Object.assign(make(""), { deferred: make("deferred"), immediate: make("immediate"), exclusive: make("exclusive") });
  }

  serialize(_name?: string): Uint8Array {
    this._open();
    return toBuffer(this.bytes());
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
    this._raw.close();
  }
}

// bun:sqlite's constants (the SQLITE_OPEN_* flags `new Database(path, flags)` takes)
export const constants = {
  SQLITE_OPEN_READONLY: 1,
  SQLITE_OPEN_READWRITE: 2,
  SQLITE_OPEN_CREATE: 4,
};

export default { Database, Statement, SQLiteError, constants };
