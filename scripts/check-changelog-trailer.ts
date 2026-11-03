#!/usr/bin/env bun
// commit-msg hook: every non-merge commit says whether it belongs in a changelog, and which part of runbun it changes.
// Untrailed commits drop silently out of `moon run root:changelog`'s draft. See "Commits and the changelog" in AGENTS.md.
//
//   Changelog: Fixed playground       kind: Added | Changed | Fixed | Removed; part: see PARTS
//     **Shared links open the file you shared.** Folded entry, lines indented two spaces.
//   Changelog: skip                   tests, tooling, refactors, docs plumbing
import { $ } from "bun";

const PARTS = ["playground", "runtime", "toolchain", "editor", "docs", "astro"] as const;
const KINDS = ["Added", "Changed", "Fixed", "Removed"];

const file = process.argv[2];
if (!file) {
  console.error("usage: scripts/check-changelog-trailer.ts <commit-msg file>");
  process.exit(2);
}
const message = await Bun.file(file).text();
if (/^Merge /.test(message)) process.exit(0);

// `--parse` unfolds an indented entry onto the trailer's own line, after the kind and part.
const trailers = await $`git interpret-trailers --parse < ${file}`.text();
const value = trailers.match(/^Changelog: *(.*)$/m)?.[1]?.trim() ?? "";
const [kind = "", part = ""] = value.split(/\s+/);
const parts = PARTS.join(" | ");

const fail = (...lines: string[]): never => {
  for (const line of lines) console.error(`commit-msg: ${line}`);
  process.exit(1);
};

if (kind === "skip") process.exit(0);
if (!kind)
  fail(
    "add a 'Changelog: <Added | Changed | Fixed | Removed> <part>' trailer, or 'Changelog: skip'",
    "           (fold the user-facing entry under it on lines indented two spaces); parts: " + parts,
  );
if (!KINDS.includes(kind)) fail(`unknown Changelog kind '${kind}' (Added | Changed | Fixed | Removed | skip)`);
if (!(PARTS as readonly string[]).includes(part))
  fail(`name the part after '${kind}': 'Changelog: ${kind} <part>'`, `           parts: ${parts}`);
