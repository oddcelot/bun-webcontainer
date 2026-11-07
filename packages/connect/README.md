# @runbun/connect (probe)

Runs playground code with the real Bun on your own machine, sandboxed, so the playground can fall back to it
for what the browser can't do (processes, `bun:ffi`, raw sockets, exact performance).

```sh
bun src/cli.ts          # prints ws://127.0.0.1:7357/ws?token=…
bun test.ts [secret]    # end-to-end: access checks, native APIs, sandbox, preview proxy, stdin
```

- **Access**: loopback only; the WebSocket needs the startup token and an allowed `Origin` (runbun.dev,
  canary, localhost:5173, `--allow-origin`); a non-loopback `Host` gets 421 (DNS rebinding).
- **Run**: files from the playground are written to a fresh temp dir; `bun run <entry>` with a clean env
  (`HOME`/`TMPDIR` inside the dir, `PORT` for `Bun.serve`). stdout/stderr stream back; stdin and kill go in.
- **Sandbox**: Linux `bwrap` (root read-only, `/home` `/root` `/tmp` empty, the project dir the only writable
  bind, `--unshare-all --share-net`); macOS `sandbox-exec` (writes only to the project, home unreadable apart
  from the Bun binary); elsewhere none, reported in `hello`.
- **Preview**: `/preview/<token>/<run>/…` proxies to the run's `Bun.serve`, with CORS for the allowed origins
  and CORP/COEP so the cross-origin-isolated playground can frame it.

## Findings (2026-11-07)

- `test.ts` passes on macOS (`sandbox-exec`) and on Linux arm64 with bubblewrap 0.12 as a non-root user
  (Docker with `seccomp`/`apparmor`/`systempaths=unconfined`; plain Docker masks `/proc`, so bwrap's
  `--proc` fails there, unlike on a desktop). With `RUNBUN_CONNECT_SANDBOX=none` the secret is readable and
  the escape write lands, so the sandbox checks do test something.
- From the deployed `https://runbun.dev` in Chrome: the WebSocket to `ws://127.0.0.1` connects and runs code
  (no mixed-content block); `fetch` of the preview needs CORS, an `<iframe>` needs CORP + COEP (the playground
  is `COEP: credentialless`). Chrome's Local Network Access flags these requests (`PermissionBlock`); in the
  automated profile they still went through, so expect a one-time permission prompt for users.
- Other browsers, same probe from `https://runbun.dev` (WebSocket run, CORS `fetch` of the preview, preview in
  an `<iframe>`): Chrome 156 (launched by Puppeteer), Firefox Developer Edition 160 and Zen (Firefox 159)
  pass everything. Safari 27.2 and Safari Technology Preview fail: Safari blocks `ws://` and `http://` to
  `127.0.0.1`/`localhost` from an https page as mixed content, before any request leaves (the server sees
  nothing).
- The way around it in Safari: serve the playground from the runner. On `http://localhost` Safari treats the
  page as a secure context with service workers; runbun.dev proxied there loads (edit-only, as Safari has no
  Memory64) and a same-origin WebSocket to the runner works. As native Bun runs the code, this would let
  Safari *run* code, which runbun.dev can't do today. The same setup avoids Chrome's Local Network Access
  prompt in every browser. The cost: a different origin, so projects saved on runbun.dev (IndexedDB) aren't
  visible there.
- Safari through a localhost reverse proxy of runbun.dev, in detail: Safari 27.2 registers the playground's
  `sw.js`, which controls the page after a reload and answers `/__vfs/`; Run stays disabled (no Memory64).
  Safari Technology Preview (Version/27.0) *has* Memory64: it runs the playground natively, on runbun.dev
  and through the proxy (`bun install` and Elysia start). So the docs' "Safari Technology Preview: edit
  only" (`compatibility/browsers.md`) is out of date; it is only the local runner that TP can't reach from
  runbun.dev.

## Not done

- `--open`: serve (or proxy) the playground on the runner's port, so Safari works and no browser asks for
  local-network permission; the runner then needs its own origin in the allowlist.
- Playground integration: a "Run with local Bun" switch, which in Safari would turn edit-only into runnable; syncing the VFS (and `bun install` output) both ways;
  serving the preview through the existing `/__preview/` service worker, ideally tunnelled over the one
  WebSocket so only one local-network connection needs the permission.
- Resource limits (cgroups / `ulimit`), a tighter bwrap root than `--ro-bind / /`, Windows.
