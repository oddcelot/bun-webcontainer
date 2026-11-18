# @runbun/connect

Run [runbun.dev](https://runbun.dev) playground code with the real Bun on your own machine, sandboxed. The playground
runs Bun in the browser; with this runner, a project can use what the browser can't: child processes, `bun:ffi`, real
sockets, native performance. It also lets browsers that can't run the playground's WebAssembly (stable Safari) run code.

```sh
bunx @runbun/connect --open
```

This serves the playground at http://127.0.0.1:7357/ and opens it. The header gets a **Local Bun** toggle: pressed,
Run, `bun install` and `bun test` go to Bun on this machine; off, they run in the browser as usual. Needs Bun 1.3 or
later installed. Docs: [Run with local Bun](https://docs.runbun.dev/guides/local-bun/).

## Browsers

- **`--open`** (the playground served by the runner): every browser, Safari included.
- **From runbun.dev itself**: the runner also prints a `https://runbun.dev/?connect=…` link. Chrome and Firefox only;
  Chrome first asks whether runbun.dev may reach devices on your local network. Safari blocks an https page's requests
  to `http://127.0.0.1`.

## What code from the playground can do here

The runner only listens on 127.0.0.1. A page needs the token printed at startup (a new one each time) and has to be
runbun.dev or the playground the runner serves; requests through a DNS name that points at 127.0.0.1 are refused.

Each run is a real program on your machine, in a sandbox:

| | Linux (bubblewrap) | macOS (sandbox-exec) |
| --- | --- | --- |
| Your home folder | hidden (empty) | can't be read |
| Writes | only the project's folder and its own Bun install cache | the same |
| Rest of the file system | readable | readable |
| Network | open | open |

The network stays open because the program's server has to be reachable and `bun install` has to reach the
registry. So a program can reach other services on this machine and on your local network. On macOS the runner's own
port is the exception: the program can't connect to it. On Linux it can connect, but the runner looks up who holds
the other end of the connection (in `/proc`) and turns away programs it started, so they don't get the runner's token.

So the runner asks before running anything: each playground page (until it reloads) has to be allowed in the terminal
where the runner runs, before its first run. A web page can't answer there, so a shared project whose code reaches for
the runner on its own still needs your "y". Say no if you didn't just press Run. In the playground, projects from someone
else (a share link, a GitHub repo) also open in the browser and ask before moving to Local Bun. `--no-confirm` turns
the terminal question off.

Without a sandbox (Windows, Linux without bubblewrap) the runner refuses to start. `--no-sandbox` starts it anyway, and
then code from the playground runs with all your user's rights.

`bun test -u` in the playground's console updates snapshots: after a test run the runner sends back the
`__snapshots__/*.snap` files and the test files (inline snapshots) that run changed, and the page writes them into the
project. Nothing else comes back, and the page only takes those paths: a file past 1 MiB (8 MiB in all), a link, a
non-text file or a path outside the project is left behind.

`bun test --coverage` (with `--coverage-reporter` and `--coverage-dir`, or bunfig.toml's `[test]` coverage options)
runs with native Bun too: its table prints in the console, and the `lcov.info` it writes comes back into the project
the same way. So do `-t`, `--timeout`, `--bail`, `--rerun-each`, `--todo` and `--only`.

Each run is stopped, with everything it started, past `--max-memory` (MB, all its processes together; default 2048) or
`--max-processes` (default 64). These are checked twice a second, so they aren't a hard cap.

## Options

```
--open                  open the playground in the browser
--port <n>              default 7357
--playground <url|dir>  what to serve at the root (default https://runbun.dev; a playground build directory works)
--no-playground         only the runner, for ?connect= links
--allow-origin <url>    another site that may connect (repeatable)
--no-sandbox            run without a sandbox (see above)
--no-confirm            run pages' code without asking in the terminal (see above)
--max-memory <MB>       default 2048
--max-processes <n>     default 64
```

Install bubblewrap on Linux with your package manager (`apt install bubblewrap`, `dnf install bubblewrap`,
`pacman -S bubblewrap`).

## License

MIT
