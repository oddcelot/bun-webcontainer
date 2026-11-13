# Changelog

Notable changes per release of `@runbun/connect`, the local runner for runbun.dev. Each release is tagged
`connect-v<version>` and has a GitHub Release with its section. The runner talks to the playground over its own
protocol (`src/protocol.ts`); the deployed runbun.dev and the runner from npm can differ in version.

## 0.1.3 — 2026-11-13

A fix for Linux systems without lsof. Nothing needs action to upgrade.

- **Fixed** — **Previews on Linux work without lsof.** A program that chose its own port never showed up in the preview
  on a system without lsof installed.

## 0.1.2 — 2026-11-07

Security fixes from an audit of the runner: update before running projects from others (`bunx
@runbun/connect@latest`). A sandboxed program could make the runner write or delete files outside its project, reach
the runner's token, or start apps outside the sandbox on macOS, and a web page could serve its own script from the
runner's address through the playground proxy. The sandbox and the terminal question stay as they were.

- **Fixed** — **A program can't make the runner touch files outside its project.** A symlink left by one run could
  redirect the next run's file writes and stale-file deletes to anywhere your user can write.
- **Fixed** — **The runner's playground proxy stays on its upstream.** A request path starting with `//` made
  `--playground <url>` fetch from another host and serve it from the runner's own address.
- **Fixed** — **A program can't read the runner's token.** It could fetch it from the runner's own port and open a
  connection of its own; macOS now blocks the port inside the sandbox, and on Linux the runner turns away connections
  from its own runs.
- **Fixed** — **A program on macOS can't open apps outside the sandbox.** `open` could launch Terminal or another app
  with your user's rights.
- **Fixed** — **Projects no longer share an install cache.** A project could plant packages that another project's
  `bun install` would reuse.

## 0.1.1 — 2026-11-07

A security fix: update before opening projects from others while the runner is on (`bunx @runbun/connect@latest`). A
shared project's own code could reach the runner from the playground's page and run on your machine without the
playground's confirmation; it was still sandboxed. Now the runner itself asks.

- **Fixed** — **Nothing runs without your OK in the runner's terminal.** Before a playground page's first run, the
  runner asks where it runs; until now a shared project's own code could reach the runner and skip the playground's
  confirmation. `--no-confirm` turns the question off.

## 0.1.0 — 2026-11-07

The first release: a runner that lets the runbun.dev playground run projects with the Bun installed on your machine,
sandboxed. It needs Bun 1.3 or later, and bubblewrap on Linux; there is no Windows support yet. The playground side
(the **Local Bun** button) ships with runbun.dev.

- **Added** — **Run playground code with the real Bun on your machine.** `bunx @runbun/connect --open` serves the
  playground at http://127.0.0.1:7357/ and runs projects with native Bun: child processes, `bun:ffi`, raw sockets,
  `HTMLRewriter` and native speed work, and Safari, which can't run the playground itself, can run code.
- **Added** — **Each run is sandboxed.** bubblewrap on Linux and sandbox-exec on macOS keep a program out of your home
  folder and let it write only to its project and Bun's package cache. Without a sandbox the runner doesn't start
  unless given `--no-sandbox`.
- **Added** — **Runaway programs are stopped.** A run that uses more than 2048 MB or 64 processes is killed with
  everything it started (`--max-memory`, `--max-processes`), and Stop ends child processes too.
- **Added** — **Connect from runbun.dev itself.** The runner prints a `?connect=` link that opens runbun.dev, with your
  saved projects, connected to it (Chrome and Firefox). A page needs the runner's token, which changes on every start,
  and the runner listens only on 127.0.0.1.
