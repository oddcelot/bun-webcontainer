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
  automated profile they still went through, so expect a one-time permission prompt for users. Not checked:
  Firefox, Safari.

## Not done

- Playground integration: a "Run with local Bun" switch; syncing the VFS (and `bun install` output) both ways;
  serving the preview through the existing `/__preview/` service worker, ideally tunnelled over the one
  WebSocket so only one local-network connection needs the permission.
- Resource limits (cgroups / `ulimit`), a tighter bwrap root than `--ro-bind / /`, Windows.
