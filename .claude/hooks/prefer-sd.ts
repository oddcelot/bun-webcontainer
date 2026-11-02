#!/usr/bin/env bun
// PreToolUse(Bash): refuse in-place sed/perl edits and point at sd / ast-grep (AGENTS.md "Shell Tools").
// BSD sed (macOS) and GNU sed disagree on -i and -E back-references; sd behaves the same everywhere.

export {}; // a module, for top-level await

const input = JSON.parse((await Bun.stdin.text()) || "{}");
let cmd: string = input?.tool_input?.command ?? "";

// Quoted strings are data (a search pattern, a commit message, text being written), not commands: drop them
// first. The whole command is stripped at once, so multi-line quotes go too.
cmd = cmd.replace(/'[^']*'/g, "").replace(/"([^"\\]|\\.)*"/g, "");

// sed/perl as a command word (start, or after ; & | ( ` or whitespace) with an in-place flag in the same command.
const inPlace = /(^|[;&|(`\s])(g?sed\s[^|;&]*(-[a-zA-Z]*i|--in-place)(\s|$)|perl\s[^|;&]*-[a-zA-Z]*i(\s|$|\.))/;
if (cmd.split("\n").some((line) => inPlace.test(line))) {
  console.error(`In-place sed/perl edits are blocked in this repo (BSD vs GNU sed differences). Use instead:
  sd -F 'old' 'new' <files>            # literal; drop -F for regex, capture groups are $1
  sd -F 'old' 'new' $(git grep -l 'old')
  ast-grep run -l ts|rust -p '<pattern>' -r '<rewrite>' -U <paths>   # structural code rewrites
Read-only sed (sed -n, sed without -i in a pipe) is fine.`);
  process.exit(2);
}
