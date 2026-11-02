#!/usr/bin/env bash
# PreToolUse(Bash): refuse in-place sed/perl edits and point at sd / ast-grep (AGENTS.md "Shell Tools").
# BSD sed (macOS) and GNU sed disagree on -i and -E back-references; sd behaves the same everywhere.

# Quoted strings are data (a search pattern, a commit message, text being written), not commands: drop them
# first. jq sees the whole command at once, so multi-line quotes go too.
read -r -d '' STRIP_QUOTES <<'JQ'
(.tool_input.command // "") | gsub("'[^']*'"; "") | gsub("\"([^\"\\\\]|\\\\.)*\""; "")
JQ
cmd=$(jq -r "$STRIP_QUOTES")

# sed/perl as a command word (start, or after ; & | ( ` or whitespace) with an in-place flag in the same command.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|(`[:space:]])(g?sed[[:space:]][^|;&]*(-[a-zA-Z]*i|--in-place)([[:space:]]|$)|perl[[:space:]][^|;&]*-[a-zA-Z]*i([[:space:]]|$|\.))'; then
  cat >&2 <<'MSG'
In-place sed/perl edits are blocked in this repo (BSD vs GNU sed differences). Use instead:
  sd -F 'old' 'new' <files>            # literal; drop -F for regex, capture groups are $1
  sd -F 'old' 'new' $(git grep -l 'old')
  ast-grep run -l ts|rust -p '<pattern>' -r '<rewrite>' -U <paths>   # structural code rewrites
Read-only sed (sed -n, sed without -i in a pipe) is fine.
MSG
  exit 2
fi
exit 0
