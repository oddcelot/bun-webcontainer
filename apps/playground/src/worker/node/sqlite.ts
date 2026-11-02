// `bun:sqlite` on top of sql.js (SQLite compiled to wasm). sql.js loads asynchronously, so the wrapper module of
// `bun:sqlite` awaits `globalThis.__loadBunSqlite()` first; after that `new Database()` is synchronous.
// File databases persist: the bytes are read from the worker's VFS on open and written back with `db.export()`
// (debounced after a write, and on close). Writes go through the fs shim, so the page's file tree and OPFS mirror see them.
import type { BindParams, Database as SqlJsDb, SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { norm } from "../../vfs";
import fs from "./fs";
import path from "./path";

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
}

const FLUSH_MS = 200;
const isRead = (sql: string) => /^\s*(select|explain|values)\b|^\s*pragma\s+[\w.]+\s*(;|$)/i.test(sql);

function cantOpen(): Error {
  return Object.assign(new Error("unable to open database file"), { name: "SQLiteError", code: "SQLITE_CANTOPEN", errno: 14 });
}

const scalar = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? +v : v);

/** Positional args / arrays bind to `?`; an object binds by name. */
function bindings(args: unknown[], strict: boolean): BindParams {
  const first = args[0];
  if (args.length === 1 && Array.isArray(first)) return first.map(scalar) as BindParams;
  if (args.length === 1 && first && typeof first === "object" && !ArrayBuffer.isView(first)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(first)) {
      // strict: bare keys bind to `$k`, `:k` or `@k`; otherwise the key already carries its prefix
      for (const key of strict && !/^[$:@]/.test(k) ? [`$${k}`, `:${k}`, `@${k}`] : [k]) out[key] = scalar(v);
    }
    return out as BindParams;
  }
  return args.length ? (args.map(scalar) as BindParams) : [];
}

export class Statement<R = unknown, P extends unknown[] = any[]> {
  constructor(
    private db: Database,
    readonly native: string,
  ) {}

  private each(params: unknown[], fn: (row: Record<string, unknown>) => boolean | void): void {
    this.db._note(this.native);
    const s = this.db._raw.prepare(this.native);
    try {
      s.bind(bindings(params, this.db._strict));
      while (s.step()) if (fn(s.getAsObject()) === false) break;
    } finally {
      s.free();
    }
  }

  get columnNames(): string[] {
    const s = this.db._raw.prepare(this.native);
    try {
      return s.getColumnNames();
    } finally {
      s.free();
    }
  }

  all(...params: P): R[] {
    const rows: R[] = [];
    this.each(params, (r) => void rows.push(r as R));
    return rows;
  }

  get(...params: P): R | null {
    let row: R | null = null;
    this.each(params, (r) => {
      row = r as R;
      return false;
    });
    return row;
  }

  values(...params: P): unknown[][] {
    return this.all(...params).map((r) => Object.values(r as object));
  }

  *iterate(...params: P): IterableIterator<R> {
    yield* this.all(...params);
  }

  run(...params: P): { changes: number; lastInsertRowid: number } {
    this.each(params, () => {});
    return this.db._meta();
  }

  finalize(): void {}
}

/** File databases still open: flushed when the worker is about to be stopped (see flushDatabases). */
const openFiles = new Set<Database>();

/** Writes every open file database back now; the runtime calls this before Run/Stop terminates the worker. */
export function flushDatabases() {
  for (const db of openFiles) db.flush();
}

export class Database {
  _raw: SqlJsDb;
  _strict: boolean;
  private cache = new Map<string, Statement>();
  /** VFS key of the backing file; undefined for in-memory databases and readonly ones (which never write back). */
  private file: string | undefined;
  private dirty = false;
  private inTx = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(filename: string | Uint8Array = ":memory:", options: number | Options = {}) {
    if (!SQL) throw new Error("bun:sqlite is not loaded yet");
    const o: Options = typeof options === "object" && options ? options : {};
    this._strict = !!o.strict;
    let readonly = o.readonly === true || o.readwrite === false;
    let create = o.create ?? (o.readwrite !== true && !readonly);
    if (typeof options === "number") {
      // SQLITE_OPEN_READONLY = 1, SQLITE_OPEN_READWRITE = 2, SQLITE_OPEN_CREATE = 4
      readonly = !!(options & 1);
      create = !!(options & 4);
    } else if (readonly && (o.create || o.readwrite)) throw new TypeError("Cannot use readonly together with create or readwrite");
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

  private touch() {
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Called with the SQL of everything that runs: reads leave the database clean. */
  _note(sql: string) {
    if (!this.file || isRead(sql)) return;
    if (/^\s*(begin|savepoint)\b/i.test(sql)) this.inTx = true;
    else if (/^\s*(commit|end|rollback)\b/i.test(sql)) this.inTx = false;
    this.touch();
  }

  /** Write the database back to the VFS now. sql.js `export()` closes and reopens the connection, so skip it mid-transaction. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file || !this.dirty) return;
    if (this.inTx) return void this.touch();
    this.dirty = false;
    const fk = this._raw.exec("pragma foreign_keys")[0]?.values[0][0];
    const bytes = this._raw.export(); // also resets per-connection pragmas
    if (fk) this._raw.run("pragma foreign_keys = on");
    fs.writeFileSync(this.file, bytes);
  }

  _meta() {
    const id = this._raw.exec("select last_insert_rowid()")[0].values[0][0] as number;
    return { changes: this._raw.getRowsModified(), lastInsertRowid: id };
  }

  run(sql: string, ...params: unknown[]) {
    this._note(sql);
    if (!params.length) this._raw.run(sql);
    else this._raw.run(sql, bindings(params, this._strict));
    return this._meta();
  }

  exec = this.run;

  query<R = unknown, P extends Params = any>(sql: string): Statement<R, P extends unknown[] ? P : [P]> {
    let s = this.cache.get(sql);
    if (!s) this.cache.set(sql, (s = new Statement(this, sql)));
    return s as never;
  }

  prepare<R = unknown, P extends Params = any>(sql: string): Statement<R, P extends unknown[] ? P : [P]> {
    return new Statement(this, sql) as never;
  }

  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return (...args) => {
      this._raw.run("begin");
      try {
        const r = fn(...args);
        this._raw.run("commit");
        this._note("insert"); // the transaction wrote something
        return r;
      } catch (e) {
        this._raw.run("rollback");
        throw e;
      }
    };
  }

  serialize(): Uint8Array {
    return this._raw.export();
  }

  close(): void {
    this.flush();
    openFiles.delete(this);
    this._raw.close();
  }
}

export default { Database, Statement };
