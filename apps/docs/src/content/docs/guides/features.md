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
- **Auto-save** (on by default): edits are saved a moment after you stop typing. Switch it off with the save icon next to Run (in an embed, the tab bar's Auto-save switch) to save with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> instead; unsaved tabs show a dot, and Run, Install, `bun test` and Share save everything first. The setting applies to every project and every open playground tab.
- **Format** (top right of the code while the pointer is over it, or <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>) formats the open file with `bun fmt`, as one undoable edit (see [Toolchain](/compatibility/toolchain/#formatter-bun-fmt))
- Type errors in TypeScript files, a name's type and documentation when the pointer rests on it, and **completions** as you type, from TypeScript 7's checker (see [Toolchain](/compatibility/toolchain/#type-checking)). The list opens after `.`, in import paths, and at the first letter of a name; <kbd>↑</kbd>/<kbd>↓</kbd> pick, <kbd>Enter</kbd> or <kbd>Tab</kbd> insert, <kbd>Esc</kbd> closes it. The selected entry's type and docs show under the list. Names exported by the project's other files, installed packages and Bun's and Node's built-in modules (`bun:sqlite`, `node:fs`) are offered too, with the module they come from, and inserting one adds its import. <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+click a name (or press <kbd>F12</kbd>) to **go to its definition**, in another file too, or in TypeScript's and Bun's own types (`lib.es5.d.ts`, `bun-types`), which open read-only in a tab with a lock. Typing `(` or `,` in a call shows its **parameter hints** above the line, with the current parameter underlined; <kbd>↑</kbd>/<kbd>↓</kbd> step through overloads and <kbd>Esc</kbd> hides them.
- **Changes:** the compare button in the status bar shows how many files differ from the project's source (the demo, the example, the shared link, the GitHub repo, or the folder or zip as opened), and opens a **Changes** tab with a diff of each one: modified, added and deleted files, updated as you save. **Open** in a file's header edits it. After a reload the comparison still goes back to the source, not to the restored copy; for a GitHub repo the files are fetched again when the tab first opens. `node_modules` and `.git` aren't compared, and binary files are listed without a diff.
- Resizable panes
- **Run status** as a pill in the status bar (default) or a toast over the panes that fades a few seconds after the program settles; errors stay until the next change. Pick one under **Appearance**.
- **Status bar** along the bottom: buttons to show or hide the file tree, the preview and the console (with both of those hidden, the editor takes their room), what the program is doing, and for the open file its error and warning counts (click to go to the next one), the cursor's line and column, and its language (for TypeScript, with the version the type checker follows). The Bun version links to [Bun compatibility](/compatibility/bun/). **Feedback** opens a form that sends a message to us, optionally with an email address to answer, the Bun release and browser, and the open project as a short link (see [Privacy](/privacy/#feedback)).
- **Open folder** or **Open zip file** loads a project from your computer (skips `node_modules` and `.git`). A zip whose files all sit in one folder, like GitHub's downloads, opens that folder. In Chrome, edits to an opened folder are saved back to it, and changes made to it in another editor show up in the playground.
- In Chrome and Edge, an opened folder stays linked: edits, new files and deletions are saved to it on disk. `node_modules` stays in the browser and the folder's own `node_modules` and `.git` aren't touched. A reload opens it again if the browser still allows access; otherwise pick **Reopen <folder>** in the project picker, which asks once more. Other browsers open a copy.

Not yet: renaming or deleting files from the tree. Very large files are slow, because every line is rendered.

### Keyboard shortcuts

| Shortcut | Does |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> | Run |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> | Send the preview's request, from anywhere |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>.</kbd> | Stop the server |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> | Save the file |
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> | Format the file with `bun fmt` (`format`) |
| <kbd>F12</kbd> | Go to the definition of the name at the cursor (`goToDefinition`) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>I</kbd> | Show the type and docs of the name at the cursor (`showHover`); any key closes it |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd> | Show completions at the cursor (`suggest`; <kbd>Ctrl</kbd> on macOS too) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> | Show the parameters of the call at the cursor (`signatureHelp`) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>W</kbd>, <kbd>Delete</kbd> | Close the focused tab |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>B</kbd> | Show or hide the file tree |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>J</kbd> | Show or hide the console |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> | Show or hide the preview |
| <kbd>Esc</kbd> | Leave the expanded preview |

They work in the preview page too, and in an embed, where showing or hiding a pane works only for the panes its author didn't turn off (`features="-console"`). To change them, open the keyboard button in the header, click the pencil next to a command and press the new keys (<kbd>Esc</kbd> cancels, **Remove** unbinds it). Changed commands are marked **custom** with a button to reset them, a key bound to two commands is flagged on both, and **Save** keeps the changes. Keys the browser keeps for itself (<kbd>Cmd</kbd>+<kbd>W</kbd>, <kbd>Ctrl</kbd>+<kbd>T</kbd>) can't be recorded. Under **Edit as JSON** the same overrides can be written by hand: a command name to a chord, a list of chords, or `null` to turn it off, e.g. `{ "run": ["Mod+Enter", "Alt+R"], "togglePreview": null }`. `Mod` is <kbd>Cmd</kbd> on macOS and <kbd>Ctrl</kbd> elsewhere; the other modifiers are `Ctrl`, `Alt`, `Shift` and `Meta`, and the space bar is `Space`. Overrides are kept in this browser for every project, and open playground tabs pick up changes right away.

## Console

A terminal with colors, clickable links, history (<kbd>↑</kbd>/<kbd>↓</kbd>) and line editing (<kbd>Ctrl</kbd>+<kbd>A</kbd>/<kbd>E</kbd>/<kbd>U</kbd>). <kbd>Ctrl</kbd>+<kbd>C</kbd> on an empty line stops the server; <kbd>Ctrl</kbd>+<kbd>L</kbd> clears.

| Command | Does |
|---|---|
| `bun run <script\|file>`, `bun <file>` | Run a `package.json` script or a file |
| `bun test [filter…]` | Run `*.test.*` / `*.spec.*` files with [`bun:test`](/compatibility/bun/#buntest) |
| `bun install` (`i`) | Install dependencies |
| `bun add <pkg[@range]> [-d]` (`a`) | Add a dependency |
| `bun remove <pkg>` (`rm`) | Remove a dependency |
| `bun pm cache [rm]` | Show or clear the package cache |
| `bun fmt [-c] [path…]` | Format files like Prettier, or only check them (`-c`) |
| `bun check [path…]` | Type check with Bun's own checker, as [`bun check`](/compatibility/toolchain/#bun-check) does |
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
- **Watch** (on by default; the refresh icon next to Run, beside Auto-save): saving an edit restarts the running program and clears the console, like `bun --watch`. A crash doesn't end it: the status says so and the next save runs the program again. A save that leaves an open file with a syntax error (half-typed, as auto-save saves it) keeps the program running as it was until a save parses. Stop, or a program that exits by itself, ends it until the next Run. While the server restarts, the preview's requests wait for it.
- With Watch off, edits still reach the running code: the next import or request sees them, and `fs.watch` fires. A script's `--watch` and `--hot` flags are ignored either way.
- A file location in the console (`index.ts:3:7` in an error or a stack trace) is a link: click it to open the file there.
- A script runs when it is `bun <file>` or calls one installed package's bin: with no entry file, Run starts the `dev` (else `start`) script, so `"dev": "vite"` runs Vite's CLI with its arguments. Scripts that chain commands (`tsc && …`), pipe, set variables or use `npx` can't run; start those tools from a file instead (see [Frameworks](/compatibility/frameworks/)).

## Preview

When your code starts a server (`Bun.serve`, `node:http`, or `export default { fetch }`), the preview shows it.

- **Request bar:** send any method, path and body. The request panel under it (its toggle sits next to Send) has Params, Headers, Auth and Body, and a Raw switch. Params lists the path's query as rows and writes your edits back into the path. Params and headers are rows you can turn off one by one; a param turned off leaves the path and keeps its place until you turn it on again. Every header reaches the server, including ones a page's `fetch` can't set, such as `Cookie`, `Origin` and `Referer`. A `Cookie` is joined with the cookies the app has set, and yours wins when a name is in both. An HTML page you send headers to gets them on its first load, but not its scripts, fetches or links. Auth sends a Bearer token, Basic credentials or an API key, the key as a header or a query parameter. What it adds shows as a read-only row under Headers or Params, and a header row with the same name wins over it. A body is sent as JSON or text, written in the same editor as files (Format, or <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> in the body, indents a JSON body), or as a form, from rows. A GET or HEAD request has no body; Body says so and offers to switch to POST. A form is URL-encoded, or multipart, where a row can send a file from the project. Raw shows the whole request as `.http` text in place of the section: the request line, a header per line (`#` turns one off), a blank line and the body. Edit it there and the other sections follow. The copy menu copies the request as a curl command or a `fetch` call for `http://localhost:3000`, where the app runs when you start it locally with `bun`. A response from before the request last changed is dimmed, with a note to send it again. Each preview tab keeps its own params, headers, auth and body. HTML responses open in the page; anything else shows status, headers and the body: JSON formatted, and JSON, HTML, CSS, JavaScript, XML and Markdown highlighted. A link or redirect in a page that leads to JSON or plain text shows it the same way, with its status but not its headers (the request isn't sent again; press Send for them).
- **Tabs:** several previews at once. <kbd>Cmd</kbd>-click (<kbd>Ctrl</kbd>-click off macOS) or middle-click a link in a page to open it in a new preview tab in the background; add <kbd>Shift</kbd> to switch to it.
- **Open in a new tab:** the page gets its own browser tab, still served by the playground (keep the playground tab open).
- **Requests stay inside:** `fetch("/api/x")`, links, forms and redirects from the preview page reach your server.
- **WebSockets:** the preview page's `WebSocket` connects to your server (`Bun.serve` `upgrade`, `node:http` `upgrade`, the `ws` package). `localhost:<port>` URLs pick the server on that port.
- **Streaming:** streamed responses and Server-Sent Events arrive as they're sent.
- **Cookies:** kept in the browser across restarts, where the preview's scripts read and set them with `document.cookie` and DevTools lists them (HttpOnly ones stay hidden from scripts and DevTools); see them with `cookies`.
- **HTML imports:** `import page from "./index.html"` in `Bun.serve` routes is bundled with Bun's bundler.
- The preview follows the playground's light/dark mode.

Limits: the server isn't reachable from outside the browser, there's no HTTP caching (conditional requests are dropped), and only the preview page can open WebSockets to it.

## Installing packages

Dependencies install automatically when a project opens with missing packages. `bun install` uses `bun.lock` when there is one. Details and limits are in [Toolchain](/compatibility/toolchain/#bun-install).

## Projects

- **Saved as you type**, in your browser. See [Storage and persistence](/guides/storage/).
- **Share:** the Share menu copies a link with the whole project in the URL (nothing is uploaded), a Markdown badge, or HTML. `node_modules`, `.git`, binary files and secrets (`.env`, keys, `.npmrc`) are left out. Very long links can be shortened to `runbun.dev/s/<id>`, which stores a copy on runbun.dev (see [Privacy](/privacy/)). **Download as zip** saves every file except `node_modules` and `.git`, binaries included.
- **GitHub:** open any public repo, branch or subfolder from the project picker or with `?repo=`. Up to 500 files; GitHub allows 60 imports an hour per IP.
- **Examples:** Elysia, Hono, Astro + Solid, Vite, Lit SSR and more in the project picker. Hovering an example (or moving to it with the arrow keys) shows its files in the file tree and its entry file in the editor; nothing loads or runs until you pick it.
- **One tab per project:** a second tab with the same project can't save its changes.

## Embedding

Any project can be put in another page, as a `<bun-playground>` element or an iframe. See [Embedding](/guides/embedding/) and the [embed reference](/reference/embed-api/).

### Links

| URL | Opens |
|---|---|
| `runbun.dev` | A short intro with a live example, on a first visit; **Open the playground** starts the playground in the same page. After that, `runbun.dev` opens the demo project directly; `?landing` shows the intro again |
| `?example=<name>` | A bundled example, e.g. `?example=elysia-demo` |
| `?repo=owner/repo` | A GitHub repo. Also `owner/repo@ref`, a github.com URL, or `…/tree/<ref>/<dir>` |
| `#code=…` | A shared project |
| `/s/<id>` | A short share link |

Your saved changes win over the link's source; use `reset` to start over from it.

`?vars=` sets the overlay drawn over the whole page, for this visit only: Share links drop it and the next visit doesn't remember it. It takes a JSON object with `base` (both schemes) and optionally `light` or `dark`, each with `--overlay` (a wash) and `--overlay-ring` (a 1px border), e.g. `?vars={"base":{"--overlay-ring":"linear-gradient(135deg,%23f9d6e3,%23a8cdf0)"}}`. Other names are ignored, and a value may only use colors, `none`, and the functions `linear-gradient`, `radial-gradient`, `conic-gradient` (and their `repeating-` forms), `rgb`, `rgba`, `hsl`, `hsla`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, `color`, `color-mix`, `light-dark` and `calc`; no images or `var()`. `none` or `""` turns off the theme's own overlay (the Elysia family has one). An embed doesn't draw this overlay; style `bun-playground::part(overlay)` on the host page instead (see the [embed reference](/reference/embed-api/#theming)).
