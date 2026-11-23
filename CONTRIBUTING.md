# Contributing

Thanks for helping. Bug reports with a share link are as useful as code: see the
[issue forms](https://github.com/oddcelot/bun-webcontainer/issues/new/choose). For anything bigger than a small fix,
open an issue first so we can agree on the approach before you spend time on it.

**Not here:**

- Gallery examples and starters live in [oddcelot/runbun-examples](https://github.com/oddcelot/runbun-examples). Open
  those pull requests there.
- Report security problems privately, as [SECURITY.md](./SECURITY.md) explains.

## How it fits together

Bun's JSC-independent Rust crates (transpiler, bundler, resolver, `bun fmt`, semver, shell parser) compile to wasm64
(Memory64). The playground runs user code in the browser's own JS engine, with JS shims for `Bun.*`, `bun:*` and
`node:*`, an in-memory file system, and a service worker that serves modules (`/__vfs/`) and `Bun.serve` previews
(`/__preview/`). [HANDOFF.md](./HANDOFF.md) explains how the port works, and
[apps/playground/README.md](./apps/playground/README.md) explains the playground's architecture.

| Path | What |
| --- | --- |
| `apps/playground/` | The app: editor, file tree, VFS, worker runtime, `Bun.serve` preview, `bun install`; `worker/` is the Cloudflare Worker behind share links |
| `apps/docs/` | docs.runbun.dev (Astro Starlight): features and compatibility |
| `crates/transpile-wasm/` | Bun's transpiler (`bun_js_parser` + `bun_js_printer`) |
| `crates/bundle-wasm/` | Bun's bundler, for `Bun.build` and `Bun.serve`'s HTML imports |
| `crates/resolve-wasm/` | `bun_resolver` over the VFS: the playground's module resolution |
| `crates/fmt-wasm/` | `bun fmt` itself over the VFS, byte-identical to native |
| `crates/check-wasm/` | `bun check` (Bun's TypeScript 7 checker) over the VFS |
| `crates/shell-wasm/` | Bun's shell parser, for `Bun.$` |
| `crates/htmlrewriter-wasm/` | lol-html, the engine under `HTMLRewriter` |
| `crates/semver-wasm/` | `bun_semver`, for `Bun.semver` and `bun install` |
| `crates/compress-wasm/` | zstd and brotli (pure Rust), for `Bun.zstd*` and `node:zlib` |
| `crates/crypto-wasm/` | RustCrypto, for `node:crypto`'s synchronous ciphers, keys and signatures |
| `crates/git-wasm/` | `git` (gix), wasm32-wasip1 |
| `crates/tsrs-ls-wasm/` | [tsrs](https://github.com/oxc-project/tsrs)'s language service, for the editor's diagnostics and hovers (wasm32-wasip1) |
| `crates/sys-host/`, `crates/sys-wasm/` | The `bun_sys` host imports, served by the VFS, and a probe of them |
| `crates/wasm-stubs/` | Stand-ins for the C/C++ symbols (JSC, WebKit, ICU) the Rust crates link against |
| `crates/shim-test/` | Native tests for the wasm mimalloc shim |
| `packages/embed/`, `packages/astro/`, `packages/connect/` | `@runbun/embed`, `@runbun/astro` and `@runbun/connect` on npm |
| `packages/ui/`, `packages/vfs/` | Private: shared tokens and Solid components; the VFS and its `bun_sys` host |
| `packages/astro-solid*/` | `@astrojs/solid-js` v8 for Solid 2, vendored until it is on npm |
| `patches/bun/` | Every change to upstream Bun, as a patch series |
| `scripts/` | Setup, Bun upgrades, patch export, release notes, checks |

## Setup

You need macOS or Linux, [proto](https://moonrepo.dev/proto) and [Homebrew](https://brew.sh) (for the shell tools in
`Brewfile`). Building the wasm crates takes a while the first time, and `bun/` (upstream Bun) is a large checkout.

```sh
git clone --recurse-submodules https://github.com/oddcelot/bun-webcontainer
cd bun-webcontainer
proto install                              # moon, Bun and Node 26, pinned in .prototools
brew bundle                                # sd, ast-grep, wasm-tools, typos, lychee, …
git config core.hooksPath .beads/hooks     # the commit checks below
bun install
moon run :test                             # sets up bun/, builds every wasm crate and runs its tests
moon run docs:dev                          # docs on :4321, playground on :5173
```

Open http://localhost:5173 in Chrome. Firefox 134+ works too, but Safari can only edit code, because it has no
WebAssembly Memory64 yet. See [browser support](https://docs.runbun.dev/compatibility/browsers/) for details.

`bun/` isn't tracked: `scripts/setup-bun.ts` recreates it from the pinned upstream commit and `patches/bun/`. Use the
nightly pinned in `scripts/bun-pins.ts` inside it (`cargo +$(bun scripts/bun-pins.ts TOOLCHAIN)`), not the
toolchain its own `rust-toolchain.toml` asks for.

## Build and test

[moon](https://moonrepo.dev) runs every task with caching. Each project's tasks are in its `moon.yml`.

```sh
moon run :test                             # every wasm crate: build, then compare with native Bun
moon run transpile-wasm:test               # one crate
moon run playground:build docs:build       # the apps, after the wasm builds they need
moon run playground:typecheck docs:check   # types
moon run root:typecheck-scripts root:typos docs:links
moon run playground:check-examples         # every gallery project installs and runs (headless Chrome, slow)
```

Run the tests for the part you touched. Most runtime areas have a test against native Bun in headless Chrome, for
example `playground:test-processes`, `test-sqlite`, `test-vm` and `test-bun-apis`. [AGENTS.md](./AGENTS.md) lists
them all.

To build a crate by hand: the wrapper crates in `crates/` are one Cargo workspace. Build them one at a time, because
built together their features unify.

```sh
W="-Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release"
(cd crates/transpile-wasm && cargo build $W && node test.ts)   # node >= 24 for Memory64
```

## Changes to Bun

Make them in `bun/`, on its `wasm-experiment` branch, as one commit per logical change (subject `crate: what`). Then
run `scripts/export-bun-patches.ts` and commit `patches/bun/` here. The pre-commit hook refuses a commit while `bun/src`
has changes that aren't exported.

Every change is gated with `cfg(target_family = "wasm")`, marked `// wasm-experiment`, and leaves native builds
unchanged. Don't touch the `*_jsc` crates. C/C++ symbol stand-ins go in `crates/wasm-stubs`, not in `bun/`.

## Code style

- TypeScript: format with `bun fmt`. Type-check with `tsrs` (TypeScript 7), as the moon tasks do.
- The playground's UI is Solid 2, which is neither Solid 1 nor React. Read `.claude/skills/solid/SKILL.md` before
  changing a `.tsx` file.
- CSS uses native nesting: one block per root class, with its states, parts and variants inside it.
- When a change adds, removes or changes what users can do, update the matching page in
  `apps/docs/src/content/docs/` in the same commit, using the status labels from `compatibility/index.md`.

## Commits

Work on a branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`). Each commit should be one logical change that builds and
passes its tests on its own. Write the subject as `area: what`, in the imperative and at most 72 characters (for
example `playground: serve from any base path`). Use the body to explain why when it isn't obvious.

Every commit (merges aside) carries a `Changelog:` trailer. The `commit-msg` hook checks it. The trailer names the kind
of change and the part it changes. If users should hear about the change, add its changelog entry on the lines below,
indented by two spaces:

```
Changelog: Fixed playground
  **Shared links open the file you shared.** A link made from a second
  tab opened the entry file instead.
```

The kinds are `Added`, `Changed`, `Fixed` and `Removed`. The parts are `playground`, `runtime`, `toolchain`, `editor`,
`docs`, `astro`, `connect` and `embed`. Use `Changelog: skip` for tests, tooling, refactors and CI. The entry describes
the change from the user's side: a bold outcome, then the symptom that's gone or the thing that's now possible.
[AGENTS.md](./AGENTS.md#commits-and-the-changelog) says which part covers what.

## Pull requests

Open the pull request against `main`. Say what changes for users, link the issue, and list what you tested and in which
browser. CI can't build the wasm crates, so the tests you ran locally are what the review relies on.

By contributing, you license your contribution under the MIT License (the text is at the end of
[LICENSE.md](./LICENSE.md)). The project ships it under the [FSL-1.1-MIT](./LICENSE.md), like the rest of the code,
which becomes MIT for everyone two years after each release.
