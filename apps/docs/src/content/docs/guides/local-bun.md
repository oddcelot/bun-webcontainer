---
title: Run with local Bun
description: "Run playground projects with the real Bun on your own machine, sandboxed: child processes, bun:ffi and real sockets work, and Safari can run code. Start it with bunx @runbun/connect --open."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Run playground code with the real Bun on your machine | Run Bun"
sidebar:
  order: 3.5
---

The playground runs Bun in your browser. For what the browser can't do, it can hand a project to Bun installed on your own computer instead: a small runner, `@runbun/connect`, runs it there in a sandbox and sends the output back. Child processes (`Bun.spawn`, `node:child_process`), `bun:ffi`, real TCP sockets and native speed then work, and browsers that can't run the playground themselves (Safari) can run code.

You need [Bun](https://bun.sh) 1.3 or later installed, and on Linux [bubblewrap](https://github.com/containers/bubblewrap) (`apt install bubblewrap`, `dnf install bubblewrap`, `pacman -S bubblewrap`). macOS has its sandbox built in. There is no sandbox for Windows yet.

## Start it

```sh
bunx @runbun/connect --open
```

This opens the playground at `http://127.0.0.1:7357/`, served by the runner. The header's **Local Bun** button, which on runbun.dev opens these steps, now switches where runs go:

- **Pressed**: Run, `bun install` and `bun test` go to Bun on your machine. The console says which version and sandbox, and the output of the native program shows there. The preview works as before.
- **Not pressed**: runs stay in the browser, as without the runner.

`bun test -u` (`--update-snapshots`) works here too, with `@runbun/connect` 0.3.0 or newer: after the run, the runner sends back the `__snapshots__/*.snap` files it changed and the test files whose inline snapshots it rewrote, and the playground writes them into your project, so the editor shows them. A first run that writes new snapshots without `-u` is copied back the same way. Only those files come back: a file over 1 MiB (8 MiB in all), a link, a file that is not text and anything outside the project are left behind, since the program under test wrote them. With an older runner the console says to update it.

Switching restarts a running program on the other side. Going back to the browser installs `node_modules` in the page first, since the runner keeps its own. The choice is remembered. If you stop the runner, runs move back to the browser and the button greys out; start it again and reload.

Projects saved on runbun.dev don't show up at `127.0.0.1:7357`: browsers keep each site's storage apart. Share a link or download a zip to move one over.

## From runbun.dev

The runner also prints a `https://runbun.dev/?connect=…` link. It opens runbun.dev itself (with your saved projects) connected to the runner; pasting it into the **Local Bun** dialog on an open page does the same. The playground only connects to a runner on this machine (`127.0.0.1`, `localhost` or `[::1]`); a `?connect=` link to any other host is ignored, so a link can't make it send your project elsewhere.

- Chrome asks whether runbun.dev may access devices on your local network. Allow it; the console says when the playground is waiting for that.
- Firefox connects without asking.
- Safari can't: it blocks an https page's requests to `http://127.0.0.1`. Use `--open`.

The link holds a token that changes every time the runner starts, so an old link stops working.

## What a program can do on your machine

The runner listens only on `127.0.0.1`, and only runbun.dev (or the playground it serves) with the current token can connect. Every run is a real program in a sandbox:

| | Linux (bubblewrap) | macOS (sandbox-exec) |
|---|---|---|
| Your home folder | Hidden: it looks empty | Can't be read |
| Writing files | Only the project's folder and its own Bun package cache are kept; other writes land in a throwaway copy | Refused, except in the project's folder and its own Bun package cache |
| The rest of the file system | Readable | Readable |
| Environment variables | None of yours; the project's [`env`](/guides/project-config/), but not `PATH`, `HOME` or `LD_*` | None of yours; the project's [`env`](/guides/project-config/), but not `PATH`, `HOME` or `DYLD_*` |
| Network | Open | Open |

The network stays open because the preview has to reach the program's server and `bun install` has to reach the registry. That means a program can also reach other services on your computer and your local network. The exception is the runner's own port: on macOS a program can't connect to it, and on Linux the runner turns away connections that come from a program it started, so a program can't read the runner's token. A new connection also waits for your answer in the terminal.

So nothing runs on your machine without asking you there. Before a playground page's first run, the runner asks in its terminal:

```
http://127.0.0.1:7357 wants to run code on this machine:
  bun run index.ts  ·  index.ts, util.ts, index.html, client.ts, styles.css, … (6 files)
Allow this page to run code here until it reloads? Say no if you didn't just press Run. [y/N]
```

The answer holds until the page reloads. A web page can't answer in your terminal, so even code that tries to reach the runner by itself (a shared project's preview, say) needs your "y". The console says when the playground is waiting for it. Started without a terminal, the runner refuses every page; `--no-confirm` turns the question off.

The playground asks too. A share link or a GitHub repo opens in the browser, whatever you chose before; pressing **Local Bun** then asks "Run … on this machine?" first. In Safari, which can't run it in the browser, Run asks instead.

A run is stopped, with every process it started, when it uses more than 2048 MB of memory or 64 processes. Change the limits with `--max-memory` and `--max-processes`. They are checked twice a second, so a program can briefly go past them.

Without a sandbox, the runner doesn't start. `--no-sandbox` starts it anyway, and code from the playground then runs with all your user's rights; use it only for code you'd run yourself.

## Options

| Option | Default | What it does |
|---|---|---|
| `--open` | | Opens the playground in your browser. |
| `--port <n>` | `7357` | The runner's port. |
| `--playground <url or dir>` | `https://runbun.dev` | What it serves at `/`: a proxy of runbun.dev, or a playground build. |
| `--no-playground` | | Only the runner, for `?connect=` links. |
| `--allow-origin <url>` | | Another site that may connect; repeat for more. |
| `--no-sandbox` | | Runs without a sandbox (see above). |
| `--no-confirm` | | Runs pages' code without asking in the terminal (see above). |
| `--max-memory <MB>` | `2048` | Memory for one run, all its processes together. |
| `--max-processes <n>` | `64` | Processes for one run. |

## Not yet

- The editor doesn't see the types of installed packages: `node_modules` lives with the runner.
- Typing into the console doesn't reach a running native program's stdin.
- WebSockets from the preview to a native server don't connect yet.
- Ports are your machine's: two projects on `:3000` collide, and so does another app on that port.
