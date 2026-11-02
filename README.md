# bun-webcontainer

A StackBlitz/WebContainers-style Bun playground in the browser, built from Bun's own
JSC-independent Rust crates compiled to wasm64 (Memory64) plus JS shims for the runtime APIs.

| Path | What |
|---|---|
| `playground/` | The app: editor, file tree, VFS, worker runtime, `Bun.serve` preview, `bun install` (see its README) |
| `docs/` | Docs site (Astro Starlight) for docs.runbun.dev: features and compatibility |
| `transpile-wasm/` | Bun's transpiler (`bun_js_parser` + `bun_js_printer`) as wasm64 |
| `fmt-wasm/` | `bun fmt` (`bun_format` through `bun_lint_driver`) as wasm64: `bun fmt --stdin-filepath` itself over the VFS through `bun_sys` imports, configs included; byte-identical to native `bun fmt` |
| `tsrs-ls-wasm/` | [tsrs](https://github.com/oxc-project/tsrs)'s language service (TypeScript 7 in Rust) as a long-lived wasm32-wasip1 module: the editor's type errors (and hovers), files pushed in incrementally |
| `semver-wasm/` | `bun_semver` as wasm64 |
| `sys-wasm/` | probe: `bun_sys` file ops on wasm64 through host imports over the playground VFS |
| `resolve-wasm/` | `bun_resolver` on wasm64 (`resolve_c`): relative/bare/exports/imports/tsconfig paths over the VFS via `bun_sys` imports; 0.9 MB, only `bun_sys.*` imports |
| `sys-host/` | defines the `bun_sys_host_*` symbols bun_sys declares: `bun_sys.*` wasm imports (feature `imports`) or `-ENOSYS` stubs |
| `shim-test/` | Native tests for the wasm mimalloc shim |
| `patches/bun/` | Every change to upstream Bun as a patch series (one commit each), cfg-gated and marked `// wasm-experiment` |
| `scripts/setup-bun.sh` | Recreates `bun/`: pinned commit + `patches/bun/` as commits on `wasm-experiment`, vendored crates, codegen |
| `scripts/export-bun-patches.sh` | Exports `bun/`'s `wasm-experiment` commits to `patches/bun/` (pre-commit checks they match) |
| `scripts/bun-upgrade.sh` | Follows Bun releases: `--check` reports a newer release and whether `patches/bun/` applies; `[tag]` rebases `bun/` onto it and updates pins, toolchains and the reported version |
| `scripts/w64.sh` | wasm64 compile check of Bun crates |
| `HANDOFF.md` | How the port works, findings, next steps |

`.prototools` pins Bun, Node 26 (the wasm64 tests need >= 24) and [moon](https://moonrepo.dev), which runs the wasm crates'
builds and tests with caching (`proto install` once):

```sh
moon run :test                  # build every wasm crate (bun/ set up if missing) and run its test
moon run transpile-wasm:test    # one crate
```

By hand:

```sh
scripts/setup-bun.sh
W="-Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release"
(cd semver-wasm && cargo build $W && node test.mjs)
(cd transpile-wasm && cargo build $W && node test.mjs)
(cd sys-wasm && cargo build $W && node test.mjs)
(cd resolve-wasm && cargo build $W && node test.mjs)
(cd fmt-wasm && cargo build $W && node test.mjs)
(cd tsrs-ls-wasm && cargo build --release --target wasm32-wasip1 && node test.mjs)   # tsrs's Rust 1.99.1, not the nightly
(cd playground && bun install && bun run dev)   # http://localhost:5173, Chrome
```

Work is tracked with [beads](https://github.com/steveyegge/beads): `bd ready`.
