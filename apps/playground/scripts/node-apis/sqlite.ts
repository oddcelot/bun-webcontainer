// node:sqlite: DatabaseSync and StatementSync as Bun has them.
import { backup, constants, DatabaseSync, Session, StatementSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import module, { createRequire } from "node:module";
import { basename } from "node:path";
import type { Case } from "./cases.ts";

export async function sqlite(t: Case, log: (line: string) => void) {
  const show = (v: unknown): string =>
    v === undefined ? "undefined" : typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? `bytes(${[...v]})` : Array.isArray(v) ? `[${v.map(show).join(",")}]` : v && typeof v === "object" ? `${Object.getPrototypeOf(v) === null ? "null-proto" : ""}{${Object.entries(v).map(([k, x]) => `${k}:${show(x)}`).join(",")}}` : JSON.stringify(v);
  const s = (label: string, f: () => unknown) => t(label, () => show(f()));
  const errOf = (f: () => unknown) => {
    try {
      f();
      return "no error";
    } catch (e) {
      const err = e as Error & { code?: string; errcode?: number; errstr?: string };
      return `${err.name} ${err.message} code=${err.code} errcode=${err.errcode} errstr=${err.errstr} keys=${Object.keys(err)}`;
    }
  };

  t("sqlite builtin", () => [module.isBuiltin("sqlite"), module.isBuiltin("node:sqlite"), module.builtinModules.includes("node:sqlite"), module.builtinModules.includes("sqlite"), Bun.resolveSync("node:sqlite", "."), createRequire(import.meta.url)("node:sqlite").DatabaseSync === DatabaseSync].join());
  t("sqlite exports", () => [typeof DatabaseSync, typeof StatementSync, typeof Session, typeof backup, Object.keys(constants).length, constants.SQLITE_CHANGESET_ABORT, constants.SQLITE_RECURSIVE].join());
  const db = new DatabaseSync(":memory:");
  t("sqlite isOpen", () => [db.isOpen, db.isTransaction, db.location()].join());
  t("sqlite exec", () => db.exec("create table t (id integer primary key, name text, n real, b blob, big integer)"));
  const ins = db.prepare("insert into t (name, n, b, big) values (?, ?, ?, ?)");
  s("sqlite run", () => ins.run("a", 1.5, new Uint8Array([1, 2]), 2n ** 60n));
  s("sqlite run 2", () => ins.run("b", null, null, 5));
  t("sqlite sourceSQL", () => ins.sourceSQL);
  t("sqlite expandedSQL", () => ins.expandedSQL);
  t("sqlite expanded literals", () => {
    const st = db.prepare("select ?, ?, ?, ?, ?, ?, ?");
    st.get(5, 1.5, "o'k", null, new Uint8Array([255, 1]), 1e20, 5n);
    return st.expandedSQL;
  });
  t("sqlite expanded unbound", () => db.prepare("select ? , $a").expandedSQL);
  s("sqlite get", () => db.prepare("select id, name, n, b from t where id = ?").get(1));
  t("sqlite get unsafe int", () => errOf(() => db.prepare("select * from t where id = ?").get(1)));
  s("sqlite get none", () => db.prepare("select * from t where id = ?").get(99));
  s("sqlite all", () => db.prepare("select id, name from t").all());
  s("sqlite iterate", () => [...db.prepare("select id from t").iterate()]);
  t("sqlite iterate lazy", () => {
    const it = db.prepare("select id from t").iterate();
    return [Object.prototype.toString.call(it), show(it.next()), show(it.return?.()), show(it.next())].join(" ");
  });
  s("sqlite named prefixes", () => db.prepare("select $a as a, :b as b, @c as c").get({ $a: 1, ":b": 2, "@c": 3 }));
  s("sqlite named bare", () => db.prepare("select $a as a, :b as b").get({ a: 1, b: 2 }));
  t("sqlite named bare off", () => {
    const st = db.prepare("select $a as a");
    st.setAllowBareNamedParameters(false);
    return errOf(() => st.get({ a: 1 }));
  });
  s("sqlite named missing", () => db.prepare("select $a as a, $z as z").get({ a: 1 }));
  t("sqlite named unknown", () => errOf(() => db.prepare("select $a as a").get({ a: 1, b: 2 })));
  s("sqlite named unknown allowed", () => {
    const st = db.prepare("select $a as a");
    st.setAllowUnknownNamedParameters(true);
    return st.get({ a: 1, b: 2 });
  });
  s("sqlite named both forms", () => db.prepare("select $a as a").get({ a: 1, $a: 2 }));
  s("sqlite named and positional", () => db.prepare("select $a as a, ? as p, ? as q").get({ a: 1 }, 2, 3));
  s("sqlite numbered", () => db.prepare("select ?2 as a, ?1 as b").get(1, 2));
  s("sqlite too few", () => db.prepare("select ? as a, ? as b").get(1));
  t("sqlite too many", () => errOf(() => db.prepare("select ? as a").get(1, 2)));
  t("sqlite array arg", () => errOf(() => db.prepare("select ? as a").get([1] as never)));
  s("sqlite typed arrays", () => db.prepare("select ? as a, ? as b").get(new DataView(new ArrayBuffer(2)) as never, new Float32Array([1]) as never));
  t("sqlite bind bool", () => errOf(() => db.prepare("select ? as v").get(true as never)));
  t("sqlite bind undefined", () => errOf(() => db.prepare("select ? as v").get(undefined as never)));
  t("sqlite bind symbol", () => errOf(() => db.prepare("select ?, ? as v").get(1, Symbol("x") as never)));
  t("sqlite bind huge bigint", () => errOf(() => db.prepare("select ? as v").get(2n ** 64n)));
  s("sqlite readBigInts", () => {
    const st = db.prepare("select id, big from t");
    st.setReadBigInts(true);
    return st.all();
  });
  s("sqlite run readBigInts", () => {
    const st = db.prepare("insert into t (name) values ('c')");
    st.setReadBigInts(true);
    return st.run();
  });
  s("sqlite returnArrays", () => {
    const st = db.prepare("select id, name from t where id < 3");
    st.setReturnArrays(true);
    return st.all();
  });
  t("sqlite columns names", () => db.prepare("select id, name as nm, 1 + 1 from t").columns().map((c) => c.name).join());
  t("sqlite syntax error", () => errOf(() => db.prepare("selec 1")));
  t("sqlite unique", () => errOf(() => db.exec("insert into t (id) values (1)")));
  t("sqlite not null", () => errOf(() => db.exec("create table nn (a not null); insert into nn values (null)")));
  t("sqlite non-string sql", () => errOf(() => db.prepare(1 as never)) + " / " + errOf(() => db.exec(1 as never)));
  t("sqlite transaction", () => {
    db.exec("begin");
    const a = db.isTransaction;
    db.exec("insert into t (name) values ('tx'); commit");
    return [a, db.isTransaction].join();
  });
  t("sqlite savepoint", () => {
    db.exec("savepoint a");
    const x = db.isTransaction;
    db.exec("release a");
    return [x, db.isTransaction].join();
  });
  s("sqlite run on select", () => {
    db.exec("create table z (a); insert into z values (1)");
    return db.prepare("select * from z").run();
  });
  s("sqlite returning", () => db.prepare("insert into z values (2) returning a").get());
  s("sqlite exec multiple", () => (db.exec("insert into z values (3); insert into z values (4)"), db.prepare("select count(*) as c from z").get()));
  s("sqlite first statement only", () => db.prepare("select 1 as one; select 2").all());
  s("sqlite foreign keys default", () => db.prepare("pragma foreign_keys").get());
  s("sqlite foreign keys off", () => new DatabaseSync(":memory:", { enableForeignKeyConstraints: false }).prepare("pragma foreign_keys").get());
  s("sqlite db options", () => new DatabaseSync(":memory:", { readBigInts: true, returnArrays: true }).prepare("select 1 as a").get());
  t("sqlite bad option", () => errOf(() => new DatabaseSync(":memory:", { open: 1 } as never)));
  t("sqlite bad path", () => errOf(() => new DatabaseSync(1 as never)));
  t("sqlite new StatementSync", () => errOf(() => new (StatementSync as unknown as new () => unknown)()));
  t("sqlite new Session", () => errOf(() => new (Session as unknown as new () => unknown)()));
  s("sqlite function", () => {
    db.function("twice", (x: number) => x * 2);
    return db.prepare("select twice(21) as v").get();
  });
  s("sqlite function varargs", () => {
    db.function("nargs", { varargs: true }, (...a: unknown[]) => a.length);
    return db.prepare("select nargs(1, 2, 3) as n").get();
  });
  s("sqlite function bigint args", () => {
    db.function("kind", { useBigIntArguments: true }, (a: unknown) => typeof a);
    return db.prepare("select kind(1) as k").get();
  });
  t("sqlite function bad result", () => {
    db.function("rb", () => true as never);
    return errOf(() => db.prepare("select rb() as n").get());
  });
  t("sqlite function throws", () => {
    db.function("th", () => {
      throw new RangeError("inner");
    });
    return errOf(() => db.prepare("select th() as n").get());
  });
  s("sqlite aggregate", () => {
    db.aggregate("sumx", { start: 0, step: (acc: number, v: number) => acc + v });
    return db.prepare("select sumx(a) as s from z").get();
  });
  s("sqlite aggregate result", () => {
    db.aggregate("cnt", { start: () => [] as unknown[], step: (acc: unknown[], v: unknown) => (acc.push(v), acc), result: (acc: unknown[]) => acc.length });
    return db.prepare("select cnt(a) as s from z").get();
  });
  s("sqlite serialize", () => {
    const d2 = new DatabaseSync(":memory:");
    const bytes = db.serialize();
    d2.deserialize(bytes);
    return [bytes.constructor.name, d2.prepare("select count(*) as c from z").get()];
  });
  s("sqlite tag store", () => {
    const sql = db.createTagStore();
    const id = 1;
    return [sql.get`select ${id} as v`, sql.all`select a from z where a > ${2}`, sql.run`insert into z values (${9})`, sql.size, sql.capacity];
  });
  t("sqlite loadExtension", () => errOf(() => db.loadExtension("x")));
  t("sqlite enableLoadExtension", () => errOf(() => db.enableLoadExtension(true)));
  t("sqlite location attached", () => String(db.location("other")));
  t("sqlite close", () => [db.close(), db.isOpen].join());
  t("sqlite closed", () => [errOf(() => db.prepare("select 1")), errOf(() => db.close()), errOf(() => db.isTransaction), errOf(() => db.exec("select 1"))].join(" / "));
  t("sqlite statement after close", () => errOf(() => ins.run("x", 1, null, 1)));
  t("sqlite reopen", () => (db.open(), [db.isOpen, errOf(() => db.open())].join()));
  t("sqlite open false", () => {
    const d = new DatabaseSync(":memory:", { open: false });
    const before = d.isOpen;
    d.open();
    return [before, d.isOpen].join();
  });
  t("sqlite dispose", () => {
    const d = new DatabaseSync(":memory:");
    d[Symbol.dispose]();
    d[Symbol.dispose]();
    return d.isOpen;
  });

  // Every number binds as a REAL (bun:sqlite binds a whole one as an INTEGER).
  {
    const d = new DatabaseSync(":memory:");
    s("sqlite bind real", () => d.prepare("select typeof(?) a, typeof(?) b, typeof(?) c, typeof(?) d, typeof(?) e, ? f, ? g").get(1, -7, 1.5, 2 ** 40, 10n, 3, 0));
    s("sqlite bind real named", () => d.prepare("select typeof(:a) a, typeof($b) b, :a + $b c").get({ a: 2, b: 3 }));
    s("sqlite bind real column", () => {
      d.exec("create table r (i integer, f real, x, t text)");
      d.prepare("insert into r values (?, ?, ?, ?)").run(1, 2, 3, 4);
      return d.prepare("select typeof(i) ti, typeof(f) tf, typeof(x) tx, typeof(t) tt, i, f, x, t from r").get();
    });
    s("sqlite bind real tag", () => d.createTagStore().get`select typeof(${5}) t, ${5} v`);
    d.close();
  }

  // Double-quoted string literals are off unless enableDoubleQuotedStringLiterals.
  {
    const d = new DatabaseSync(":memory:");
    d.exec(`create table "q t" ("my col" text, x)`);
    d.exec(`insert into "q t" values ('a', 1)`);
    t("sqlite dqs select", () => errOf(() => d.prepare(`select "abc" as s`)));
    t("sqlite dqs identifiers", () => show(d.prepare(`select "my col", "q t".x as "the ""x""" from "q t" where "my col" = 'a'`).all()));
    t("sqlite dqs where", () => errOf(() => d.prepare(`select x from "q t" where x = "nope"`)));
    t("sqlite dqs exec", () => errOf(() => d.exec(`insert into "q t" values ('b', 2); select "zz"; insert into "q t" values ('c', 3)`)));
    t("sqlite dqs exec ran", () => show(d.prepare(`select count(*) n from "q t"`).get()));
    t("sqlite dqs check", () => errOf(() => d.exec(`create table c2 (a check (a <> "x"))`)));
    t("sqlite dqs default", () => errOf(() => d.exec(`create table c3 (a default "x")`)));
    t("sqlite dqs in string", () => show(d.prepare(`select 'say "hi"' s -- "comment"`).get()));
    d.close();
    const on = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true });
    t("sqlite dqs enabled", () => show(on.prepare(`select "abc" as s`).get()));
    on.close();
  }

  const file = "node-apis-sqlite.db";
  const copy = "node-apis-backup.db";
  for (const f of [file, copy]) rmSync(f, { force: true });
  try {
    t("sqlite file", () => {
      const d = new DatabaseSync(file);
      const l = basename(d.location()!);
      d.exec("create table x (a); insert into x values (42)");
      d.close();
      const r = new DatabaseSync(file, { readOnly: true });
      const v = r.prepare("select a from x").get() as { a: number };
      const err = errOf(() => r.exec("insert into x values (1)"));
      r.close();
      return [l, existsSync(file), v.a, err].join(" | ");
    });
    t("sqlite readOnly missing", () => errOf(() => new DatabaseSync("node-apis-missing.db", { readOnly: true })));
    {
      const d = new DatabaseSync(file);
      const pages = await backup(d, copy);
      d.close();
      const b = new DatabaseSync(copy);
      log(`sqlite backup: ${[pages, show(b.prepare("select a from x").get())].join(" ")}`);
      b.close();
    }
  } finally {
    for (const f of [file, copy]) rmSync(f, { force: true });
  }
}
