# bun-webcontainer

A StackBlitz/WebContainers-style Bun playground in the browser, built from Bun's own
JSC-independent Rust crates compiled to wasm64 (Memory64) plus JS shims for the runtime APIs.

| Path | What |
|---|---|
| `apps/playground/` | The app: editor, file tree, VFS, worker runtime, `Bun.serve` preview, `bun install` (see its README) |
| `apps/docs/` | Docs site (Astro Starlight) for docs.runbun.dev: features and compatibility |
| `crates/transpile-wasm/` | Bun's transpiler (`bun_js_parser` + `bun_js_printer`) as wasm64 |
| `crates/fmt-wasm/` | `bun fmt` (`bun_format` through `bun_lint_driver`) as wasm64: `bun fmt --stdin-filepath` itself over the VFS through `bun_sys` imports, configs included; byte-identical to native `bun fmt` |
| `crates/tsrs-ls-wasm/` | [tsrs](https://github.com/oxc-project/tsrs)'s language service (TypeScript 7 in Rust) as a long-lived wasm32-wasip1 module: the editor's type errors (and hovers), files pushed in incrementally |
| `crates/semver-wasm/` | `bun_semver` as wasm64 |
| `crates/sys-wasm/` | probe: `bun_sys` file ops on wasm64 through host imports over the playground VFS |
| `crates/resolve-wasm/` | `bun_resolver` on wasm64 (`resolve_c`): relative/bare/exports/imports/tsconfig paths over the VFS via `bun_sys` imports; 0.9 MB, only `bun_sys.*` imports |
| `crates/sys-host/` | defines the `bun_sys_host_*` symbols bun_sys declares: `bun_sys.*` wasm imports (feature `imports`) or `-ENOSYS` stubs |
| `crates/wasm-stubs/` | The C/C++ symbols (JSC, WebKit, ICU, sema) the parser links against, as stand-ins; linked by transpile, bundle, resolve and fmt |
| `crates/shim-test/` | Native tests for the wasm mimalloc shim |
| `packages/astro/` | `@runbun/astro`, published to npm: Astro integration and `<Code>`/`<Playground>` components |
| `packages/ui/` | `@runbun/ui` (private): the UnoCSS preset, theme families and code themes the playground and docs share |
| `packages/vfs/` | `@runbun/vfs` (private): the in-memory VFS and the `bun_sys` host imports over it; the crates' node tests use it too |
| `patches/npm/` | Patches to npm dependencies (root `package.json` `patchedDependencies`) |
| `patches/bun-codegen/` | Codegen output `scripts/setup-bun.sh` copies into `bun/` |
| `patches/bun/` | Every change to upstream Bun as a patch series (one commit each), cfg-gated and marked `// wasm-experiment` |
| `scripts/setup-bun.sh` | Recreates `bun/`: pinned commit + `patches/bun/` as commits on `wasm-experiment`, vendored crates, codegen |
| `scripts/export-bun-patches.sh` | Exports `bun/`'s `wasm-experiment` commits to `patches/bun/` (pre-commit checks they match) |
| `scripts/bun-upgrade.sh` | Follows Bun releases: `--check` reports a newer release and whether `patches/bun/` applies; `[tag]` rebases `bun/` onto it and updates pins, toolchains and the reported version |
| `scripts/w64.sh` | wasm64 compile check of Bun crates |
| `HANDOFF.md` | How the port works, findings, next steps |

`brew bundle` installs the shell tools agents use (`Brewfile`: sd, ast-grep). `.prototools` pins Bun, Node 26 (the wasm64 tests need >= 24) and [moon](https://moonrepo.dev), which runs the wasm crates'
builds and tests with caching (`proto install` once):

```sh
moon run :test                  # build every wasm crate (bun/ set up if missing) and run its test
moon run transpile-wasm:test    # one crate
moon run playground:build       # after the wasm builds it needs
moon run docs:dev               # docs + playground dev servers
```

By hand (the wrapper crates in `crates/` are one Cargo workspace with a shared `target/`; build them one at a time, as below):

```sh
scripts/setup-bun.sh
W="-Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release"
(cd crates/semver-wasm && cargo build $W && node test.mjs)
(cd crates/transpile-wasm && cargo build $W && node test.mjs)
(cd crates/sys-wasm && cargo build $W && node test.mjs)
(cd crates/resolve-wasm && cargo build $W && node test.mjs)
(cd crates/fmt-wasm && cargo build $W && node test.mjs)
(cd crates/tsrs-ls-wasm && cargo build --release --target wasm32-wasip1 && node test.mjs)   # tsrs's Rust 1.99.1, not the nightly
bun install                     # one bun workspace: apps/*, packages/*
(cd apps/playground && bun run dev)  # http://localhost:5173, Chrome
```

Work is tracked with [beads](https://github.com/steveyegge/beads): `bd ready`.
