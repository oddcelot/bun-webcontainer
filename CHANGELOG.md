# Changelog

Notable changes per release of runbun: the playground at runbun.dev, the Bun runtime and toolchain it runs in the
browser, its editor, and the docs at docs.runbun.dev. They release together at one version (`version` in the root
`package.json`, tagged `v<version>`), organised by part. `@runbun/astro` keeps its own changelog in
[packages/astro/CHANGELOG.md](./packages/astro/CHANGELOG.md).

## 0.2.0 — 2026-11-05

The preview becomes a request client: send query params, headers, forms, files and credentials, edit a request as text
and copy it as curl or fetch, and give an embed preset requests to try. The playground opens offline, shares one package
cache across projects and runs big installs in much less memory, and a Storage dialog shows and clears what it keeps.
The editor goes to definition into TypeScript's and Bun's own types, and the docs gain guides for agents and Astro
examples. Nothing needs action.

### Playground

- **Added** — **Preset requests in an embed's preview.** The `requests` option (`GET /; POST /form {"hello":"Elysia"}`)
  opens a preview tab per request: the first is sent when the server starts, each other one the first time its tab is
  opened.
- **Added** — **Send query params and headers from the preview.** A panel under the request bar edits the path's query
  as rows and adds headers, Cookie and Origin included, each one you can turn off without deleting it.
- **Added** — **Send forms, files and credentials from the preview.** A request body can be JSON, text, a URL-encoded
  form or a multipart form with files from the project, and Auth adds a Bearer token, Basic credentials or an API key.
- **Added** — **Edit a request as text, and copy it as curl or fetch.** Raw shows the whole request as `.http` text you
  can edit, the copy menu gives a curl command or a fetch call for the app run locally, and the embed's `requests` take
  headers (`GET /me -H "Authorization: Bearer x"`).
- **Added** — **Format a request's JSON body.** Format in the Body section, or Shift+Alt+F in the body, indents it, as
  one undoable edit.
- **Added** — **Send a request from anywhere with Cmd/Ctrl+Shift+Enter.** Cmd/Ctrl+Enter keeps running the program
  everywhere and no longer inserts an empty line in the editor. The Send button is now an icon, its tooltip showing the
  keys.
- **Added** — **See what's in an example before opening it.** Hovering an example in the project picker, bundled or from
  GitHub, shows its entry file over the editor and its files in the file tree, without loading or running it; the
  project's tree comes back when the menu closes.
- **Added** — **See what you changed.** The compare button in the status bar shows how many files differ from the
  project's source and opens a Changes tab with a diff of each, kept up to date as you save, across reloads.
- **Added** — **The playground opens offline and starts without downloading again.** After one visit, its files (the
  wasm too) come from the browser, and a new version downloads only the files that changed.
- **Added** — **See and clear what the playground stores.** The new Storage dialog shows how much space saved projects
  and caches take, deletes single projects, clears the caches, or clears it all.
- **Added** — **Edits from another editor show up in an opened folder.** In Chrome, a folder opened from disk now picks
  up files you change, add, rename or delete outside the playground, without reopening it.
- **Added** — **runbun.dev/llms.txt.** Coding agents can read how to build a runbun.dev link from a project's files, so
  they can write reproductions you can post as a single link.
- **Changed** — **A clearer request panel.** Its tabs stay in place for every method, Raw is a switch, a body's type is
  picked above it, and a response from before your last change is marked as out of date. In narrow embeds the tabs and
  the path no longer get cut off.
- **Changed** — **The request body is a resizable panel.** It has a Body tab that says whether it is sent as JSON or
  text, and a handle under it to move room between the body and the response (arrow keys too; double-click to fit it
  again). The body is as tall as its lines, up to 7em, and the response always keeps room for a short reply, so a JSON
  answer no longer moves the embed.
- **Changed** — **More room for tabs.** Auto-save and Watch are now icon toggles next to Run, and Format appears in the
  editor's top right corner when you hover the code, so the tab bar fits more open files before it scrolls.
- **Changed** — **The playground loads less on startup.** The 49 other color themes load when you first point at the
  Appearance button, not on every visit; previews in the list still show at once.
- **Changed** — **The header logo is a dumpling with 64 faces.** Hovering the title rolls through them; it keeps the
  face it stopped on.
- **Fixed** — **Keyboard shortcuts work in embeds.** Cmd/Ctrl+Enter runs, Cmd/Ctrl+. stops, and the console, preview and
  file tree can be shown or hidden from the keyboard (those the author left on); before, Cmd/Ctrl+Enter in an embed's
  editor added an empty line.
- **Fixed** — **Stacked previews show the whole response.** In `layout="stack" height="auto"` embeds, the preview grows
  to fit a response and its request body (up to the 640px cap) instead of clipping it at 200px, and in a narrow column
  it keeps the height it fits instead of half the embed.
- **Fixed** — **Tooltips no longer block clicks.** They close as soon as the pointer leaves the control; moving from
  Send down to the request panel's tabs could leave a tooltip on top, so the click did nothing.
- **Fixed** — **Menus close after you pick an item.** The Run menu's bun install and the embed's menu stayed open,
  covering the page, until you clicked elsewhere.
- **Fixed** — **Auth's pickers line up with the rest of the request panel.** They were shorter than the fields and
  buttons next to them, and Auth's fields didn't start where the other rows' values do.
- **Fixed** — **Expand preview no longer claims Esc.** Its tooltip showed Esc even though the key only restores an
  expanded preview; it now shows on Restore alone, as whatever key it's bound to.

### Runtime

- **Changed** — **Big projects run in a third less memory.** Installed packages are shared between the page and the
  program instead of copied into it, in Chrome and Firefox.
- **Changed** — **Vite and Astro projects use less memory.** Rolldown no longer gets a full copy of node_modules; it
  reads the files it opens.
- **Changed** — **Caches no longer put saved projects at risk in Firefox and Safari.** The playground now trims its own
  caches when site storage grows large, so the browser has less reason to clear the whole site, projects included.
- **Changed** — **Bun.build fails clearly when given plugins, and HTML imports debug with your own source.**
  `Bun.build({ plugins })` throws instead of building without them. Scripts of a page served from an HTML import carry
  inline source maps, so DevTools shows the original files.
- **Fixed** — **A preview page's scripts share cookies with its server.** Cookies the server sets show in
  `document.cookie` (HttpOnly ones stay hidden) and in DevTools, and cookies a page's script sets reach the server on
  the next request.
- **Fixed** — **Moving a folder into one of its own subfolders keeps its files for the running program.** After renaming
  `a` to `a/b`, running or importing `a/b/x.ts` failed because the files were gone from the program's view.

### Toolchain

- **Added** — **Packages you installed before install without downloading again.** Every project and every reload shares
  one package cache, so a second project with the same dependencies installs in a fraction of the time and works
  offline. `bun pm cache` shows it, `bun pm cache rm` clears it.
- **Changed** — **Big installs take far less memory.** Installed packages are kept as bytes, and their large files stay
  in browser storage until a program reads them (Chrome and Firefox), so a big dependency tree (Next.js, MUI) no longer
  costs up to twice its size in the page and again in the program's worker.

### Editor

- **Added** — **Go to definition reaches TypeScript's and Bun's built-in types.** F12 or Ctrl/Cmd+click on `Math`,
  `Response` or `Bun.serve` opens the declaration in `lib.es5.d.ts` or Bun's types, read-only, instead of doing nothing.

### Docs

- **Added** — **Reproduce a bug with an agent.** A new guide shows how to have a coding agent write a minimal
  reproduction as a runbun.dev link, check it in a browser and hand it back to post in an issue.
- **Added** — **The docs as plain text for agents.** docs.runbun.dev/llms.txt, llms-full.txt and llms-small.txt give
  coding agents the whole docs without the page chrome.
- **Added** — **Astro examples.** A new guide page shows every kind of code block `@runbun/astro` renders, each beside
  the Markdown that makes it.

## 0.1.0 — 2026-11-04

The first tagged release of runbun. The playground learns `bun --watch`: saving restarts the running program, a crash or
a half-typed line no longer stops it, and the preview waits through a restart instead of erroring. Embeds get resizable
panes and an expanded view with the whole playground's layout, shortcuts show as proper key caps, and the docs lose
their dead GitHub links. Nothing needs action.

### Playground

- **Added** — **Restart on save, like `bun --watch`.** A Watch switch next to Auto-save (an embed's `watch` feature)
  restarts the running program when you save and clears the console. A crash no longer ends it: the status says the next
  save reruns the program. A save that leaves a syntax error, as auto-save does mid-word, keeps the program running
  until the code parses again.
- **Added** — **Open a file from the console.** A location in an error or a stack trace, such as `index.ts:3:7`, is a
  link to that line in the editor.
- **Added** — **Resize an embed's panes in both directions at once.** Dragging the corner where the editor, preview and
  console meet moves both borders, in an embed and in its expanded view.
- **Changed** — **Shortcuts show as key caps.** Tooltips and the shortcuts dialog draw one cap per key, with icons for
  ⌘, ⌥, ⇧ and the other macOS symbols; other systems keep Ctrl, Alt and Shift. Shortcuts spelled out as text, like the
  Auto-save tooltip's, show as caps too, and that one follows your own binding for Save.
- **Fixed** — **Auto-height embeds no longer scroll their code.** An embed with `height="auto"` is as tall as its code
  again, on every tab and down to the half pixel, where a stacked one, or Chrome on a Retina screen, showed a scrollbar.
- **Fixed** — **An expanded embed has the whole playground's layout.** A stacked embed opens in its modal side by side,
  file tree included, and closing the modal brings back the inline view with its tabs as they were.

### Runtime

- **Fixed** — **The preview no longer errors while the server restarts.** A request made during a restart answered "No
  server running"; it now waits for the new server.

### Docs

- **Fixed** — **No more dead GitHub links in the docs.** The GitHub icon and the "Edit page" links led to a page readers
  couldn't open.
