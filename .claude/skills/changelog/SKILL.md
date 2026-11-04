---
name: changelog
description:
  Draft the user-facing Changelog trailer for a commit, or write a release's changelog section from the commits since
  the last tag. Covers CHANGELOG.md (runbun, `v*` tags) and packages/<name>/CHANGELOG.md (@runbun/astro `astro-v*`,
  @runbun/embed `embed-v*`). Use at commit time (`/changelog entry`) and at release time (`/changelog release v0.2.0`,
  `/changelog release embed-v0.2.0`).
---

# Changelog

The changelogs are hand-written prose. Each commit carries its own entry, folded under one `Changelog:` trailer that
names the kind of change and the part of runbun it changes; git-cliff assembles those entries into a draft section.
This skill writes the entry at commit time and turns the draft into the committed section at release time. The
conventions are in AGENTS.md, "Commits and the changelog".

## `/changelog entry`

Draft the trailer for the staged change (or, with nothing staged, the working tree). Read the diff, not the commit
body: the body says why the code changed, the entry says what a user gets.

Output exactly this block, ready to go at the end of the commit message above `Co-Authored-By`:

```
Changelog: Fixed playground
  **Shared links open the file you shared.** A link made from a second
  tab opened the entry file instead.
```

| Part         | Changed files (typically)                                                                   |
| ------------ | ------------------------------------------------------------------------------------------- |
| `playground` | `apps/playground/src/ui/`, sharing, the embed page, the preview, `packages/ui`              |
| `runtime`    | the `Bun.*` / `node:*` shims, the VFS (`packages/vfs`), the service worker, `Bun.serve`     |
| `toolchain`  | `crates/` (transpile, resolve, fmt, bundle, semver), `bun install`, `patches/bun/`          |
| `editor`     | `crates/tsrs-ls-wasm`, the editor's completions, hovers, diagnostics                        |
| `docs`       | `apps/docs` content users read (not plumbing)                                               |
| `astro`      | `packages/astro` (lands in packages/astro/CHANGELOG.md only)                                |
| `embed`      | `packages/embed`: `<bun-playground>`, the protocol (packages/embed/CHANGELOG.md only)       |

A change to `packages/embed` also reaches everyone loading runbun.dev/embed.js at the next deploy; when it changes
what the embed page does too, it may need a `playground` commit of its own. Pick the part whose users notice the change; a crate change users meet as a shell command is `toolchain`, one they
meet as a working `Bun.*` API is `runtime`. A change two kinds of user meet separately is better as two commits.

Rules for the entry:

- One bullet, one to three sentences, wrapped at about 80 columns, every continuation line indented two spaces (the
  indent is what makes git fold it into the trailer).
- Starts with a bold phrase naming the outcome from the user's side (`**`bun install` resolves workspace
  packages.**`), not the implementation (`**Port resolver lockfile path**`).
- Then the symptom that is gone or the thing that is now possible. Name the API, option or UI control in backticks.
- Kind: `Added` for a new capability, `Changed` for different behaviour of an existing one, `Fixed` for a bug,
  `Removed` for something gone. Changed or Fixed: was the old behaviour ever intended? Fixed if not.
- `Changelog: skip`, nothing folded under it, for tests, CI, tooling, refactors, agent files and docs plumbing.
- Match the voice of the existing entries.

## `/changelog release v0.2.0` (runbun)

Nothing here tags, pushes or deploys; that stays with the person.

1. `moon run root:changelog -- --tag v0.2.0` prints the draft: one `###` heading per part, each bullet starting with
   its kind (`- **Fixed** — **Outcome.** …`). Bullets marked `<!-- no entry under the trailer; drafted from the
   body -->` carried only a kind and part: rewrite each from its diff (`git show <hash>`) by the rules above and drop
   the comment.
2. Merge bullets that describe one user-facing change from several commits. Inside a part keep the kinds in order
   (Added, Changed, Fixed, Removed), bigger things first.
3. Write the intro: two to four sentences on what the release is about across its parts. Read the last two intros
   first and match them. Say if anything needs action (a shared link format, a browser dropped).
4. Insert the section in `CHANGELOG.md` below the preamble, above the previous release, headed `## 0.2.0 —
   YYYY-MM-DD` with an em dash: `scripts/release-notes.ts` finds it by that and the release workflow fails without it.
5. Bump `version` in the root `package.json`.
6. Show the diff and stop. The release commit's subject is `release: runbun 0.2.0`, its body a two-sentence summary
   ending in "See CHANGELOG.md for the full section.", its trailer `Changelog: skip`. After it merges to `main`:
   `git tag v0.2.0 && git push origin main --follow-tags` creates the GitHub Release; deploy separately.

## `/changelog release astro-v0.2.0`, `embed-v0.2.0` (the npm packages)

The same, with `moon run <name>:changelog -- --tag <name>-v0.2.0` (a flat list, no part headings),
`packages/<name>/CHANGELOG.md`, and `version` in `packages/<name>/package.json`, then `bun install` so `bun.lock`
records the new version (it lists each workspace package's version; stage it with the release). The commit is
`release: @runbun/<name> 0.2.0`; the `<name>-v0.2.0` tag publishes to npm and creates the GitHub Release
(`.github/workflows/publish-<name>.yml`). Before tagging, a dry run (Actions → Publish @runbun/<name> → Run workflow)
checks the pack.

If a draft is empty, say so and stop: HEAD is already tagged or every commit since the tag was `skip`.
