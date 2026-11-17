// A database that outlives the program: each run adds a row and prints all of them. Runs 1 and 3 end by themselves, run 2
// with process.exit (which stops the worker at once: the database is written back first).
import { SQL } from "bun";

const db = new SQL(process.env.CASE_DB!);
await db`create table if not exists persist_kv (n serial primary key, run int)`;
const [{ c }] = await db`select count(*)::int as c from persist_kv`;
await db`insert into persist_kv (run) values (${c + 1})`;
const runs = (await db`select run from persist_kv order by n`).map((r: { run: number }) => r.run);
console.log("persist run", c + 1, JSON.stringify(runs));
if (c === 1) process.exit(0);
