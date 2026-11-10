# git-wasm (from the gix-probe, bwc-vm5)

A small `git` on gitoxide (`gix` 0.90, network off), built as `wasm32-wasip1` and run by the playground as a WASI
command module over its VFS.

```sh
moon run git-wasm:build git-wasm:test          # or: cargo build --release --target wasm32-wasip1 && node test.ts
# -> target/wasm32-wasip1/release/git.wasm (nightly + target from rust-toolchain.toml)
```

## CLI

Host contract: argv via WASI args (`git status -s`); the project root is the preopen `/` and the cwd; env
`GIT_COLOR=1` (ANSI colors), `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`; stdin unused. Exit 0, 1 (error), 128 (fatal).
Opens with `core.fileMode=false` (no exec bits on the host FS). `init` writes that into `.git/config` and
`node_modules/` into `.git/info/exclude`. Identity: `user.name`/`user.email`, else the env, else
`Playground <playground@runbun.dev>`.

Supported: `init`, `status [-s]`, `add <pathspec>|.|-A|-u`, `rm [--cached]`, `restore --staged`, `reset [<path>]`,
`commit [-a] -m`, `log [--oneline] [-n N|-N]`, `diff [--cached]`, `show [<rev>]`, `branch [<name>]`, `rev-parse`.
Pathspecs are plain paths or directory prefixes (no globs). Not supported: checkout/switch/restore of the worktree,
merge, rebase, stash, tag, network commands (they print `git: '<cmd>' is not supported in the playground yet`).
`test.ts` runs a scripted session under node's WASI and compares status, diff, log and show with native git.

## Results

- Features: `sha1 basic status dirwalk` (no network, no `worktree-mutation`).
- Writes match native gix byte for byte (same commit ids); `git fsck --full` is clean; status, tree diff and log
  match native output.
- Packed clones read fine. This repo (933 commits, 3.4 MiB pack, 578 files): full log walk, HEAD tree and status in
  ~65 ms under node's WASI (native `git status`: 33 ms).
- Size (the CLI): 2.8 MB stripped, 0.82 MB brotli.
- WASI surface: 25 `wasi_snapshot_preview1` imports (`path_open`, `fd_read`/`fd_write`/`fd_seek`, `fd_readdir`,
  `path_filestat_get`, `path_rename`, `path_unlink_file`, `path_create_directory`, …). A browser build needs those
  over the VFS; tsrs-ls-wasm only stubs WASI today.

## Patches (`patched/`, via `[patch.crates-io]`)

| Crate | Problem on WASI | Patch |
| --- | --- | --- |
| `gix-tempfile` 26.0.1 | `std::process::id()` panics (lock files) | pid 0 on WASI |
| `memmap2` 0.9.12 | stub returns `Unsupported`; gix maps objects, packs, the index | read a copy of the range; restore the file position (gix-index hashes the same handle afterwards) |
| `filetime` 0.2.29 | wasm backend is `unimplemented!()` | times from `std::fs::Metadata` |

All three are small and upstreamable.

## Not working / open

- `worktree-mutation` (checkout): `io-close` has no WASI impl. Small patch or upstream fix.
- No exec bits on WASI: set `core.fileMode=false`, or every 100755 file shows as modified.
- `wasm64-unknown-unknown`: `std::fs` does nothing there, and `gix-sec` assumes non-Windows means Unix. Use wasip1.
- Network (clone/fetch/push): not tried. gix's HTTP transport is pluggable, but github.com's smart HTTP doesn't send
  CORS headers, so a proxy is needed regardless.
