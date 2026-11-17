// What only the playground does (scripts/sql.ts checks these lines by hand: native Bun has no PGlite and no such URLs).
import { SQL, sql } from "bun";

const log = (label: string, v: unknown) => console.log(`${label}: ${JSON.stringify(v)}`);

// mysql:// is refused, with the reason, when it is first used.
try {
  await new SQL("mysql://u:p@localhost/db")`select 1`;
} catch (e: any) {
  log("mysql", [e.constructor.name, e instanceof SQL.MySQLError, e.code, e.message.slice(0, 40)]);
}

// pglite://<name> and a postgres:// URL of that database name (any host) are the same database.
const a = new SQL("pglite://scratch");
await a`create table if not exists s (v int)`;
await a`delete from s`;
await a`insert into s values (1)`;
const b = new SQL("postgres://u:p@elsewhere.example:1234/scratch");
log("same database", [...(await b`select v from s`)]);
log("options", [b.options.hostname, b.options.port, b.options.database, b.options.username]);
await a.close();
log("shared until the last close", [...(await b`select v from s`)]);
await b.close();

// pglite://:memory: is not kept: a new one is empty.
const m = new SQL("pglite://:memory:");
await m`create table mm (v int)`;
await m.close();
const m2 = new SQL("pglite://:memory:");
log("memory", (await m2`select to_regclass('mm')::text as r`)[0]);
await m2.close();

// The default `sql` reads the environment when it is first used.
process.env.DATABASE_URL = "postgres://x:y@h:5/envdb";
log("env", [sql.options.database, sql.options.username, (await sql`select current_database() = 'postgres' as ok`)[0].ok]);
await sql.close();
delete process.env.DATABASE_URL;

// Options object, and a database name that needs escaping in a file name.
const o = new SQL({ hostname: "h", username: "me", database: "my db/1", bigint: true });
await o`create table if not exists odd (v int8)`;
await o`delete from odd`;
await o`insert into odd values (${5})`;
log("options object", [o.options.database, typeof (await o`select v from odd`)[0].v]);
await o.close();

// A query that is still running keeps the program alive.
void (async () => {
  const slow = new SQL("pglite://:memory:");
  log("slow", (await slow`select pg_sleep(0.3), 1 as a`)[0].a);
})();

console.log("__end__");
