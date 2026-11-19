# Changelog

Notable changes per release of `@runbun/connect`, the local runner for runbun.dev. Each release is tagged
`connect-v<version>` and has a GitHub Release with its section. The runner talks to the playground over its own
protocol (`src/protocol.ts`); the deployed runbun.dev and the runner from npm can differ in version.

## 0.5.0 — 2026-11-19

The runner passes more of `bun test`'s flags to Bun: `-t`, `--timeout`, `--bail`, `--rerun-each`, `--todo` and
`--only`. Nothing needs action to upgrade; older runners ignore the flags.

- **Added** — **`bun test -t`, `--timeout`, `--bail`, `--rerun-each`, `--todo` and `--only` run natively.** The runner
  passes them to the Bun it runs; before, a page could not send them.

## 0.4.0 — 2026-11-18

`bun test --coverage` works with Local Bun: the runner passes the coverage flags to Bun and sends the `lcov.info` back
to the playground. Nothing needs action to upgrade; the playground asks older runners to update when you use
`--coverage`.

- **Added** — **`bun test --coverage` runs with Local Bun.** The runner passes `--coverage`, `--coverage-reporter` and
  a `--coverage-dir` inside the project to Bun and sends the `lcov.info` it writes back to the playground, where it
  used to refuse coverage runs.

## 0.3.0 — 2026-11-17

`bun test -u` works with Local Bun: the runner sends the snapshots a test run wrote back to the playground. Nothing
needs action to upgrade; the playground asks older runners to update when you use `-u`.

- **Added** — **`bun test -u` can update snapshots.** A test run now sends back the snapshot files and inline-snapshot
  edits it made, so the playground can put them in the project. Nothing else leaves the run's folder: links, binary
  and oversized files and paths outside the project stay behind.

## 0.2.0 — 2026-11-15

Projects can set environment variables for their runs: the `env` in a project's runbun.json now reaches programs run
with Local Bun, as it already did in the browser. Nothing needs action to upgrade.

- **Added** — **Programs get their project's environment variables.** The `env` of a project's runbun.json reaches the
  program and `bun test`, apart from the runner's own variables and the dynamic loader's.

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
