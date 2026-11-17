// Bun.sql / SQL probes: one line per case, `label: value`. scripts/sql.ts runs this under native Bun against a real
// Postgres (CASE_DB) and in the playground against PGlite (the same URL: any host is a database in the tab), and the
// lines must match but for the ones that script lists. Tables are made fresh each run.
import { SQL, sql } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";

const url = process.env.CASE_DB!;
const db = new SQL(url);
const fmt = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : ArrayBuffer.isView(x) && !Buffer.isBuffer(x) ? [...(x as unknown as number[])] : x));
const log = (label: string, v: unknown) => console.log(`${label}: ${fmt(v)}`);
const meta = (r: { count: number; command: string; affectedRows: number }) => [r.count, r.command, r.affectedRows];
const fails = async (label: string, p: PromiseLike<unknown>, ...pick: string[]) => {
  try {
    await p;
    log(label, "no error");
  } catch (e: any) {
    log(label, [e.constructor.name, e.name, e instanceof SQL.PostgresError, e instanceof Error, e.code, ...pick.map((k) => e[k])]);
  }
};

await db`drop table if exists t`;
const created = await db`create table t (id serial primary key, name text, n int, big bigint, j jsonb, d timestamptz, b bytea, arr int[], f float8, ok bool, nm numeric)`;
log("create", [created.length, Array.isArray(created), created.constructor.name, ...meta(created)]);

// Parameters of every JS type, and what comes back.
const ins = await db`insert into t (name, n, big, j, d, b, arr, f, ok, nm) values (${"a"}, ${1}, ${9007199254740993n}, ${{ x: [1, 2] }}, ${new Date(0)}, ${Buffer.from("hi")}, ${[1, 2, 3]}, ${1.5}, ${true}, ${"12.50"}) returning *`;
log("insert", [...ins].map((r: any) => ({ ...r, arr: [...r.arr] })));
log("insert meta", [...meta(ins), ins.lastInsertRowid]);
log("insert null", await db`insert into t (name) values (${null}) returning id, name`);
log("typeof", Object.fromEntries(Object.entries((await db`select big, j, d, b, arr, f, ok, nm, n from t where name = 'a'`)[0]).map(([k, v]) => [k, v instanceof Date ? "Date" : Buffer.isBuffer(v) ? "Buffer" : Array.isArray(v) ? "array" : typeof v])));
log("values", await db`select id, name from t order by id`.values());
log("raw", (await db`select name from t where name is not null`.raw()).map((r: Buffer[]) => r.map((b) => b?.toString())));
log("simple", (await db`select 1 as a; select 2 as b`.simple()).map((r: any) => [...r]));
log("simple one", [...(await db`select 1 as a`.simple())]);
log("empty", [...(await db`select * from t where id < 0`)]);

// Helpers.
log("in", await db`select id from t where id in ${db([1, 2])} order by id`);
log("in strings", await db`select 1 as one where 'a' in ${db(["a", "b"])}`);
log("insert helper", await db`insert into t ${db({ name: "z", n: 5 })} returning name, n`);
log("insert many", await db`insert into t ${db([{ name: "m1", n: 6 }, { name: "m2", n: 7 }])} returning name, n`);
log("insert columns", await db`insert into t ${db({ name: "c", n: 9, f: 2 }, "name", "n")} returning name, n, f`);
log("insert undefined", await db`insert into t ${db({ name: undefined, n: 1 })} returning name, n`);
log("update helper", await db`update t set ${db({ name: "u", n: 50 }, "name", "n")} where name = ${"z"} returning name, n`);
log("update undefined", await db`update t set ${db({ name: "u2", n: undefined })} where name = ${"u"} returning name, n`);
log("update count", meta(await db`update t set n = n where n > ${5}`));
log("delete", meta(await db`delete from t where name = ${"u2"}`));
log("upsert", await db`insert into t ${db({ id: 1000, name: "x" })} on conflict (id) do update set ${db({ name: "y" })} returning id, name`);
log("identifier", await db`select 1 as x from ${db("pg_catalog.pg_class")} limit 1`);
log("fragment", await db`select 1 as a ${true ? db`, 2 as b` : db``}`);
log("array", await db`select ${db.array([1, 2, 3], "INT")} as a`);
log("array text", await db`select ${db.array(["a", "b"], "TEXT")} as a`);
log("any", await db`select id from t where id = any(${db.array([1, 2])}) order by id`);
log("json", await db`select ${db.json({ a: 1 })}::jsonb as j`);
await fails("helper outside", db`select * from t where ${db({ a: 1 })}`, "message");

// Parameter types (Bun sends booleans, integers, doubles and bytea typed; strings are left to Postgres).
log("param types", (await db`select ${1.5} as a, ${true} as b, ${"x"} as c, ${10n} as d, ${2 ** 40} as e, ${7} as f`)[0]);
log("param date", (await db`select ${new Date("2020-01-02T03:04:05Z")} as d`)[0]);
log("param date col", (await db`select ${new Date("2020-01-02T03:04:05Z")}::timestamptz as d`)[0]);
log("param bytes", (await db`select ${new Uint8Array([1, 2, 3])}::bytea as b`)[0]);
log("param array", (await db`select ${["a", "b"]}::text[] as x`)[0]);
log("param null", (await db`select ${null}::int as a, ${undefined}::int as b`)[0]);
log("param json obj", (await db`select ${{ a: 1 }} as j`)[0]);
log("param json str", (await db`select ${JSON.stringify({ a: 1 })}::jsonb as j`)[0]);

// Types by value.
log("count", (await db`select count(*) as c from t where id < 0`)[0]);
log("int8", (await db`select 1::int8 as c, 1 as d`)[0]);
log("numeric", (await db`select 1.5::numeric as c`)[0]);
log("date types", (await db`select '2020-01-02'::date as c, '12:30'::time as t, '2020-01-02 03:04:05'::timestamp as ts, '2020-01-02 03:04:05+02'::timestamptz as tz`)[0]);
log("misc", (await db`select '6b0b3e4e-8f4e-4bd7-9b1a-3e6a9b2a1c1c'::uuid as c, '{"a":1}'::json as j, '{a,b}'::text[] as ta, ARRAY[1.5,2.5]::float8[] as fa, '\\xdeadbeef'::bytea as b, null as n`)[0]);
log("jsonb scalars", (await db`select '"s"'::jsonb as a, 'null'::jsonb as b, '1'::jsonb as c`)[0]);
log("duplicate columns", [await db`select 1 as a, 2 as a`.then((r: any) => ({ ...r[0] })), (await db`select 1 as a, 2 as a`.values())[0]]);

// Commands.
log("tags", [(await db`truncate t`).command, (await db`create index t_name on t (name)`).command, (await db`drop index t_name`).command, (await db`set timezone = 'UTC'`).command, (await db`select 1`).command, (await db`create table if not exists t_tmp (a int)`).command, (await db`drop table t_tmp`).command]);

// unsafe and file.
log("unsafe", (await db.unsafe("select $1::int as a", [3]))[0]);
log("unsafe many", (await db.unsafe("select 1 as a; select 2 as b")).map((r: any) => [...r]));
mkdirSync("sql", { recursive: true });
writeFileSync("sql/q.sql", "select $1::int + 1 as a");
log("file", (await db.file("sql/q.sql", [7]))[0]);

// Errors.
await fails("error missing table", db`select * from nope`, "errno", "severity", "position", "message");
await fails("error unique", db`insert into t (id) values (1), (1)`, "errno", "constraint", "detail", "table", "schema", "message");
await fails("error syntax", db`bogus 1`, "errno", "severity", "position", "message");
await fails("error cast", db`select 'x'::int`, "errno", "message");

// Transactions.
await db`truncate t`;
log("begin", await db.begin(async (tx: any) => {
  await tx`insert into t (name) values ('tx1')`;
  return [(await tx`select count(*)::int as c from t where name = 'tx1'`)[0].c, typeof tx.savepoint];
}));
try {
  await db.begin(async (tx: any) => {
    await tx`insert into t (name) values ('tx2')`;
    throw new Error("boom");
  });
} catch (e: any) {
  log("rollback", [e.message, (await db`select count(*)::int as c from t where name in ('tx1', 'tx2')`)[0].c]);
}
await fails("tx error", db.begin(async (tx: any) => {
  await tx`insert into t (id, name) values (1, 'a')`;
  await tx`insert into t (id, name) values (1, 'b')`;
}), "errno", "constraint");
log("after tx error", await db`select count(*)::int as c from t where id = 1`);
log("begin returns", await db.begin(async () => 42));
log("begin options", await db.begin("read only", async (tx: any) => (await tx`show transaction_read_only`)[0]));
log("begin queries", (await db.begin(async (tx: any) => [tx`select 1 as a`, tx`select 2 as a`])).map((r: any) => [...r]));
await db.begin(async (tx: any) => {
  await tx.savepoint(async (sp: any) => {
    await sp`insert into t (name) values ('sp1')`;
  });
  try {
    await tx.savepoint(async (sp: any) => {
      await sp`insert into t (name) values ('sp2')`;
      throw new Error("x");
    });
  } catch {}
});
log("savepoint", await db`select name from t where name like 'sp%' order by name`);
// Transactions started together all run (native Bun on a connection each, the playground one after the other).
const order: number[] = [];
await Promise.all([1, 2, 3].map((i) => db.begin(async (tx: any) => { await tx`select pg_sleep(0.01)`; order.push(i); })));
log("transactions in turn", order.sort());

// Reserve, concurrency, thenables, options.
const reserved = await db.reserve();
log("reserve", [typeof reserved, typeof reserved.release, [...(await reserved`select 1 as a`)]]);
reserved.release();
log("concurrent", (await Promise.all([db`select 1 as a`, db`select 2 as a`, db`select 3 as a`])).map((r: any) => r[0].a));
const q = db`select 1 as a`;
log("thenable", [typeof q.then, typeof q.catch, typeof q.finally, typeof q.execute, typeof q.cancel, typeof q.values, typeof q.raw, typeof q.simple]);
log("execute", [...(await db`select 1 as a`.execute())]);
log("options", [db.options.database, db.options.username, db.options.adapter, typeof db.close, typeof db.end, typeof db.unsafe, typeof db.file, typeof db.array, typeof db.begin, typeof db.reserve]);
log("classes", [typeof SQL, typeof SQL.PostgresError, typeof SQL.SQLiteError, typeof SQL.MySQLError, typeof SQL.SQLError, db instanceof SQL, typeof db]);

// bigint option, other connections of the same database.
const big = new SQL(url, { bigint: true });
log("bigint option", (await big`select 1::int8 as a, count(*) as c`)[0]);
await big.close();
const other = new SQL({ url });
log("same database", await other`select count(*)::int as c from t where name like 'sp%'`);
await other.close();

// The default `sql` (DATABASE_URL), sqlite and mysql.
log("default sql", [(await sql`select 1 as a`)[0], sql.options.database, typeof sql.begin]);
const lite = new SQL("sqlite://:memory:");
await lite.unsafe("create table x (id integer primary key, v text)");
log("sqlite", [lite.options.adapter, await lite`insert into x ${lite({ v: "a" })} returning *`, (await lite`select * from x where v in ${lite(["a", "b"])}`).command]);
log("sqlite meta", (({ count, command, lastInsertRowid }) => [count, command, lastInsertRowid])(await lite`insert into x ${lite({ v: "b" })}`));
await lite.close();
try {
  new SQL("nonsense://x");
} catch (e: any) {
  log("bad protocol", e.message);
}

// Close.
await db.close();
await fails("closed", db`select 1`);
await db.end();
log("end twice", "ok");

// A database kept across a close: the rows come back when it is opened again.
const again = new SQL(url);
log("reopened", await again`select count(*)::int as c from t where name like 'sp%'`);
await again.close();

console.log("__end__");
