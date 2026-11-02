# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
proto install                              # tools pinned in .prototools: moon, bun, node 26 (wasm64 tests need >= 24)
moon run :test                             # build + test every wasm crate (cached; sets up bun/ if missing)
moon run <crate>:build|test                # one crate; config in .moon/ and <crate>/moon.yml
moon run playground:build docs:build       # playground after the wasm crates' builds; docs:check, playground:typecheck
moon run docs:dev                          # docs dev server + playground:dev (like scripts/dev.ts)
moon run root:lint-sh root:typos docs:links  # shellcheck, spelling, the built docs' internal links (tools: Brewfile)
scripts/setup-bun.ts                       # recreate bun/ (pinned commit + patches/bun/ via git am); bun/ is not tracked
scripts/export-bun-patches.ts              # after committing in bun/ on wasm-experiment
scripts/bun-upgrade.ts --check             # newer Bun release? do patches/bun/ still apply? (changes nothing)
scripts/bun-upgrade.ts [tag]               # rebase bun/ onto a release (default: latest); on conflict resolve, then --finish
scripts/w64.ts <crate>...                  # wasm64 compile check of bun crates
# The wrapper crates (crates/) are one Cargo workspace (root Cargo.toml, Cargo.lock, rust-toolchain.toml, target/;
# not bun/ or crates/tsrs-ls-wasm). Build one crate per cargo run: built together, features unify (sys-host `imports` into transpile-wasm).
W="-Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release"
(cd crates/semver-wasm && cargo build $W && node test.ts && node diff.ts)
(cd crates/transpile-wasm && cargo build $W && node test.ts)   # diff vs `bun build --no-bundle` on corpus/
(cd crates/sys-wasm && cargo build $W && node test.ts)         # bun_sys over the VFS (node >= 24; bun lacks Memory64)
(cd crates/resolve-wasm && cargo build $W && node test.ts)     # bun_resolver over the VFS vs bun (node >= 24); the playground resolves with it
(cd crates/tsrs-ls-wasm && cargo build --release --target wasm32-wasip1 && node test.ts)  # TS7 language service (tsrs); own Rust pin
(cd crates/fmt-wasm && cargo build $W && node test.ts)         # `bun fmt` (bun_format) vs native bun fmt on the repo's files (node >= 24)
(cd crates/shim-test && cargo +$TOOLCHAIN test)         # TOOLCHAIN from scripts/bun-pins.sh
bun install                                # root bun workspace (playground, docs, packages/*): one bun.lock, isolated
                                           # node_modules per package; shared versions in package.json's catalog
(cd apps/playground && bunx tsrs --noEmit && bun run dev)      # verify in Chrome (Memory64)
(cd apps/docs && bun run check && bun run build)               # docs site; `bun run deploy` publishes docs.runbun.dev
moon run playground:deploy-canary docs:deploy-canary      # canary.runbun.dev + docs-canary.runbun.dev (noindex)
scripts/dev.ts                                           # playground (:5173) + docs (:4321) dev servers; docs embeds need both
(cd apps/playground && bun run swatches)                       # after changing theme families: swatches, packages/ui/themes.json, code-themes/
# Cross-links: DOCS_URL / PLAYGROUND_URL (both builds read them; default localhost in dev, runbun.dev in builds)
```

Use `cargo +$(bun scripts/bun-pins.ts TOOLCHAIN)` (the nightly pinned in `scripts/bun-pins.ts`) inside `bun/` (don't let its rust-toolchain.toml
auto-install 11 targets). Follow Bun releases, not main: upgrade with `scripts/bun-upgrade.ts`, which also updates
the pins, the wrapper crates' toolchains and the playground's reported version.

## Architecture Overview

See README.md and HANDOFF.md. In short: Bun's JSC-independent Rust crates compile to wasm64; the
playground runs user code in the browser engine with JS shims for `Bun.*`, a VFS, a service worker
(`/__vfs/` modules, `/__preview/` Bun.serve), and Bun's wasm transpiler.

Layout: `apps/` (playground, docs), `crates/` (the Rust wrapper crates, one Cargo workspace), `packages/`
(`@runbun/astro` on npm; private `@runbun/ui` tokens and `@runbun/vfs`), `patches/` (`bun/`, `npm/`, `bun-codegen/`).

## Git Workflow

These rules override the conservative Beads profile for commits (not for pushes).

- Never work on `main`. Before the first edit, branch off an up-to-date `main`:
  `git switch -c <type>/<slug>` (`feat/`, `fix/`, `probe/`, `docs/`, `chore/`; e.g. `feat/deploy-base`).
  One branch per bead or topic; reuse the current branch if it already matches the task.
- Commit atomically as you go: one logical change per commit, each building and passing its tests
  on its own. Don't mix refactors, formatting, or unrelated fixes into a feature commit; split with
  `git add -p` if needed.
- Subject `area: what` in imperative mood (`playground: serve from any base path`), ≤72 chars; body
  explains why when it isn't obvious.
- Don't push, merge into `main`, rebase shared branches, or force-push without asking.

## Conventions & Patterns

- Changes to Bun: commit them in `bun/` on the `wasm-experiment` branch (one logical change per
  commit, subject `crate: what`), then run `scripts/export-bun-patches.ts` and commit `patches/bun/`.
  The pre-commit hook (`scripts/check-bun-patches.ts`) blocks commits while `bun/src` is dirty or
  unexported. Every change is cfg-gated (`target_family = "wasm"`), marked `// wasm-experiment`,
  and leaves native builds unchanged.
- Don't touch `*_jsc` crates.
- C/C++ symbol stand-ins belong in the wrapper crates (`crates/wasm-stubs`), not in bun.
- Stop the playground dev server by port (`kill $(lsof -tiTCP:5173 -sTCP:LISTEN)`), never `pkill vite`.
- Keep the docs site in step with the code. When a change adds, removes or changes what users can
  do (a `Bun.*`/`bun:*`/`node:*` API, toolchain or install behavior, a playground feature, browser
  support), update the matching page in `apps/docs/src/content/docs/` (`compatibility/bun.md`, `node.md`,
  `toolchain.md`, `browsers.md`, `frameworks.md`, `guides/features.md`) in the same commit, using
  the status labels from `compatibility/index.md`. Don't deploy the docs without asking.

## Shell Tools

`brew bundle` (Brewfile) installs these; prefer them over sed/python one-offs:

- `sd` for find-and-replace (`sd -F 'old/path' 'new/path' $(git grep -l 'old/path')`). Don't use `sed -i`/`sed -E`:
  macOS's BSD sed differs from GNU (`-i ''`, no `\1` in `-E` patterns). In Claude Code a hook
  (`.claude/hooks/prefer-sd.ts`) refuses in-place `sed`/`perl` edits; read-only `sed` still runs.
- `ast-grep` for structural search/rewrite in Rust/TS/TSX, e.g.
  `ast-grep run -l ts -p 'import { $$$ } from "@runbun/vfs"' apps/` (add `-r '<rewrite>' -U` to apply).
- `rg` always gets an explicit path (`rg -n foo .`): without one and with stdin not a terminal, it waits on stdin.
- `wasm-tools` for the built `.wasm`: `wasm-tools print X.wasm | rg '^\s*\((import|export)'` lists its ABI (check it
  is unchanged after a refactor); `wasm-tools validate --features all`. `twiggy top -n 20 X.wasm` shows what's big.
- `cargo machete` lists unused dependencies of the wrapper crates. Verify before removing one: a crate can be linked
  only for its `#[no_mangle]` symbols (`use bun_sys_host as _;`).
- `hyperfine -N` to time commands; give `rg` a path there too.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var
