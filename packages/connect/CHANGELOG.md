# Changelog

Notable changes per release of `@runbun/connect`, the local runner for runbun.dev. Each release is tagged
`connect-v<version>` and has a GitHub Release with its section. The runner talks to the playground over its own
protocol (`src/protocol.ts`); the deployed runbun.dev and the runner from npm can differ in version.

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
