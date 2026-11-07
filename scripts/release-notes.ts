#!/usr/bin/env bun
// Prints one version's section of a changelog, without its heading, for GitHub Release notes. A tag names its
// version after the `v`, and picks the changelog: `v0.2.0` → CHANGELOG.md, `<name>-v0.2.0` →
// packages/<name>/CHANGELOG.md (astro, connect, embed).
//
//   scripts/release-notes.ts v0.2.0 > notes.md
//   scripts/release-notes.ts embed-v0.2.0 > notes.md
//
// Exits non-zero when the section is missing or empty, so a release can't go out with its changelog forgotten.
import { join } from "node:path";

const tag = process.argv[2];
const version = tag?.replace(/^(?:.*-)?v(?=\d)/, "");
if (!tag || !version) {
  console.error("usage: scripts/release-notes.ts <tag>");
  process.exit(2);
}
const pkg = tag.match(/^([a-z][\w-]*)-v\d/)?.[1];
const changelog = pkg ? `packages/${pkg}/CHANGELOG.md` : "CHANGELOG.md";

const lines = (await Bun.file(join(import.meta.dir, "..", changelog)).text()).split("\n");
// Headings read `## 0.2.0 — 2026-11-03`.
const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
if (start === -1) {
  console.error(`[release-notes] no "## ${version}" section in ${changelog}`);
  process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
if (end === -1) end = lines.length;

const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) {
  console.error(`[release-notes] the ${version} section of ${changelog} is empty`);
  process.exit(1);
}
process.stdout.write(body + "\n");
