---
title: Features
description: "A tour of the runbun.dev playground: the editor with TypeScript completions, the console, running code, the Bun.serve preview, package installs, projects and share links."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Bun playground features: editor, console, preview, sharing | Run Bun"
sidebar:
  order: 2
---
The playground at runbun.dev is an editor, a console, a preview and a Git view on one project. Each area has its own page; this one gives a short account of each, then covers installs, projects, embedding and links.

## Editor and files

A syntax-highlighted editor with a file tree, tabs, auto-save, formatting, TypeScript completions and hovers, a diff of your changes, and configurable keyboard shortcuts.

[Editor and files →](/playground/editor/) ([Keyboard shortcuts](/playground/editor/#keyboard-shortcuts))

## Console

A terminal that runs `bun` commands and Bun's shell over the project's files, and shows your program's output.

[Console →](/playground/console/)

### Console input

A program that reads `process.stdin`, `readline` or `prompt()` gets what you type in the console, including raw mode for prompt libraries.

[Console input →](/playground/console/#console-input)

### Git

A Git view in place of the file tree, and a `git` command in the console, both running gitoxide compiled to WebAssembly: branches, merges, stashes, rebases, and clone, pull and push for GitHub, GitLab, Codeberg and Bitbucket.

[Git →](/playground/git/)

## Running code

**Run** starts your program in a Web Worker, and **Watch** restarts it when you save.

[Running code →](/playground/running-code/)

### Debugger

Set breakpoints, step through code and evaluate expressions while the program is paused.

[Debugger →](/playground/running-code/#debugger)

## Preview

When your code starts a server, the preview shows it, with a request bar for sending any method, path, headers and body, several tabs, WebSockets, cookies and streaming.

[Preview →](/playground/preview/)

### Fast path for browser-only projects

An experimental mode that runs a browser-only project without `bun install` and without a worker, loading packages from esm.sh.

[Fast path for browser-only projects →](/playground/fast-path/)

## Installing packages

Dependencies install automatically when one of your own projects or an example opens with missing packages (a project from a link waits for Run, which installs first). `bun install` uses `bun.lock` when there is one. Details and limits are in [Toolchain](/compatibility/toolchain/#bun-install).

## Projects

- **Saved as you type**, in your browser. See [Storage and persistence](/guides/storage/).
- <details>
  <summary><strong>Share:</strong> the Share menu copies a link with the whole project in the URL (nothing is uploaded), a Markdown badge, or HTML.</summary>

  `node_modules`, `.git`, binary files and secrets (`.env`, keys, `.npmrc`) are left out. Very long links can be shortened to `runbun.dev/s/<id>`, which stores a copy on runbun.dev (see [Privacy](/privacy/)).

  **Download as zip** saves every file except `node_modules` and `.git`, binaries included.

  </details>
- <details>
  <summary><strong>Repositories:</strong> <strong>Repository…</strong> in the project gallery opens a public repo as files, or cloned with its Git history.</summary>

  **Repository…** in the project gallery opens a public repo two ways.

  - **Files** (the default, or `?repo=`) brings a GitHub repo's files, branch or subfolder without their history: up to 500 files, and GitHub allows 60 imports an hour per IP.
  - **With Git history** (or `?git=<url>`) clones a repository from GitHub, GitLab, Codeberg or Bitbucket with its last 50 commits (the status bar shows how much has arrived), so you can commit, branch, fetch and pull in the [Git](/playground/git/) view; the Git view's **Clone a repository…** opens the same choice.

  </details>
- <details>
  <summary><strong>Project gallery:</strong> the project button in the header opens starters (Blank, HTTP API, React, SQLite, WebSocket chat) and examples (Elysia, Hono, Lit SSR, Solid 2 SSR, Solid 2 + Vite, Astro + Solid, Vite and more).</summary>

  The starters and examples are in sections down the side. Search by name or technology, or narrow it with the technology tags. Open a folder, a zip or a repository from the same gallery.

  A project opens in place, without reloading the page; Back and Forward go between the projects you opened.

  The starters and examples live in [runbun-examples](https://github.com/oddcelot/runbun-examples): add yours with a pull request.

  </details>
- **Project config:** an optional [`runbun.json`](/guides/project-config/) says what Run starts, sets environment variables, picks the open tabs, panels, their sizes and preview requests, and keeps files from edits.
- **One tab per project:** a second tab with the same project can't save its changes.

## Embedding

Any project can be put in another page, as a `<bun-playground>` element or an iframe. See [Embedding](/guides/embedding/) and the [embed reference](/reference/embed-api/).

### Links

| URL | Opens |
|---|---|
| `runbun.dev` | A short intro with a live example, on a first visit; **Open the playground** starts the playground in the same page. After that, `runbun.dev` opens the demo project directly |
| `/about` | The intro, always (also linked as **About** in the status bar) |
| `?example=<name>` | A bundled example, e.g. `?example=elysia-demo` |
| `?repo=owner/repo` | A GitHub repo's files. Also `owner/repo@ref`, a github.com URL, or `…/tree/<ref>/<dir>` |
| `?git=<url>` | A clone of a repository (`owner/repo` or an https URL on GitHub, GitLab, Codeberg or Bitbucket), with its last 50 commits |
| `#code=…` | A shared project |
| `/s/<id>` | A short share link |

Your saved changes win over the link's source; use `reset` to start over from it.

A project that comes from a link (`#code=…`, `/s/<id>`, `?repo=` or `?git=`) opens in the editor but doesn't run until you press Run, so you can read it first. Your own saved projects and the bundled examples run as soon as they open.
`?vars=` sets the overlay drawn over the whole page, for this visit only: Share links drop it and the next visit doesn't remember it.

<details>
<summary>What <code>?vars=</code> takes: the JSON shape, allowed values and embeds</summary>

It takes a JSON object with `base` (both schemes) and optionally `light` or `dark`, each with `--overlay` (a wash) and `--overlay-ring` (a 1px border), e.g. `?vars={"base":{"--overlay-ring":"linear-gradient(135deg,%23f9d6e3,%23a8cdf0)"}}`.

- Other names are ignored, and a value may only use colors, `none`, and the functions `linear-gradient`, `radial-gradient`, `conic-gradient` (and their `repeating-` forms), `rgb`, `rgba`, `hsl`, `hsla`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, `color`, `color-mix`, `light-dark` and `calc`; no images or `var()`.
- `none` or `""` turns off the theme's own overlay (the Elysia family has one).
- An embed doesn't draw this overlay; style `bun-playground::part(overlay)` on the host page instead (see the [embed reference](/reference/embed-api/#theming)).

</details>
