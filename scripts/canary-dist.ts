#!/usr/bin/env bun
// Marks a canary build (dist-canary/ of the playground or the docs) as not for search engines, before
// `wrangler deploy --env canary`. Usage: scripts/canary-dist.ts <dist dir>
// - X-Robots-Tag: noindex on every response (_headers). This is the signal that keeps pages out of results.
// - A robots.txt that allows crawling: a crawler that may not fetch a page never sees its noindex, and a blocked URL
//   can still be listed from links to it. No Sitemap line.
// - No sitemaps: they would list canary URLs (and the playground's names runbun.dev).
import { appendFileSync, existsSync, globSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("canary-dist: usage: canary-dist.ts <dist dir>");
  process.exit(1);
}
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`canary-dist: no ${dir}`);
  process.exit(1);
}
appendFileSync(join(dir, "_headers"), "\n# Canary: never indexed (scripts/canary-dist.ts)\n/*\n  X-Robots-Tag: noindex\n");
await Bun.write(join(dir, "robots.txt"), "# Canary build: not for search engines (every response is noindex).\nUser-agent: *\nAllow: /\n");
for (const f of globSync("sitemap*.xml", { cwd: dir })) rmSync(join(dir, f), { force: true });
console.log(`canary-dist: ${dir} marked noindex`);
