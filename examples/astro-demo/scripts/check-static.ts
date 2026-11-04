#!/usr/bin/env bun
// Fails when the built static page (dist/index.html, <Code> blocks only) loads anything beyond its own HTML and the
// site's stylesheet: a script other than the Copy buttons' one inline script (once), a URL on another origin, or the
// blocks' stylesheet as a request of its own (/_runbun/highlights.css). Prints what the page weighs. Run after
// `bun run build`.
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "dist");
const html = await Bun.file(join(dist, "index.html")).text();
const problems: string[] = [];

const copy = /<script type="module" data-runbun-copy-script>[^<]*<\/script>/g;
if ((html.match(copy) ?? []).length !== 1) problems.push("doesn't have the Copy buttons' script exactly once");
if (/<script\b/i.test(html.replace(copy, ""))) problems.push("has a <script> besides the Copy buttons' one");
for (const [, url] of html.matchAll(/\b(?:src|href)="(https?:\/\/[^"]+|\/\/[^"]+)"/g)) problems.push(`loads ${url}`);
if (html.includes("_runbun/")) problems.push("links /_runbun/highlights.css instead of bundling it");
if (!html.includes('class="runbun-code')) problems.push("has no blocks (did the build change?)");

const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]!);
let css = 0;
for (const href of sheets) {
  const text = await Bun.file(join(dist, href)).text();
  css += text.length;
  for (const [, url] of text.matchAll(/url\((["']?)(https?:[^)"']+)\1\)/g)) problems.push(`its CSS loads ${url}`);
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
console.log(`dist/index.html: ${kb(html.length)} HTML, ${sheets.length} stylesheet(s) ${kb(css)}, inline <style>: ${(html.match(/<style\b/g) ?? []).length}`);
if (problems.length) {
  for (const p of problems) console.error(`check-static: the static page ${p}`);
  process.exit(1);
}
