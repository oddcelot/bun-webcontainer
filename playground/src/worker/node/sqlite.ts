// `bun:sqlite` on top of sql.js (SQLite compiled to wasm). sql.js loads asynchronously, so the wrapper module of
// `bun:sqlite` awaits `globalThis.__loadBunSqlite()` first; after that `new Database()` is synchronous.
// Limitation: every database lives in memory (the path is ignored), so data does not persist across runs.
import type { BindParams, Database as SqlJsDb, SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

let SQL: SqlJsStatic | undefined;

(globalThis as Record<string, unknown>).__loadBunSqlite = async () => {
  if (SQL) return;
  const { default: init } = await import("sql.js");
  SQL = await init({ locateFile: () => wasmUrl });
};

type Params = unknown[] | Record<string, unknown>;
interface Options {
  create?: boolean;
  readonly?: boolean;
  readwrite?: boolean;
  strict?: boolean;
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

export class Database {
  _raw: SqlJsDb;
  _strict: boolean;
  private cache = new Map<string, Statement>();

  constructor(_path: string | Uint8Array = ":memory:", options: number | Options = {}) {
    if (!SQL) throw new Error("bun:sqlite is not loaded yet");
    this._strict = typeof options === "object" && !!options.strict;
    this._raw = new SQL.Database(_path instanceof Uint8Array ? _path : undefined);
  }

  _meta() {
    const id = this._raw.exec("select last_insert_rowid()")[0].values[0][0] as number;
    return { changes: this._raw.getRowsModified(), lastInsertRowid: id };
  }

  run(sql: string, ...params: unknown[]) {
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
    this._raw.close();
  }
}

export default { Database, Statement };
