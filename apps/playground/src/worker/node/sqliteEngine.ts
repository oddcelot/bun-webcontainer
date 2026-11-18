// SQLite itself for bun:sqlite (sqlite.ts) and node:sqlite (nodeSqlite.ts): the official wasm build
// (@sqlite.org/sqlite-wasm), driven through its C API as Bun's bindings drive the native library. Databases live in
// wasm memory (no OPFS, no threads, no SharedArrayBuffer): a file database is read from the VFS on open
// (sqlite3_deserialize) and written back with sqlite3_serialize by its owner.
//
// The engine loads on first use: the wrapper module of `bun:sqlite`/`node:sqlite` awaits `globalThis.__loadBunSqlite()`
// (moduleServer.ts), after which everything here is synchronous.
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?url";

type Fn = (...args: any[]) => any;
interface Wasm {
  exports: Record<string, Fn>;
  heap8u(): Uint8Array;
  alloc(n: number): number;
  dealloc(p: number): void;
  peekPtr(p: number): number;
  peek32(p: number): number;
  poke32(p: number, v: number): void;
  cstrToJs(p: number): string | null;
  installFunction(sig: string, fn: Fn): number;
  uninstallFunction(p: number): void;
}

let x: Record<string, Fn>;
let w: Wasm;
let capi: Record<string, any>;

export const loaded = () => !!w;

(globalThis as Record<string, unknown>).__loadBunSqlite = async () => {
  if (w) return;
  const g = globalThis as Record<string, unknown>;
  // No OPFS VFS (it would need COOP/COEP or ask for storage), and no warnings in the program's console.
  const quiet = () => {};
  g.sqlite3ApiConfig = { warn: quiet, debug: quiet, log: quiet, error: quiet, disable: { vfs: { opfs: true, "opfs-vfs": true, "opfs-sahpool": true, "opfs-wl": true } } };
  try {
    const { default: init } = await import("@sqlite.org/sqlite-wasm");
    const sqlite3 = (await (init as unknown as (o: object) => Promise<{ wasm: Wasm; capi: Record<string, any> }>)({
      locateFile: () => new URL(wasmUrl, location.href).href,
      print: quiet,
      printErr: quiet,
    })) as { wasm: Wasm; capi: Record<string, any> };
    capi = sqlite3.capi;
    x = sqlite3.wasm.exports;
    w = sqlite3.wasm;
    scratch = w.alloc(16);
  } finally {
    // The glue leaves these on the global object; a program shouldn't see them.
    for (const k of ["sqlite3ApiConfig", "sqlite3InitModule", "sqlite3InitModuleState", "sqlite3Worker1Promiser"]) delete g[k];
  }
};

/** 16 bytes for out-parameters (sqlite3** / sqlite3_stmt** / tails / sizes). */
let scratch = 0;

const enc = new TextEncoder();
const dec = new TextDecoder();
const TRANSIENT = -1;

export const SQLITE_ROW = 100;
export const SQLITE_DONE = 101;
const INTEGER = 1;
const FLOAT = 2;
const TEXT = 3;
const BLOB = 4;

/** A SQLite error: sqlite3_errmsg, the extended result code and sqlite3_error_offset (-1 when there's none). */
export class RawError extends Error {
  constructor(
    message: string,
    readonly errno: number,
    readonly byteOffset = -1,
  ) {
    super(message);
  }
}

/** UTF-8 copy of `s` in wasm memory (NUL-terminated); the caller frees it. */
function cstr(s: string): [number, number] {
  const bytes = enc.encode(s);
  const p = w.alloc(bytes.length + 1);
  const heap = w.heap8u();
  heap.set(bytes, p);
  heap[p + bytes.length] = 0;
  return [p, bytes.length];
}

const text = (p: number, n: number) => (n ? dec.decode(w.heap8u().subarray(p, p + n)) : "");
const bytes = (p: number, n: number) => (n ? w.heap8u().slice(p, p + n) : new Uint8Array(0));
const str = (p: number) => (p ? w.cstrToJs(p) : null);

/** sqlite3_errstr of result code `rc`. */
export const errstr = (rc: number) => str(x.sqlite3_errstr(rc)) ?? "unknown error";

/** A value bound to a parameter or returned from a function: `int` is what to do with an integral number. */
export type Value = null | number | bigint | string | Uint8Array;

export class Conn {
  ptr: number;
  private stmts = new Set<Stmt>();

  /** An in-memory database, holding `image` (a database file's bytes) when given. */
  constructor(image?: Uint8Array, readonly = false) {
    const rc = x.sqlite3_open_v2(cstrOnce(":memory:"), scratch, 0x06 /* READWRITE | CREATE */, 0);
    this.ptr = w.peekPtr(scratch);
    if (rc) {
      const e = this.error();
      x.sqlite3_close_v2(this.ptr);
      throw e;
    }
    x.sqlite3_extended_result_codes(this.ptr, 1);
    // The wasm build's defaults where they differ from the SQLite native Bun uses (8 KiB pages, recursive triggers
    // on); a page size only applies to a database that is still empty.
    this.exec("pragma page_size = 4096; pragma recursive_triggers = 0");
    if (image) this.load(image, readonly);
  }

  /** Runs every statement of `sql` to completion. */
  exec(sql: string) {
    this.eachStatement(sql, (s) => {
      while (s.step());
    });
  }

  /** Replaces the database with `image` (sqlite3_deserialize: SQLite owns the copy and may grow it). */
  load(image: Uint8Array, readonly = false) {
    // SQLite can read a few bytes past the end of a malformed image (as Bun allocates it).
    const p = x.sqlite3_malloc64(BigInt(image.byteLength + 20));
    w.heap8u().fill(0, p + image.byteLength, p + image.byteLength + 20);
    w.heap8u().set(image, p);
    // SQLITE_DESERIALIZE_FREEONCLOSE | RESIZEABLE, or READONLY
    const rc = x.sqlite3_deserialize(this.ptr, cstrOnce("main"), p, BigInt(image.byteLength), BigInt(image.byteLength + 20), readonly ? 1 | 4 : 1 | 2);
    if (rc) throw this.error();
  }

  /** The current error of the connection; `base` is added to its byte offset (the statement's start in the caller's SQL). */
  error(base = 0): RawError {
    const off = x.sqlite3_error_offset(this.ptr);
    return new RawError(str(x.sqlite3_errmsg(this.ptr)) ?? "unknown error", x.sqlite3_extended_errcode(this.ptr), off >= 0 ? off + base : -1);
  }

  check(rc: number, base = 0) {
    if (rc) throw this.error(base);
  }

  dbConfig(op: number, on: number) {
    capi.sqlite3_db_config(this.ptr, op, on, 0);
  }

  get autocommit(): boolean {
    return !!x.sqlite3_get_autocommit(this.ptr);
  }
  changes(): number {
    return Number(x.sqlite3_changes64(this.ptr));
  }
  totalChanges(): number {
    return Number(x.sqlite3_total_changes64(this.ptr));
  }
  lastInsertRowid(): bigint {
    return BigInt(x.sqlite3_last_insert_rowid(this.ptr));
  }

  /** Every statement of `sql` in turn (prepared, then handed to `each`, then finalized); the empty ones are skipped. */
  eachStatement(sql: string, each: (s: Stmt, index: number) => void, flags = 0) {
    const [start, n] = cstr(sql);
    try {
      let at = start;
      for (let i = 0; at < start + n; ) {
        const rc = x.sqlite3_prepare_v3(this.ptr, at, start + n - at, flags, scratch, scratch + 4);
        const p = w.peekPtr(scratch);
        const tail = w.peekPtr(scratch + 4);
        if (rc) throw this.error(at - start);
        if (p) {
          const s = new Stmt(this, p);
          try {
            each(s, i++);
          } finally {
            s.finalize();
          }
        }
        if (tail <= at) break;
        at = tail;
      }
    } finally {
      w.dealloc(start);
    }
  }

  /** The first statement of `sql` (null when it holds none), and the byte length of what it covers. */
  prepare(sql: string, flags = 0): Stmt | null {
    const [p0, n] = cstr(sql);
    try {
      const rc = x.sqlite3_prepare_v3(this.ptr, p0, n, flags, scratch, 0);
      if (rc) throw this.error();
      const p = w.peekPtr(scratch);
      return p ? new Stmt(this, p) : null;
    } finally {
      w.dealloc(p0);
    }
  }

  _track(s: Stmt, live: boolean) {
    if (live) this.stmts.add(s);
    else this.stmts.delete(s);
  }

  /** The database file's bytes (sqlite3_serialize). */
  serialize(schema = "main"): Uint8Array {
    const [name] = cstr(schema);
    try {
      const p = x.sqlite3_serialize(this.ptr, name, scratch, 0);
      if (!p) throw new RawError(errstr(1), 1);
      const n = Number(new DataView(w.heap8u().buffer).getBigInt64(scratch, true));
      const out = bytes(p, n);
      x.sqlite3_free(p);
      return out;
    } finally {
      w.dealloc(name);
    }
  }

  close() {
    for (const s of this.stmts) s.finalize();
    x.sqlite3_close_v2(this.ptr);
    for (const f of this.functions) w.uninstallFunction(f);
    if (this.authorizer) w.uninstallFunction(this.authorizer);
    this.ptr = 0;
  }

  // --- user functions, the authorizer, sessions ---------------------------------------------------------------------

  /** Function-table slots this connection installed (uninstalled on close). */
  functions: number[] = [];

  install(sig: string, fn: Fn): number {
    const p = w.installFunction(sig, fn);
    this.functions.push(p);
    return p;
  }

  /**
   * A scalar function (`func`), or an aggregate (`step` + `final`, and `value` + `inverse` for a window function). Each
   * callback gets the sqlite3_context and the argument values (sqlite3_value pointers, read with `valueOf`).
   */
  createFunction(name: string, nArg: number, flags: number, cb: { func?: (ctx: number, args: number[]) => void; step?: (ctx: number, args: number[]) => void; final?: (ctx: number) => void; value?: (ctx: number) => void; inverse?: (ctx: number, args: number[]) => void }) {
    const argsOf = (argc: number, argv: number) => Array.from({ length: argc }, (_, i) => w.peekPtr(argv + 4 * i));
    const xs = (f?: (ctx: number, args: number[]) => void) => (f ? this.install("v(pip)", (ctx: number, argc: number, argv: number) => f(ctx, argsOf(argc, argv))) : 0);
    const x1 = (f?: (ctx: number) => void) => (f ? this.install("v(p)", f) : 0);
    const [p] = cstr(name);
    try {
      const rc =
        cb.value || cb.inverse
          ? x.sqlite3_create_window_function(this.ptr, p, nArg, 1 | flags, 0, xs(cb.step), x1(cb.final), x1(cb.value), xs(cb.inverse), 0)
          : x.sqlite3_create_function_v2(this.ptr, p, nArg, 1 | flags, 0, xs(cb.func), xs(cb.step), x1(cb.final), 0);
      this.check(rc);
    } finally {
      w.dealloc(p);
    }
  }

  /** The function-table slot of the authorizer, replaced with it. */
  private authorizer = 0;

  /** sqlite3_set_authorizer: `cb(action, arg1, arg2, dbName, trigger)` returns SQLITE_OK / DENY / IGNORE; null clears it. */
  setAuthorizer(cb: ((action: number, a: string | null, b: string | null, c: string | null, d: string | null) => number) | null) {
    const p = cb ? w.installFunction("i(pipppp)", (_u: number, action: number, a: number, b: number, c: number, d: number) => cb(action, str(a), str(b), str(c), str(d))) : 0;
    const rc = x.sqlite3_set_authorizer(this.ptr, p, 0);
    if (rc) {
      if (p) w.uninstallFunction(p);
      throw this.error();
    }
    if (this.authorizer) w.uninstallFunction(this.authorizer);
    this.authorizer = p;
  }

  /** A session (sqlite3session_create) on database `db`, attached to `table` (every table when null). */
  createSession(db: string, table: string | null): number {
    const [name] = cstr(db);
    try {
      this.check(x.sqlite3session_create(this.ptr, name, scratch));
    } finally {
      w.dealloc(name);
    }
    const s = w.peekPtr(scratch);
    const [t] = table === null ? [0] : cstr(table);
    try {
      const rc = x.sqlite3session_attach(s, t);
      if (rc) {
        x.sqlite3session_delete(s);
        throw new RawError(errstr(rc), rc);
      }
    } finally {
      if (t) w.dealloc(t);
    }
    return s;
  }

  /** sqlite3changeset_apply: `filter(table)` says whether to apply a table's changes, `conflict(type)` what to do. */
  applyChangeset(changeset: Uint8Array, filter: ((table: string) => number) | null, conflict: (type: number) => number): number {
    const p = x.sqlite3_malloc64(BigInt(Math.max(changeset.byteLength, 1)));
    w.heap8u().set(changeset, p);
    const xf = filter ? w.installFunction("i(pp)", (_c: number, t: number) => filter(str(t) ?? "")) : 0;
    const xc = w.installFunction("i(pip)", (_c: number, type: number) => conflict(type));
    try {
      return x.sqlite3changeset_apply(this.ptr, changeset.byteLength, p, xf, xc, 0);
    } finally {
      if (xf) w.uninstallFunction(xf);
      w.uninstallFunction(xc);
      x.sqlite3_free(p);
    }
  }
}

/** A session's changeset (`patch`: patchset) as bytes. */
export function sessionChanges(session: number, patch: boolean): Uint8Array {
  const rc = (patch ? x.sqlite3session_patchset : x.sqlite3session_changeset)(session, scratch, scratch + 4);
  if (rc) throw new RawError(errstr(rc), rc);
  const p = w.peekPtr(scratch + 4);
  const out = bytes(p, w.peek32(scratch));
  if (p) x.sqlite3_free(p);
  return out;
}
export const deleteSession = (session: number) => x.sqlite3session_delete(session);

/** A C string kept for the life of the engine (names passed again and again). */
const kept = new Map<string, number>();
function cstrOnce(s: string): number {
  let p = kept.get(s);
  if (p === undefined) kept.set(s, (p = cstr(s)[0]));
  return p;
}

export class Stmt {
  constructor(
    readonly conn: Conn,
    public ptr: number,
  ) {
    conn._track(this, true);
  }

  finalize() {
    if (!this.ptr) return;
    x.sqlite3_finalize(this.ptr);
    this.ptr = 0;
    this.conn._track(this, false);
  }

  get paramCount(): number {
    return x.sqlite3_bind_parameter_count(this.ptr);
  }
  /** The name of parameter `i` (1-based) as written (`$a`, `:a`, `@a`, `?2`); null for a plain `?`. */
  paramName(i: number): string | null {
    return str(x.sqlite3_bind_parameter_name(this.ptr, i));
  }
  get columnCount(): number {
    return x.sqlite3_column_count(this.ptr);
  }
  columnName(i: number): string {
    return str(x.sqlite3_column_name(this.ptr, i)) ?? "";
  }
  /** Column metadata: declared type, table, column it comes from and database; null for an expression. */
  declType(i: number) {
    return str(x.sqlite3_column_decltype(this.ptr, i));
  }
  tableName(i: number) {
    return str(x.sqlite3_column_table_name(this.ptr, i));
  }
  originName(i: number) {
    return str(x.sqlite3_column_origin_name(this.ptr, i));
  }
  databaseName(i: number) {
    return str(x.sqlite3_column_database_name(this.ptr, i));
  }
  get readonly(): boolean {
    return !!x.sqlite3_stmt_readonly(this.ptr);
  }
  get sql(): string {
    return str(x.sqlite3_sql(this.ptr)) ?? "";
  }
  /** sqlite3_expanded_sql: the SQL with the bound values written in. */
  get expanded(): string {
    const p = x.sqlite3_expanded_sql(this.ptr);
    const s = str(p) ?? "";
    if (p) x.sqlite3_free(p);
    return s;
  }

  /** Binds `v` to parameter `i` (1-based): a number as given (`real`: REAL, else INTEGER when it is a safe integer). */
  bind(i: number, v: Value, real = false) {
    const p = this.ptr;
    let rc: number;
    if (v === null) rc = x.sqlite3_bind_null(p, i);
    else if (typeof v === "number") rc = !real && Number.isSafeInteger(v) && !Object.is(v, -0) ? x.sqlite3_bind_int64(p, i, BigInt(v)) : x.sqlite3_bind_double(p, i, v);
    else if (typeof v === "bigint") rc = x.sqlite3_bind_int64(p, i, BigInt.asIntN(64, v));
    else if (typeof v === "string") {
      const [s, n] = cstr(v);
      rc = x.sqlite3_bind_text(p, i, s, n, TRANSIENT);
      w.dealloc(s);
    } else if (!v.byteLength) rc = x.sqlite3_bind_zeroblob(p, i, 0);
    else {
      const b = w.alloc(v.byteLength);
      w.heap8u().set(v, b);
      rc = x.sqlite3_bind_blob(p, i, b, v.byteLength, TRANSIENT);
      w.dealloc(b);
    }
    if (rc) throw this.conn.error();
  }

  clearBindings() {
    x.sqlite3_clear_bindings(this.ptr);
  }

  reset() {
    x.sqlite3_reset(this.ptr);
  }

  /** One sqlite3_step: true for a row, false when done; an error resets the statement and throws. */
  step(): boolean {
    const rc = x.sqlite3_step(this.ptr);
    if (rc === SQLITE_ROW) return true;
    if (rc === SQLITE_DONE) return false;
    // sqlite3_reset gives the statement's error (and makes the connection report it)
    const e = x.sqlite3_reset(this.ptr) || rc;
    const err = this.conn.error();
    if (err.errno === 0) throw new RawError(errstr(e), e);
    throw err;
  }

  /** sqlite3_column_type of column `i` in the current row. */
  type(i: number): number {
    return x.sqlite3_column_type(this.ptr, i);
  }

  /** Column `i` of the current row; an INTEGER as a BigInt with `big`, else as a number (rounded past 2^53). */
  column(i: number, big: boolean): Value {
    const p = this.ptr;
    switch (x.sqlite3_column_type(p, i)) {
      case INTEGER: {
        if (!big) return x.sqlite3_column_double(p, i);
        return BigInt(x.sqlite3_column_int64(p, i));
      }
      case FLOAT:
        return x.sqlite3_column_double(p, i);
      case TEXT: {
        const t = x.sqlite3_column_text(p, i);
        return text(t, x.sqlite3_column_bytes(p, i));
      }
      case BLOB: {
        const b = x.sqlite3_column_blob(p, i);
        return bytes(b, x.sqlite3_column_bytes(p, i));
      }
      default:
        return null;
    }
  }
}

// --- function arguments and results -----------------------------------------------------------------------------------

/** sqlite3_value `v` as a JS value; an INTEGER as a BigInt with `big`, else as a number. */
export function valueOf(v: number, big: boolean): Value {
  switch (x.sqlite3_value_type(v)) {
    case INTEGER:
      return big ? BigInt(x.sqlite3_value_int64(v)) : x.sqlite3_value_double(v);
    case FLOAT:
      return x.sqlite3_value_double(v);
    case TEXT:
      return text(x.sqlite3_value_text(v), x.sqlite3_value_bytes(v));
    case BLOB:
      return bytes(x.sqlite3_value_blob(v), x.sqlite3_value_bytes(v));
    default:
      return null;
  }
}

/** sqlite3_value_type of `v` (1 INTEGER, 2 FLOAT, 3 TEXT, 4 BLOB, 5 NULL). */
export const valueType = (v: number): number => x.sqlite3_value_type(v);

/** Sets the function result to `v`: a number as INTEGER when it is a safe integer, unless `real`. */
export function result(ctx: number, v: Value, real = false) {
  if (v === null) x.sqlite3_result_null(ctx);
  else if (typeof v === "number") {
    if (!real && Number.isSafeInteger(v) && !Object.is(v, -0)) x.sqlite3_result_int64(ctx, BigInt(v));
    else x.sqlite3_result_double(ctx, v);
  } else if (typeof v === "bigint") x.sqlite3_result_int64(ctx, BigInt.asIntN(64, v));
  else if (typeof v === "string") {
    const [s, n] = cstr(v);
    x.sqlite3_result_text(ctx, s, n, TRANSIENT);
    w.dealloc(s);
  } else {
    const b = w.alloc(Math.max(v.byteLength, 1));
    w.heap8u().set(v, b);
    x.sqlite3_result_blob(ctx, b, v.byteLength, TRANSIENT);
    w.dealloc(b);
  }
}

/** Makes the function fail with `message` (and result code `code`). */
export function resultError(ctx: number, message: string, code = 1) {
  const [s, n] = cstr(message);
  x.sqlite3_result_error(ctx, s, n);
  w.dealloc(s);
  if (code !== 1) x.sqlite3_result_error_code(ctx, code);
}

/** A key for the aggregate state of `ctx` (sqlite3_aggregate_context), or 0 when there is none yet and `create` is false. */
export const aggregateKey = (ctx: number, create: boolean): number => x.sqlite3_aggregate_context(ctx, create ? 8 : 0);

/** SQLite's own constants this module and its users name. */
export const DBCONFIG_DQS_DML = 1013;
export const DBCONFIG_DQS_DDL = 1014;
export const DBCONFIG_DEFENSIVE = 1010;
export const DBCONFIG_ENABLE_FKEY = 1002;

/** The name of result code `rc` (`SQLITE_CONSTRAINT_UNIQUE`), undefined for one SQLite doesn't define. */
export const rcName = (rc: number): string | undefined => capi.sqlite3_js_rc_str(rc) || undefined;
