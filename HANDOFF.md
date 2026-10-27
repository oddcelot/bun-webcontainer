# Handoff: an in-browser Bun from Bun's own Rust crates

## Goal

A StackBlitz/WebContainers-style "Bun" in the browser. User code runs in the browser's JS engine.
`Bun.*` APIs are shimmed in JS. Bun's JSC-independent Rust crates are compiled to wasm64
(Memory64), because Bun's string types need 64-bit pointers.

## Status (2026-10-27)

| Piece | State |
|---|---|
| `bun_semver` → wasm64 | done: 51 KB, 0 imports, matches Bun 1.4.4 on 648/648 cases |
| `bun_js_parser` + `bun_js_printer` → wasm64 | done: 4.1 MB, 0 imports, output byte-identical to `bun build --no-bundle --target=browser` on the corpus, 3–13 ms/file, no memory growth over 2000 runs |
| Playground (`playground/`) | working in Chrome: editor, VFS, worker runtime with `Bun` shim, service-worker preview for `Bun.serve`, `bun install` from npm via semver wasm, **transpiling with Bun's wasm transpiler** |

## Layout

```
bun/                     untracked; scripts/setup-bun.sh recreates it (upstream @ 79420086 + bun-wasm.patch + vendor/ + codegen)
bun-wasm.patch           the whole bun diff: 32 files changed + 4 new, every hunk cfg-gated, marked `// wasm-experiment`
build_options.rs         copy to bun/build/debug/codegen/
scripts/w64.sh crate...  wasm64 compile check of bun crates (errors in short form)
semver-wasm/             cdylib: Bun.semver order/satisfies; test.mjs, diff.mjs (vs real Bun)
transpile-wasm/          cdylib: Bun's transpiler; src/lib.rs (parse→print), src/native.rs (C/C++ stand-ins),
                         examples/smoke.rs (native), test.mjs + corpus/ (wasm vs `bun build --no-bundle`)
shim-test/               runs the wasm mimalloc shim natively under cargo test (+ ASan)
playground/              Vite app; README has architecture + limitations
```

## Reproduce

```sh
scripts/setup-bun.sh        # clone bun @ pinned commit, apply bun-wasm.patch, vendor crates, codegen, toolchain

W="-Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release"
(cd semver-wasm && cargo build $W && node test.mjs && bun gen-expected.ts && node diff.mjs)
(cd transpile-wasm && cargo build $W && node test.mjs)
(cd playground && bun install && bun run dev)   # predev copies both .wasm into public/
```

## How the port works

- **Allocator.** `mimalloc_sys/wasm.rs` implements the `mi_*` API in Rust on top of `std::alloc`.
  Heaps keep their own block lists, so `mi_heap_destroy` frees everything in the heap.
  `bun_alloc/wasm_libc.rs` supplies `malloc`/`free`/`strlen`. It is mounted as `crate::libc`,
  which shadows the empty `libc` crate on this target.
- **Syscalls.** `sys/wasm_impl.rs` is a third `bun_sys` backend, next to the POSIX and Windows
  ones, and every operation returns ENOSYS. `sys/wasm_libc.rs` holds the Linux-valued types and
  constants that `bun_sys` names through `libc::`. **This is the future kernel boundary:**
  `wasm_impl.rs` is where calls into the playground's VFS (host imports) go.
- **The rest.** wasm branches for OS ladders in `bun_core`, `errno` (Linux numbering), `io`,
  `crash_handler`, `spawn_sys`, `uws_sys`, `analytics`, `windows_sys` and `pod`.
  - Exit/abort calls `abort()`, the clock returns 0, and the entropy seed is fixed.
  - `is_writable` and `reload_process` are `unimplemented!`.
  - Everything else returns ENOSYS or is a no-op.
- **Native symbols** are supplied by the wrapper crates, not by bun. `transpile-wasm` includes
  upstream's `src/sema/standalone/native.rs` via `#[path]` (37 symbols, written for parser-only
  binaries) and adds 9 more in `src/native.rs`.
  - `**` and `StringToNumber` follow ECMAScript, because the parser's constant folding calls them.
  - ICU collation falls back to code-unit order.
  - Macros, the transpiler cache, WTF strings and URLs `unreachable!()`.
  - `build.rs` sets `--cfg bun_sema_mimalloc` on wasm, so sema's fake mimalloc steps aside for
    the `mimalloc_sys` shim.
- **Transpile options** copy what `bundler/transpiler.rs` sets for `--no-bundle --target=browser`:
  `auto_import_jsx`, `no_macros`, `top_level_await`, `lower_using` and `standard_decorators`. JSX uses
  the automatic dev runtime (`react/jsx-dev-runtime`), like Bun.

Parser and printer depend on `bun_crash_handler`, which drags `bun_io`, `uws_sys`, `spawn_sys`,
`boringssl_sys` and `http_types` into the closure. They only had to compile; nothing calls them.

## Next tasks

Tracked in beads (`bd ready`, `bd blocked`, `bd show <id>`). Epics: Bun crates → wasm64,
playground runtime, playground UI, reproducibility/browsers.

## Constraints

- Every bun change is cfg-gated and marked `// wasm-experiment`, so native builds don't change.
  Keep the diff rebaseable.
- Don't touch `*_jsc` crates.
