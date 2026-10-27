# bun-webcontainer

A StackBlitz/WebContainers-style Bun playground in the browser, built from Bun's own
JSC-independent Rust crates compiled to wasm64 (Memory64) plus JS shims for the runtime APIs.

| Path | What |
|---|---|
| `playground/` | The app: editor, file tree, VFS, worker runtime, `Bun.serve` preview, `bun install` (see its README) |
| `transpile-wasm/` | Bun's transpiler (`bun_js_parser` + `bun_js_printer`) as wasm64 |
| `semver-wasm/` | `bun_semver` as wasm64 |
| `shim-test/` | Native tests for the wasm mimalloc shim |
| `bun-wasm.patch` | Every change to upstream Bun, cfg-gated and marked `// wasm-experiment` |
| `scripts/setup-bun.sh` | Recreates `bun/` (pinned commit + patch + vendored crates + codegen) |
| `scripts/w64.sh` | wasm64 compile check of Bun crates |
| `HANDOFF.md` | How the port works, findings, next steps |

```sh
scripts/setup-bun.sh
W="-Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release"
(cd semver-wasm && cargo build $W && node test.mjs)
(cd transpile-wasm && cargo build $W && node test.mjs)
(cd playground && bun install && bun run dev)   # http://localhost:5173, Chrome
```

Work is tracked with [beads](https://github.com/steveyegge/beads): `bd ready`.
