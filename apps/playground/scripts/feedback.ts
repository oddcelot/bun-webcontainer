#!/usr/bin/env bun
// Prints the feedback the Worker stored (worker/index.ts: KV namespace LINKS, keys "feedback:<time>:<random>"),
// newest first. Needs `wrangler login`. Reads only; nothing is removed.
//
//   bun scripts/feedback.ts                 # runbun.dev
//   bun scripts/feedback.ts --env canary    # canary.runbun.dev
//   bun scripts/feedback.ts --since 2026-11-01 --json
import { parseArgs } from "node:util";
import type { Feedback } from "../worker/index.ts";

const { values: opts } = parseArgs({
  options: { env: { type: "string" }, since: { type: "string" }, json: { type: "boolean" } },
});

const cwd = new URL("..", import.meta.url).pathname;
const wrangler = async (...args: string[]) => {
  const p = Bun.spawn(["bunx", "wrangler", ...args, "--binding", "LINKS", "--remote", ...(opts.env ? ["--env", opts.env] : [])], { cwd, stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`wrangler ${args.join(" ")} failed`);
  return out;
};

const keys = (JSON.parse(await wrangler("kv", "key", "list", "--prefix", "feedback:")) as { name: string }[])
  .map((k) => k.name)
  .filter((k) => !opts.since || k.slice("feedback:".length) >= opts.since)
  .sort()
  .reverse();

const entries: Feedback[] = [];
for (const key of keys) entries.push(JSON.parse(await wrangler("kv", "key", "get", key, "--text")));

if (opts.json) console.log(JSON.stringify(entries, null, 2));
else {
  const ratings = entries.filter((e) => e.kind === "rating");
  const up = ratings.filter((e) => e.rating === "up").length;
  console.log(`${entries.length - ratings.length} messages, ${ratings.length} page ratings (${up} up, ${ratings.length - up} down)\n`);
  for (const e of entries) {
    const head = [e.at, e.kind === "rating" ? (e.rating === "up" ? "👍" : "👎") : "✉", e.page, e.email && `<${e.email}>`].filter(Boolean).join("  ");
    console.log(head);
    if (e.message) console.log(e.message.replace(/^/gm, "  "));
    if (e.project) console.log(`  project: https://${opts.env === "canary" ? "canary." : ""}runbun.dev${e.project}`);
    if (e.env) console.log(`  ${Object.entries(e.env).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
    console.log();
  }
}
