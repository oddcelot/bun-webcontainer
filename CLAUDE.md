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
scripts/setup-bun.sh                       # recreate bun/ (pinned commit + patches/bun/ via git am); bun/ is not tracked
scripts/export-bun-patches.sh              # after committing in bun/ on wasm-experiment
scripts/bun-upgrade.sh --check             # newer Bun release? do patches/bun/ still apply? (changes nothing)
scripts/bun-upgrade.sh [tag]               # rebase bun/ onto a release (default: latest); on conflict resolve, then --finish
scripts/w64.sh <crate>...                  # wasm64 compile check of bun crates
W="-Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release"
(cd semver-wasm && cargo build $W && node test.mjs && node diff.mjs)
(cd transpile-wasm && cargo build $W && node test.mjs)   # diff vs `bun build --no-bundle` on corpus/
(cd sys-wasm && cargo build $W && node test.mjs)         # bun_sys over the VFS (node >= 24; bun lacks Memory64)
(cd resolve-wasm && cargo build $W && node test.mjs)     # bun_resolver over the VFS vs JS resolver and bun (node >= 24)
(cd shim-test && cargo +$TOOLCHAIN test)         # TOOLCHAIN from scripts/bun-pins.sh
(cd playground && bunx tsc --noEmit && bun run dev)      # verify in Chrome (Memory64)
```

Use `cargo +$TOOLCHAIN` (the nightly in `scripts/bun-pins.sh`) inside `bun/` (don't let its rust-toolchain.toml
auto-install 11 targets). Follow Bun releases, not main: upgrade with `scripts/bun-upgrade.sh`, which also updates
the pins, the wrapper crates' toolchains and the playground's reported version.

## Architecture Overview

See README.md and HANDOFF.md. In short: Bun's JSC-independent Rust crates compile to wasm64; the
playground runs user code in the browser engine with JS shims for `Bun.*`, a VFS, a service worker
(`/__vfs/` modules, `/__preview/` Bun.serve), and Bun's wasm transpiler.

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
  commit, subject `crate: what`), then run `scripts/export-bun-patches.sh` and commit `patches/bun/`.
  The pre-commit hook (`scripts/check-bun-patches.sh`) blocks commits while `bun/src` is dirty or
  unexported. Every change is cfg-gated (`target_family = "wasm"`), marked `// wasm-experiment`,
  and leaves native builds unchanged.
- Don't touch `*_jsc` crates.
- C/C++ symbol stand-ins belong in the wrapper crates (`transpile-wasm/src/native.rs`), not in bun.
- Stop the playground dev server by port (`kill $(lsof -tiTCP:5173 -sTCP:LISTEN)`), never `pkill vite`.
