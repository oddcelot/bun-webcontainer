# bun-webcontainer

A StackBlitz/WebContainers-style Bun playground in the browser, built from Bun's own
JSC-independent Rust crates compiled to wasm64 (Memory64) plus JS shims for the runtime APIs.

| Path | What |
|---|---|
| `playground/` | The app: editor, file tree, VFS, worker runtime, `Bun.serve` preview, `bun install` (see its README) |
| `transpile-wasm/` | Bun's transpiler (`bun_js_parser` + `bun_js_printer`) as wasm64 |
| `semver-wasm/` | `bun_semver` as wasm64 |
| `sys-wasm/` | probe: `bun_sys` file ops on wasm64 through host imports over the playground VFS |
| `sys-host/` | defines the `bun_sys_host_*` symbols bun_sys declares: `bun_sys.*` wasm imports (feature `imports`) or `-ENOSYS` stubs |
| `shim-test/` | Native tests for the wasm mimalloc shim |
| `patches/bun/` | Every change to upstream Bun as a patch series (one commit each), cfg-gated and marked `// wasm-experiment` |
| `scripts/setup-bun.sh` | Recreates `bun/`: pinned commit + `patches/bun/` as commits on `wasm-experiment`, vendored crates, codegen |
| `scripts/export-bun-patches.sh` | Exports `bun/`'s `wasm-experiment` commits to `patches/bun/` (pre-commit checks they match) |
| `scripts/w64.sh` | wasm64 compile check of Bun crates |
| `HANDOFF.md` | How the port works, findings, next steps |

```sh
scripts/setup-bun.sh
W="-Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release"
(cd semver-wasm && cargo build $W && node test.mjs)
(cd transpile-wasm && cargo build $W && node test.mjs)
(cd sys-wasm && cargo build $W && node test.mjs)
(cd playground && bun install && bun run dev)   # http://localhost:5173, Chrome
```

Work is tracked with [beads](https://github.com/steveyegge/beads): `bd ready`.
