---
title: Features
description: "A tour of the playground: editor, console, running code, preview, installs and projects."
sidebar:
  order: 2
---

## Editor and files

- Syntax-highlighted editor with themes and light/dark mode
- File tree with search and a "New file" button
- Tabs for open files: close with the × button, <kbd>Delete</kbd>, or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>W</kbd>
- **Auto-save** (on by default): edits are saved a moment after you stop typing. Switch it off in the tab bar to save with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> instead; unsaved tabs show a dot, and Run, Install, `bun test` and Share save everything first. The setting applies to every project and every open playground tab.
- **Format** in the tab bar (<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>) formats the open file with `bun fmt`, as one undoable edit (see [Toolchain](/compatibility/toolchain/#formatter-bun-fmt))
- Type errors in TypeScript files, a name's type and documentation when the pointer rests on it, and **completions** as you type, from TypeScript 7's checker (see [Toolchain](/compatibility/toolchain/#type-checking)). The list opens after `.`, in import paths, and at the first letter of a name; <kbd>↑</kbd>/<kbd>↓</kbd> pick, <kbd>Enter</kbd> or <kbd>Tab</kbd> insert, <kbd>Esc</kbd> closes it. The selected entry's type and docs show under the list. Names exported by the project's other files, installed packages and Bun's and Node's built-in modules (`bun:sqlite`, `node:fs`) are offered too, with the module they come from, and inserting one adds its import. Typing `(` or `,` in a call shows its **parameter hints** above the line, with the current parameter underlined; <kbd>↑</kbd>/<kbd>↓</kbd> step through overloads and <kbd>Esc</kbd> hides them.
- Resizable panes
- **Status bar** along the bottom: buttons to show or hide the preview and console, what the program is doing, and for the open file its error and warning counts (click to go to the next one), the cursor's line and column, and its language (for TypeScript, with the version the type checker follows), and the keyboard shortcuts. The Bun version links to [Bun compatibility](/compatibility/bun/).
- **Open folder** or **Open zip file** loads a project from your computer (skips `node_modules` and `.git`). A zip whose files all sit in one folder, like GitHub's downloads, opens that folder.
- In Chrome and Edge, an opened folder stays linked: edits, new files and deletions are saved to it on disk. `node_modules` stays in the browser and the folder's own `node_modules` and `.git` aren't touched. A reload opens it again if the browser still allows access; otherwise pick **Reopen <folder>** in the project picker, which asks once more. Other browsers open a copy.

Not yet: renaming or deleting files from the tree. Very large files are slow, because every line is rendered.

### Keyboard shortcuts

| Shortcut | Does |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> | Run |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>.</kbd> | Stop the server |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> | Save the file |
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> | Format the file with `bun fmt` (`format`) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>I</kbd> | Show the type and docs of the name at the cursor (`showHover`); any key closes it |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd> | Show completions at the cursor (`suggest`; <kbd>Ctrl</kbd> on macOS too) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> | Show the parameters of the call at the cursor (`signatureHelp`) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>W</kbd>, <kbd>Delete</kbd> | Close the focused tab |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>J</kbd> | Show or hide the console |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> | Show or hide the preview |
| <kbd>Esc</kbd> | Leave the expanded preview |

They work in the preview page too. To change them, open the keyboard button (in the header or the status bar) and write overrides as JSON: a command name to a chord, a list of chords, or `null` to turn it off, e.g. `{ "run": ["Mod+Enter", "Alt+R"], "togglePreview": null }`. `Mod` is <kbd>Cmd</kbd> on macOS and <kbd>Ctrl</kbd> elsewhere; the other modifiers are `Ctrl`, `Alt`, `Shift` and `Meta`, and the space bar is `Space`. Overrides are kept in this browser for every project, and open playground tabs pick up changes right away.

## Console

A terminal with colors, clickable links, history (<kbd>↑</kbd>/<kbd>↓</kbd>) and line editing (<kbd>Ctrl</kbd>+<kbd>A</kbd>/<kbd>E</kbd>/<kbd>U</kbd>). <kbd>Ctrl</kbd>+<kbd>C</kbd> on an empty line stops the server; <kbd>Ctrl</kbd>+<kbd>L</kbd> clears.

| Command | Does |
|---|---|
| `bun run <script\|file>`, `bun <file>` | Run a `package.json` script or a file |
| `bun test [filter…]` | Run `*.test.*` / `*.spec.*` files with [`bun:test`](/compatibility/bun/#buntest) |
| `bun install` (`i`) | Install dependencies |
| `bun add <pkg[@range]> [-d]` (`a`) | Add a dependency |
| `bun remove <pkg>` (`rm`) | Remove a dependency |
| `bun fmt [-c] [path…]` | Format files like Prettier, or only check them (`-c`) |
| `ls [dir]`, `cat <file>` | List a folder, print a file |
| `cookies [clear]` | List or clear the preview's cookies |
| `reset` | Throw away your changes and reload the project from its source |
| `clear`, `help` | |

The console is not a full shell: no quotes, pipes, `&&`, `bunx`, or file commands like `mkdir` and `mv`.

## Running code

**Run** starts your code in a Web Worker. It runs the first of:

1. `module` or `main` in `package.json`
2. the file in `scripts.dev` or `scripts.start` (`"dev": "bun --watch src/index.ts"` works)
3. `index.ts`, `index.tsx`, `index.js` or `src/index.ts`

- Press **Run** (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd>) again to restart. Stop with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>.</kbd>, or <kbd>Ctrl</kbd>+<kbd>C</kbd> in the console.
- Edits reach the running code: the next import or request sees them, and `fs.watch` fires. The server isn't restarted automatically: `--watch` and `--hot` are ignored.
- Scripts must have the form `bun <file>`. Scripts like `vite`, `astro dev` or `tsc && …` can't run; start those tools from a file instead (see [Frameworks](/compatibility/frameworks/)).

## Preview

When your code starts a server (`Bun.serve`, `node:http`, or `export default { fetch }`), the preview shows it.

- **Request bar:** send any method, path and body. HTML responses open in the page; anything else shows status, headers and the body (JSON is formatted).
- **Tabs:** several previews at once.
- **Open in a new tab:** the page gets its own browser tab, still served by the playground (keep the playground tab open).
- **Requests stay inside:** `fetch("/api/x")`, links, forms and redirects from the preview page reach your server.
- **WebSockets:** the preview page's `WebSocket` connects to your server (`Bun.serve` `upgrade`, `node:http` `upgrade`, the `ws` package). `localhost:<port>` URLs pick the server on that port.
- **Streaming:** streamed responses and Server-Sent Events arrive as they're sent.
- **Cookies:** kept across restarts; see them with `cookies`.
- **HTML imports:** `import page from "./index.html"` in `Bun.serve` routes is bundled with Bun's bundler.
- The preview follows the playground's light/dark mode.

Limits: the server isn't reachable from outside the browser, there's no HTTP caching (conditional requests are dropped), and only the preview page can open WebSockets to it.

## Installing packages

Dependencies install automatically when a project opens with missing packages. `bun install` uses `bun.lock` when there is one. Details and limits are in [Toolchain](/compatibility/toolchain/#bun-install).

## Projects

- **Saved as you type**, in your browser. See [Storage and persistence](/guides/storage/).
- **Share:** the Share menu copies a link with the whole project in the URL (nothing is uploaded), a Markdown badge, or HTML. `node_modules`, `.git`, binary files and secrets (`.env`, keys, `.npmrc`) are left out. Very long links can be shortened to `runbun.dev/s/<id>`. **Download as zip** saves every file except `node_modules` and `.git`, binaries included.
- **GitHub:** open any public repo, branch or subfolder from the project picker or with `?repo=`. Up to 500 files; GitHub allows 60 imports an hour per IP.
- **Examples:** Elysia, Hono, Astro + Solid, Vite, Lit SSR and more in the project picker.
- **One tab per project:** a second tab with the same project can't save its changes.

### Links

| URL | Opens |
|---|---|
| `runbun.dev` | The demo project |
| `?example=<name>` | A bundled example, e.g. `?example=elysia-demo` |
| `?repo=owner/repo` | A GitHub repo. Also `owner/repo@ref`, a github.com URL, or `…/tree/<ref>/<dir>` |
| `#code=…` | A shared project |
| `/s/<id>` | A short share link |

Your saved changes win over the link's source; use `reset` to start over from it.
