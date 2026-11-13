# Changelog

Notable changes per release of runbun: the playground at runbun.dev, the Bun runtime and toolchain it runs in the
browser, its editor, and the docs at docs.runbun.dev. They release together at one version (`version` in the root
`package.json`, tagged `v<version>`), organised by part. `@runbun/astro` keeps its own changelog in
[packages/astro/CHANGELOG.md](./packages/astro/CHANGELOG.md).

## 0.3.0 — 2026-11-13

Git arrives in the playground: a Git panel and `git` in the console, cloning with history from GitHub, GitLab, Codeberg
and Bitbucket, and push once you sign in with GitHub. The console becomes Bun's shell, programs can start child
processes and use `Bun.$`, `bun install` writes `bun.lock`, and `bun check` type-checks a project. runbun.dev now opens
on a landing page, a pixel-art kitchen by day and by night, and the docs wear the same look. Project code runs on its own
origin, and a project opened from a link waits for Run; nothing needs action.

### Playground

- **Added** — **A Git panel.** The file explorer switches to a Git view (Mod+Shift+G) to stage, commit, amend or undo,
  switch and create branches, read the history, and pull or push; the file tree marks changed files and the Changes tab
  compares with the last commit. Git runs in a background worker, so a large repository doesn't hold up typing.
- **Added** — **`git` in the console.** `init`, `add`, `commit`, `status`, `diff`, `log`, `show`, `branch`, `switch`,
  `restore`, `reset --hard`, `config` and `remote` work on the project's files, renamed files are paired as in git, and
  the repository is kept across reloads.
- **Added** — **Clone a repository with its history.** In the project gallery, Repository… opens a repo's files as
  before or, with "With Git history", clones it from GitHub, GitLab, Codeberg or Bitbucket, so you can commit, branch,
  fetch and pull; `git clone`, `fetch` and `pull` do the same in the console, and links work too: `?git=owner/repo`.
  The status bar shows how much has arrived.
- **Added** — **Sign in with GitHub to clone private repositories and push.** Clone a repository lists your repositories
  once you sign in, private ones clone and fetch, and `git push` (`-u`, `-f`, `--delete`, `<src>:<dst>`) or ↑ in the
  Git view pushes. You choose which repositories runbun.dev may use; the token stays in an encrypted cookie in your
  browser, for 7 days after your last visit or until you sign out.
- **Added** — **The console is Bun's shell.** Pipes, `&&`, redirects, variables, `$(…)`, globs and `cd` work, with Bun's
  builtins (`ls`, `cat`, `mkdir`, `rm`, `mv`, `cp`, `echo`…) over the project's files. Before, a line was split at
  spaces and only a few commands were known.
- **Added** — **runbun.dev opens on a landing page.** A first visit shows a pixel-art kitchen with what runs, a live
  example and how to embed one; "Open the playground" starts it in the same page, and later visits and project links go
  straight to the playground. About, in the status bar, opens it again (runbun.dev/about), and `?open` on a link skips
  it.
- **Added** — **The landing page by night, and with sound.** With your system in dark mode it is the same kitchen by
  moonlight; the moon in the header (or the light switch on the wall) switches, and your choice is remembered. Buttons,
  links and switches make arcade sounds, which the speaker in the header turns off.
- **Added** — **A project gallery, with starter templates.** Starters (Blank, HTTP API, React, SQLite, WebSocket chat),
  examples and GitHub projects sit in sections with their technologies tagged, in place of the project dropdown; search
  by name or technology, or filter by tag.
- **Added** — **runbun.json: say how a project opens.** An optional file beside package.json sets what Run starts,
  environment variables, the open tabs and panels, and requests to try in the preview.
- **Added** — **Scripts that call a package's CLI run.** A project with `"dev": "vite"` and no entry file starts Vite's
  CLI on Run, `vite.config.ts` included, where it failed with "module not found: index.ts"; `bun run <script>` runs such
  scripts too.
- **Added** — **Rename and delete files and folders from the file tree.** Right-click a row (or use its ⋯ button), or
  press F2 to rename and Delete to delete; open tabs follow a rename. For ten seconds after, Undo under the tree (or
  Ctrl/Cmd+Z in it) brings a deleted file or folder back, tabs included, or moves a renamed one back.
- **Added** — **The status bar shows the port, the dependencies and whether your edits are saved.** `:3000` appears
  while a server runs, and a click shows the preview when it's hidden; the dependency count offers an install when some
  are missing and warns when bun.lock no longer matches package.json; Saving…, Saved or Not saved says where your edits
  are kept, or why they aren't.
- **Added** — **Format on save.** Turn on the wand in the status bar and Ctrl/Cmd+S formats the file with `bun fmt`
  before saving it.
- **Added** — **Find Local Bun from the header.** The **Local Bun** button is always there and, without a runner, shows
  how to run projects with the Bun on your machine; paste the runner's link to connect the open page.
- **Added** — **Embeds without room for the file tree open it as a drawer.** A Files button in the bar reaches every
  file in stacked and narrow embeds, and stacked embeds 782px and wider show the tree beside the editor.
- **Changed** — **Project code runs on its own origin.** Code you run can no longer read your other saved projects,
  folder access or the Local Bun token, and a preview's cookies and storage stay out of the editor's. Embeds on other
  sites keep package files in memory, and "open preview in a new tab" from an embed opens the playground instead.
- **Changed** — **Switching projects no longer reloads the page.** The header, console and preview stay put while the
  files swap, and Back and Forward move between the projects you opened.
- **Changed** — **Undo history survives switching tabs and renaming a file.** Going to another file and back, or
  renaming one, used to start its undo history afresh.
- **Changed** — **Large files open and scroll faster.** The editor renders only the lines in view; a 5000-line file
  opens about three times faster.
- **Changed** — **Hono and the Lit SSR guestbook open instantly.** They are bundled examples now, not GitHub repos
  fetched on each pick, so they work offline and don't run into GitHub's hourly limit.
- **Changed** — **An embed with `features="-tabs"` has no preview tab bar either.** A preview with one tab shows its
  request bar and response only, which leaves a short embed more room for the code. Embeds with several preview tabs
  keep the bar.
- **Changed** — **Plainer wording across the playground.** Tooltips, dialogs and console messages say what a control
  does or what happened, without the explanations bolted on.
- **Fixed** — **Projects from a link no longer run until you press Run.** Opening a share link or ?repo= link used to
  run the code at once; now you can read it first.
- **Fixed** — **A ?connect= link can no longer send your project to another server.** The playground now connects only
  to a Local Bun runner on your own machine and ignores any other host.
- **Fixed** — **Other websites can no longer reach your running preview server.** A link or form on another site that
  pointed at /__preview/ used to be answered by the app running in your playground tab.
- **Fixed** — **Opening runbun.dev with a local runner link no longer waits on Chrome's prompt.** The project opens and
  runs in the browser while Chrome asks for local network access, and moves to Local Bun once it's allowed.
- **Fixed** — **A preview opened in its own tab says why it's empty.** Opening the preview from an embedded playground,
  or after closing the playground, showed the browser's bare not-found page; it now explains that the preview runs in
  its playground tab, with a link back.
- **Fixed** — **The cursor position follows your clicks.** After clicking into a file, the status bar's Ln/Col and F12
  (go to definition) used the previous click's position, or none right after opening the file.
- **Fixed** — **Long commands stay on one prompt in the console.** Typing past the console's width repeated the line on
  every keystroke.

### Runtime

- **Added** — **Programs can start child processes.** `Bun.spawn`, `child_process.spawn`/`exec`/`execFile` and `Bun.$`
  run `bun`, `node`, `package.json` scripts and installed bins, with piped stdio, stdin, exit codes and `kill`; and
  `bun run` in the console runs scripts like `tsc && vite build`.
- **Added** — **`Bun.$` runs.** Bun's own shell parser and its builtins over the project's files: pipes, redirects (also
  into buffers), `.text()`, `.json()`, `.quiet()`, `.nothrow()`, `ShellError`, `$.escape` and `$.braces`. Commands other
  than the builtins, `bun`, `node` and installed bins aren't found.
- **Changed** — **Saving under Watch keeps the preview up.** The running server keeps answering until the edited program
  is up, and an edit that crashes on start leaves the previous version running instead of nothing.
- **Fixed** — **Programs end when they run out of work.** A script that finished kept running with no exit code; now
  `beforeExit` and `exit` fire and the status shows the code, while timers, servers and pending requests keep a program
  going unless `unref`'d.
- **Fixed** — **`bun test` fails a test on an uncaught error.** An error thrown from a timer or an unhandled rejection
  was printed and the test passed; now the test running at the time fails, as in Bun.
- **Fixed** — **`new Request()` keeps Cookie, Host, Origin, Referer and Content-Length, as in Bun.**
  `app.handle(new Request(url, { headers: { cookie } }))` sees its cookies instead of losing them.
- **Fixed** — **Imports of `file:` URLs load.** `import "file:///node_modules/…"` failed with "cannot resolve", so a Vite
  CLI couldn't load its `vite.config.ts`.
- **Fixed** — **`exit` listeners see Bun's code after an unhandled rejection.** They got 1 where Bun passes
  `process.exitCode` (0 when unset); the program still ends with code 1.

### Toolchain

- **Added** — **`bun install` writes `bun.lock`.** A project without one gets the lockfile native Bun would write,
  conflicting versions are nested instead of dropped, and editing `package.json`, `bun add` or `bun remove` updates it.
  Tarball URLs, `file:` folders and `npm:` aliases install too.
- **Added** — **`bun check` in the console.** Bun's own type checker (TypeScript 7) checks the project with its
  `tsconfig.json` and installed types, and prints the errors and summary `bun check` prints, colors and source lines
  included. `bun --check <file>`, also in `package.json` scripts, type-checks first and only starts the program when
  there are no errors.
- **Changed** — **The playground loads faster.** The transpiler it downloads first is a third smaller (537 KB instead of
  867 KB compressed).
- **Fixed** — **Packages whose files are named after keywords load.** TypeBox 1.x no longer fails to load, so Elysia 2
  routes with schemas answer instead of returning 500, and imports of same-named files from different folders no longer
  overwrite each other.
- **Fixed** — **Packages like oxc-parser load their wasm binding.** A package that lists its native bindings but not its
  `-wasm32-wasi` one now gets that installed too, where it failed to load with "Cannot find module".
- **Fixed** — **Vite projects run on the rolldown they install.** A fresh install got rolldown 1.2.19 while the
  playground supplied 1.2.16 and warned about the mismatch.
- **Fixed** — **`bun remove` removes the package's dependencies too.** Packages that `bun.lock` no longer lists stayed
  in `node_modules` after an install.
- **Fixed** — **`bun fmt` formats `Cargo.toml.orig`, `Pipfile` and `*.toml.example`.** The playground skipped them as
  files it can't format.

### Editor

- **Added** — **Hints for JSON files.** runbun.json, and any JSON file that names its `$schema`, gets completions, field
  descriptions on hover and errors as you type; a `$schema` path like `./config.schema.json` or
  `../node_modules/tool/schema.json` is read from the project's files.
- **Changed** — **The editor's TypeScript service is on tsrs 0.24.** Diagnostics, hovers and completions come from the
  newer release (still TypeScript 7.1 beta).

### Docs

- **Added** — **Runnable Bun examples.** docs.runbun.dev/examples/ has Bun.serve, routes, WebSockets, bun:sqlite,
  Bun.file, Bun.password, Bun.$, Elysia and Hono examples that run on the page when you press Run.
- **Added** — **Comparison pages.** docs.runbun.dev/compare/ weighs runbun.dev against StackBlitz WebContainers, online
  Bun compilers and installing Bun locally, and says when each is the better pick.
- **Added** — **A guide to running projects with Bun on your own machine.** Run with local Bun covers
  `bunx @runbun/connect`, the browsers it works in and what the sandbox does and doesn't stop.
- **Changed** — **The docs match the landing page's kitchen.** One palette, by day and by night; the moon or sun in the
  header switches between them, and the theme family picker is gone. Open playground is a plain link, without the zoom
  into a monitor.
- **Changed** — **One table of what runs in the browser.** The compatibility overview sums up Bun.serve, bun install,
  bun:sqlite, node:* and the toolchain at a glance, with the Bun release and the date it was last checked.
- **Fixed** — **The browser page says Safari Technology Preview runs code.** It was listed as edit-only, though it has
  Memory64 and runs the playground.
- **Fixed** — **Runnable examples are as tall as their code.** A short preview or console example no longer has empty
  space under it before you run it.

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
