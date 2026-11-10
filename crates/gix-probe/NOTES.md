# gix-probe (bwc-vm5)

Can gitoxide (`gix` 0.90, network off) run as wasm over a filesystem we provide? Yes, as `wasm32-wasip1`.

```sh
cargo build --release --target wasm32-wasip1   # nightly from rust-toolchain.toml; rustup target add wasm32-wasip1
node run.ts                                    # init, 2 commits, index, status, tree diff, log in a temp dir; then native git log/status/fsck
PROBE_OPEN=/path/to/clone node run.ts          # read an existing (packed) repo: log, HEAD tree, status
```

## Results

- Features: `sha1 basic status dirwalk blame merge` (no network, no `worktree-mutation`).
- Writes match native gix byte for byte (same commit ids); `git fsck --full` is clean; status, tree diff and log
  match native output.
- Packed clones read fine. This repo (933 commits, 3.4 MiB pack, 578 files): full log walk, HEAD tree and status in
  ~65 ms under node's WASI (native `git status`: 33 ms).
- Size: 2.5 MB stripped, 0.74 MB brotli.
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
