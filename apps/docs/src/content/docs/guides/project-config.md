---
title: Project config (runbun.json)
description: "An optional runbun.json beside package.json says how the Bun playground opens and runs a project: what Run starts, environment variables, open tabs, panels and preview requests."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Configure how a project opens in the Bun playground | Run Bun"
sidebar:
  order: 2.5
  badge:
    text: Draft
    variant: caution
---

A `runbun.json` beside `package.json` tells the playground how to open and run the project. It's optional, and so is every field in it: what's missing is guessed as before. Comments and trailing commas are allowed.

The playground's **Settings** (the gear in the header) edits it as a form in its **Project** sections: each change rewrites only that field, keeping your comments and layout, and a field set back to its default leaves the file. A project without the file gets one on the first change.

```jsonc
{
  "$schema": "https://runbun.dev/schema/runbun.json",

  // Its card in a gallery
  "name": "HTTP API",
  "description": "Routes, JSON bodies and a health check",
  "kind": "starter",
  "tags": ["Elysia"],

  // How it runs
  "run": { "entry": "src/server.ts", "args": ["--verbose"] },
  "autorun": true,
  "fastPath": false,
  "env": { "LOG_LEVEL": "debug" },

  // What the reader sees first
  "open": ["src/server.ts", "src/routes.ts"],
  "hidden": ["bun.lock"],
  "readonly": ["package.json", "vendor/"],
  "panels": { "files": true, "preview": true, "console": true },
  "layout": "side",
  "sizes": { "files": 20, "editor": 55, "preview": 70 },
  "preview": {
    "path": "/",
    "requests": ["GET /health", "POST /echo {\"hello\": \"world\"}"]
  },

  // What it needs
  "requires": []
}
```

The playground's editor completes the fields, shows what each does when you hover it, and marks mistakes as you type. With the `$schema` line, other editors that read JSON schemas (VS Code and most others) do the same.

| Field | What it does |
|---|---|
| `name`, `description`, `kind`, `tags` | The project's card in a gallery: [runbun-examples](https://github.com/oddcelot/runbun-examples)' folders, and a library built with [`@runbun/embed pack`](/guides/embedding/). `kind` is `starter` (listed first) or `example`; `tags` name what it's built on, and the first with a logo is the card's icon. They win over an `example.json` beside it, which is still read. |
| `run` | What Run starts: `entry` and its `args`. Without it, Run takes `package.json`'s `module` or `main`, the file its `dev` or `start` script runs, else `index.ts`. |
| `autorun` | `false` opens the project without running it (missing packages still install, for the editor's types). |
| `fastPath` | `false` keeps the project off the [fast path](/playground/fast-path/), even when the reader has turned Fast path on: its program always runs. For a project whose dev server must run, such as one with hot module replacement. |
| `env` | `process.env` values for the program, in runs, restarts on save and `bun test`. The file is shared with the project, so it's no place for secrets. With [Local Bun](/guides/local-bun/) too (with `@runbun/connect` 0.2.0 or newer), apart from the runner's own variables (`PATH`, `HOME`, `PORT` and the like) and the dynamic loader's (`LD_*`, `DYLD_*`). |
| `open` | The files opened as tabs, in order; the first is shown. Without it, the entry file. |
| `hidden` | Files kept out of the tabs. They stay in the project and the file tree. |
| `readonly` | Files the editor won't change, and folders for everything in them (`"vendor/"`). They open, highlighted, but take no typing and no Format, and the file tree doesn't rename or delete them; the program and `bun install` can still write them. An embed's own `readonly` makes every file read-only. |
| `panels` | `files` (the tree), `tabs` (an embed's tab bar), `preview` and `console`: `true` shows one, `false` hides it, and the others stay as they are. In the playground this doesn't change your saved layout: a project without `panels` brings it back. |
| `layout` | In an embed, `"stack"` puts the preview (or console) under the editor and `"side"` (the default) beside it, as the embed's [`layout`](/reference/embed-api/) does. The host page's `layout` wins. |
| `sizes` | Each pane's share of space when the project opens, in percent: `files` of the width for the tree, `editor` of what the tree leaves (beside the preview and console, or above them in a stacked embed), `preview` of the column it shares with the console. The reader can still drag the borders, and what they drag wins; in the playground it stays their saved layout, as with `panels`. |
| `preview` | `path`: what the preview requests first. `requests`: requests to try, each in its own preview tab, written `METHOD /path [-H "Name: value"] [body]` as in an embed's [`requests`](/reference/embed-api/). |
| `requires` | `cross-origin-isolation` (Vite and Rolldown need it) or `local-bun` (child processes, native addons): if the page lacks it, the console says so when the project opens. |

The [examples](https://github.com/oddcelot/runbun-examples) use it: the Blank starter hides the preview, the HTTP API starter comes with requests to try.

## What wins

- **Code from a link** (a share link, a GitHub repo) still opens without running, whatever `autorun` says, and stays in the browser.
- **In an embed** the host page's attributes win: `mode` or `features` set means the host picks the panels, and `file`, `path`, `requests`, `autorun` and `layout` set by the host win over the file's. Inline files decide the tabs.
- **The reader** can still open and close panels and tabs; the file only sets where the project starts.
