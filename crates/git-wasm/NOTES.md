# git-wasm (from the gix-probe, bwc-vm5)

A small `git` on gitoxide (`gix` 0.90, HTTP through the host), built as `wasm32-wasip1` and run by the playground as a WASI
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

Supported: `init`, `status`, `add`, `rm [--cached]`, `restore`, `reset`, `commit`, `log`, `diff [--cached]`, `show`,
`branch`, `switch`, `checkout`, `merge`, `stash`, `tag`, `clean`, `config`, `rev-parse`, `clone`, `fetch`, `pull`, `push`,
`remote`. `git help` lists the flags. Pathspecs are plain paths or directory prefixes (no globs). Not supported: rebase (it
prints `git: 'rebase' is not supported in the playground yet`).

Output the panel parses (byte-identical to native git, checked by `test.ts`):

- `status --porcelain|-s [-b] [-z] [-uall|-uno]`: `XY path` lines, `## main` / `## main...origin/main [ahead 1, behind 2]`
  (`[gone]` without the tracking ref; `net.test.ts`) / `## No commits yet on main` / `## HEAD (no branch)` header; `-z` is NUL-terminated and raw; without `-z` paths are quoted like git (`"sp ace"`,
  octal for non-ASCII). Untracked directories collapse unless `-uall`. Staged renames are detected as git detects them (`R  old -> new`; `-z`: `R  new\0old\0`), with git's similarity score (src/rename.rs); unstaged ones stay `D` + `??`, as in git. No colors in
  porcelain/`-z`.
- `log --format=|--pretty=format:|tformat:`: `%H %h %T %t %P %p %an %ae %at %ad %ar %cn %ce %ct %cd %cr %s %b %B %n %% %xNN`
  (`--format` ends every entry with a newline, `--pretty=format:` separates them); `-n N|-N|--max-count`, `--skip`,
  `--all`, `<rev>...`, `-- <path>...` (commits that change a path, TREESAME parents skipped). `%h` is always 7 digits.
  `%d` and other placeholders are printed as written.
- `show <rev>:<path>` / `show :<path>`: the raw blob (a tree lists its entries). Missing: `fatal: path 'p' does not
  exist in 'rev'`, exit 128.
- `branch --show-current`, `--format` (`%(refname[:short])`, `%(objectname[:short])`, `%(HEAD)`), `-d|-D`, `-m`,
  `branch <name> [<start>]`. `-d` is "fully merged" = reachable from HEAD (no upstream). Refuses the current branch.
- `tag` (`tag.rs`): `[-l|--list] [<pattern>...]` (wildmatch: `*`, `?`, `[a-z]`, `[!x]`), `-n[<num>]` (git's
  `%(align:15)` name, then the annotation's, else the commit's, first lines), `<name> [<rev>]`, `-a`/`-m <msg>`
  (annotated: a tag object with the identity as tagger; `-a` without `-m` is git's `no tag message?`, there is no
  editor), `-f` (`Updated tag 'v1' (was abc1234)`), `-d <name>...`; `show <tag>` prints an annotated tag's header and
  message before the commit. Not done: `--sort`, `--contains`, `-s`/`-u` (signing), `-F`.
- `rev-parse [--verify] [-q] [--short] [--abbrev-ref] <rev>`, `--show-toplevel`, `--is-inside-work-tree`, `--git-dir`.
- `config <key> [<value>]`, `--get`, `--unset`, `--list|-l`, `--local`: the repository's `/.git/config` only;
  `--global`, `--system`, `--file` exit 128 with `only --local config in the playground`. Unset key: exit 1.

Moving between trees (`worktree.rs`): `switch|checkout <branch>`, `-c|-b <new> [<start>]`, `--detach`/`checkout <rev>`,
`-f`; `restore [--staged] [--worktree] [--source=<rev>]`, `checkout [<rev>] -- <path>`; `reset [--soft|--mixed|--hard]
[<rev>] [-- <path>]`; `commit --amend [-m] [--no-edit]` (keeps author and date). Switching is git's two-way merge: a
path that differs between the two commits is replaced only when the index and the file still match HEAD; otherwise
nothing is touched and it exits 1 with git's `Your local changes ... would be overwritten by checkout` (or the untracked
files message). Local changes to paths both commits share are carried over. Differences: `checkout` doesn't print the
`M\tfile` lines for carried changes, and detaching prints one `HEAD is now at` line instead of git's advice. Files are
written from blobs without filters (no autocrlf, symlinks become plain files), so gix's `worktree-mutation` (and the
`io-close` WASI patch it would need) isn't used. `reset --merge|--keep` are not implemented (`merge --abort` does what `reset --merge` does after a merge).

Merging (`merge.rs`, gix's `merge` feature: gix-merge, which follows merge-ort): `merge [<rev>]` (no rev: the upstream),
`--no-ff`, `--ff-only`, `-m`, `-q`, `--no-stat`, `--abort`, `--continue`. A fast-forward is the two-way merge of `switch`
(`Updating a..b`, `Fast-forward` and git's `--stat --summary`, `diff::stat`). A true merge refuses staged changes (exit 2,
as merge-ort), merges the commits with `merge_commits`, writes the merged tree (conflicting files with markers, labels
`HEAD` and the rev as typed) through the same two-way merge, so a local change or untracked file in the way refuses it
(`... would be overwritten by merge`) and other local changes stay, then puts the conflicts' stages 1-3 in the index
(`apply_index_entries`). Messages as git's (`Auto-merging`, `CONFLICT (content|add/add|modify/delete)`, by path).
A conflict leaves `MERGE_HEAD`, `MERGE_MSG` (with `# Conflicts:`), `MERGE_MODE` and exits 1; `status` then shows the
unmerged paths (`UU`/`AA`/`UD`/... and the long format's sections and hints), `add`/`rm`/`commit -a` resolve them,
`commit` (no `-m`: `MERGE_MSG`, as `--no-edit`) makes the merge commit and refuses while paths are unmerged, `switch`
refuses during a merge, `checkout` with unmerged paths, and `merge --abort` (`reset --merge`) and `reset` end it. Merge
messages: `Merge branch|tag|remote-tracking branch|commit '<rev>'` (an annotated tag's message below), ` into <branch>`
unless on main/master, ` into HEAD` when detached; several revs are grouped as fmt-merge-msg does (`Merge branches 'a'
and 'b', tag 'v1'`). Merging several revs is git-merge-octopus: the heads reduced as `reduce_heads` does, then one
after the other onto the tree so far (fast-forwarding while it can), each a three-way merge (`merge_trees`) with the
merge base of it and what is merged so far, with the script's messages (also under `-q`); only the last may leave
conflicts (else `Should not be doing an octopus.`, exit 2); it refuses staged changes and changed or untracked files
in the way. `--no-commit` stops before the commit with MERGE_HEAD/MERGE_MSG (`commit` concludes it); `--squash` writes
no MERGE_HEAD but SQUASH_MSG (`Squashed commit of the following:` and the commits in log's medium format), which
`commit` takes as its message (then MERGE_MSG's `# Conflicts:`, cleaned up as `--no-edit` does). Merging into an
unborn branch checks out the commit (one only; refuses untracked files in the way, keeps staged ones). `stash apply`
with unmerged paths prints git's `<path>: needs merge` and `error: could not write index` (exit 128). Not done:
strategies (`-s`, `-X`); `pull` still only fast-forwards.

Stashing (`stash.rs`): `stash [push] [-m <msg>] [-u] [-q]`, `save [<msg>]`, `list`, `show [-p] [--stat] [<stash>]`,
`apply [--index] [-q] [<stash>]`, `pop`, `drop [-q] [<stash>]`, `clear`; `<stash>` is `stash@{n}` or `n`. The commits
are git's: w (the tracked files as in the worktree; its message `WIP on main: abc1234 subject` or `On main: <msg>`,
without a trailing newline as git writes it) with parents HEAD, i (the index: `index on ...`) and with `-u` u (the
untracked files, a root commit: `untracked files on ...`); refs/stash's reflog is the list, and `drop` rewrites it as
`git reflog delete --rewrite --updateref` does. Native git pops ours and we apply native git's (`test.ts` checks both).
`apply` merges w's tree onto the current index with w's first parent as the base (gix `merge_trees`, labels `Updated
upstream` / `Stashed changes`), through the same two-way merge as `merge`; without `--index` what the stash staged
comes back unstaged, but for new files (git's `unstage_changes_unless_new`); then it restores u's files and prints the
long status. A conflict keeps the entry (`The stash entry is kept in case you need it again.`, exit 1). Not done:
`--keep-index`, `--all`, `--patch`, `--staged`, pathspecs, `stash branch`, `stash create|store`.

`test.ts` runs a scripted session under node's WASI and compares status, diff, log, show and every mutation with native
git: "twin" runs execute the same command on two copies of a project (ours vs native) and compare `status`, `ls-files -s`,
HEAD and every file, then `fsck`.

## Network (`http.rs`, `net.rs`)

`http(s)://` remotes only (gix's smart-HTTP client, protocol v2). gix has no HTTP backend without curl or reqwest, so
the program provides one: `http.rs` implements gix-transport's `Http` trait over two host imports, and the patched
gix-transport's `HTTP_CONNECT` hook (below) makes `connect` (and with it gix's clone and fetch) use it.

```
(import "runbun" "http_request" (head_ptr head_len body_ptr body_len out_ptr) -> i32)
  head: "METHOD URL\n" then "Name: value\n" per header. Waits for the status and headers.
  out = [status, headers_len, handle]; nonzero: the request failed, headers_len is then a message's length.
(import "runbun" "http_headers" (handle buf_ptr) -> i32)    the headers ("Name: value\n" lines), or the message
(import "runbun" "http_body" (handle buf_ptr len) -> i32)   up to len bytes, waiting for one; 0 at the end, < 0 failed
(import "runbun" "http_close" (handle))                     done with it (the body may be left unread)
(import "runbun" "progress" (text_ptr text_len))             "Connecting to github.com", "Checking out 609 files"
```

The host blocks until it has the status and headers, then hands the body over as it arrives, so gix indexes a pack
while it downloads (the playground's git worker: a streaming `fetch` on the page passing chunks through shared memory,
or one synchronous `XMLHttpRequest` without cross-origin isolation). A request is sent on the first read of its
response (gix writes a POST body after `post` returns). Status
401/403/404 become `PermissionDenied`/`NotFound` errors with the status in the message.

- `clone <url> [.] [--depth <n>] [-b <branch>] [-o <name>]`: into the project itself, which must be empty but for
  `node_modules`; gix's clone (HEAD selection, single-branch shallow), then the files from blobs as `reset --hard`
  writes them. A failed clone removes the `.git` it made. Writes `core.fileMode=false` and the `node_modules/` exclude.
- `fetch [<remote>] [--depth <n>]`, `pull [<remote> [<branch>]]` (fetch, then fast-forward only: our commit must be in
  the upstream's history; switching uses the two-way merge of `switch`), `remote [-v]`, `remote add|remove|get-url|set-url`.
- `push [<remote> [[+]<src>[:<dst>]...]] [-f] [-u] [-d] [-n]` (`push.rs`, by hand: gix has no receive-pack client).
  Protocol v0: the `git-receive-pack` advertisement, then one POST with the commands and a pack; `report-status` and
  `side-band-64k` (band 2 printed as `remote:` lines). The pack has whole objects only (no deltas): the commits not
  reachable from the remote's refs, with the trees and blobs not already in the trees of the commits they build on.
  Without a refspec: the current branch to its upstream on that remote, else to the branch of the same name (like
  `push.default=current`). Refuses non-fast-forwards (`fetch first` when the remote's commit isn't here) unless forced;
  updates the tracking refs; `-u` sets the upstream. Output as git's (`To <url>`, ` * [new branch]  main -> main`).

`net.test.ts` runs these against native `git http-backend` (a CGI server in a child process), with curl serving the
imports synchronously, and checks the results with native git (56 checks; the push checks set `http.receivepack` on the server's repositories).

## Results

- Features: `sha1 basic status dirwalk blocking-network-client merge` (no `worktree-mutation`), and gix-transport `http-client`.
- Writes match native gix byte for byte (same commit ids); `git fsck --full` is clean; status, tree diff and log
  match native output.
- Packed clones read fine. This repo (933 commits, 3.4 MiB pack, 578 files): full log walk, HEAD tree and status in
  ~65 ms under node's WASI (native `git status`: 33 ms).
- Size (the CLI): 3.96 MB stripped, 1.10 MB brotli (3.6 MB and 1.0 MB before merge, stash and tag; 2.97 MB and
  0.86 MB before the network commands).
- WASI surface: 25 `wasi_snapshot_preview1` imports (`path_open`, `fd_read`/`fd_write`/`fd_seek`, `fd_readdir`,
  `path_filestat_get`, `path_rename`, `path_unlink_file`, `path_create_directory`, …). A browser build needs those
  over the VFS; tsrs-ls-wasm only stubs WASI today.

## Patches (`patched/`, via `[patch.crates-io]`)

| Crate | Problem on WASI | Patch |
| --- | --- | --- |
| `gix-tempfile` 26.0.1 | `std::process::id()` panics (lock files) | pid 0 on WASI |
| `memmap2` 0.9.12 | stub returns `Unsupported`; gix maps objects, packs, the index | read a copy of the range; restore the file position (gix-index hashes the same handle afterwards) |
| `filetime` 0.2.29 | wasm backend is `unimplemented!()` | times from `std::fs::Metadata` |
| `gix-pack` 0.77.0 | `streaming-input` uses `gix-tempfile`, which is a dependency only off wasm32: the build fails | the dependency on every target |
| `gix-transport` 0.62.0 | no HTTP backend without curl/reqwest (neither builds for WASI) | `blocking_io::HTTP_CONNECT`, a hook `connect` uses for `http(s)://` |

The first four are small and upstreamable; the hook would need an upstream design (a pluggable HTTP backend).

## Not working / open

- gix `worktree-mutation`: `io-close` has no WASI impl. Not needed (see above); a stub (close = flush + drop) would do.
- No exec bits on WASI: set `core.fileMode=false`, or every 100755 file shows as modified.
- `wasm64-unknown-unknown`: `std::fs` does nothing there, and `gix-sec` assumes non-Windows means Unix. Use wasip1.
- Push sends packs without deltas: fine for a playground's commits, larger than git's for big edits to big files.
