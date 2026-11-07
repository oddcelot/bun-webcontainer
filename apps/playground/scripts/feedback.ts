#!/usr/bin/env bun
// Prints the feedback the Worker stored (worker/index.ts: D1 database FEEDBACK, table feedback), newest first, and
// the docs' page ratings per page. Needs `wrangler login`.
//
//   bun scripts/feedback.ts                    # runbun.dev
//   bun scripts/feedback.ts --env canary       # canary.runbun.dev
//   bun scripts/feedback.ts --since 2026-11-01 --json
//   bun scripts/feedback.ts --local            # what `wrangler dev --local` stored
//   bun scripts/feedback.ts --delete 3,7       # dealt with: remove those rows (privacy page: kept until dealt with)
import { parseArgs } from "node:util";

type Row = { id: number; at: string; kind: "message" | "rating"; page: string; rating: "up" | "down" | null; message: string | null; email: string | null; env: string | null; project: string | null };

const { values: opts } = parseArgs({
  options: { env: { type: "string" }, since: { type: "string" }, json: { type: "boolean" }, local: { type: "boolean" }, delete: { type: "string" } },
});

const cwd = new URL("..", import.meta.url).pathname;
async function sql<T>(command: string): Promise<T[]> {
  const args = ["bunx", "wrangler", "d1", "execute", "FEEDBACK", opts.local ? "--local" : "--remote", "--json", "--command", command];
  if (opts.env) args.push("--env", opts.env);
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`wrangler d1 execute failed:\n${out}`);
  return (JSON.parse(out) as { results: T[] }[])[0]?.results ?? [];
}
// Rows from before the Worker stripped control characters may carry escape sequences: never print them raw.
const safe = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "\uFFFD");
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

if (opts.delete) {
  const ids = opts.delete.split(",").map(Number);
  if (!ids.length || ids.some((n) => !Number.isInteger(n))) throw new Error("--delete takes row ids, e.g. 3,7");
  await sql(`DELETE FROM feedback WHERE id IN (${ids.join(",")})`);
  console.log(`deleted ${ids.length} ${ids.length === 1 ? "row" : "rows"}`);
  process.exit(0);
}

const where = opts.since ? `WHERE at >= ${quote(opts.since)}` : "";
const rows = await sql<Row>(`SELECT * FROM feedback ${where} ORDER BY at DESC, id DESC`);
if (opts.json) {
  console.log(JSON.stringify(rows.map((r) => ({ ...r, env: r.env && JSON.parse(r.env) })), null, 2));
  process.exit(0);
}

const pages = await sql<{ page: string; up: number; down: number }>(
  `SELECT page, sum(rating = 'up') AS up, sum(rating = 'down') AS down FROM feedback ${where ? `${where} AND` : "WHERE"} kind = 'rating' GROUP BY page ORDER BY down DESC, up DESC`,
);
const messages = rows.filter((r) => r.message);
console.log(`${messages.length} messages, ${rows.filter((r) => r.kind === "rating").length} page ratings\n`);
if (pages.length) {
  console.log("Ratings by page (👍 👎):");
  for (const p of pages) console.log(safe(`  ${String(p.up).padStart(3)} ${String(p.down).padStart(3)}  ${p.page}`));
  console.log();
}
const host = opts.env === "canary" ? "https://canary.runbun.dev" : "https://runbun.dev";
for (const r of messages) {
  console.log(safe([`#${r.id}`, r.at, r.kind === "rating" ? (r.rating === "up" ? "👍" : "👎") : "✉", r.page, r.email && `<${r.email}>`].filter(Boolean).join("  ")));
  console.log(safe(r.message!).replace(/^/gm, "  "));
  if (r.project) console.log(safe(`  project: ${host}${r.project}`));
  if (r.env) console.log(safe(`  ${Object.entries(JSON.parse(r.env) as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(" · ")}`));
  console.log();
}
