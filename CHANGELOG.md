# Changelog

Notable changes per release of runbun: the playground at runbun.dev, the Bun runtime and toolchain it runs in the
browser, its editor, and the docs at docs.runbun.dev. They release together at one version (`version` in the root
`package.json`, tagged `v<version>`), organised by part. `@runbun/astro` keeps its own changelog in
[packages/astro/CHANGELOG.md](./packages/astro/CHANGELOG.md).

## 0.9.0 — 2026-11-23

The playground's panels now tile the window: drag them where you want them, resize them, or pick an arrangement in
the new Settings. A command palette goes to any file and runs any command, the preview zooms, and Vue and Nuxt join
the gallery with their devtools in a tab of their own. Installed as an app, runbun behaves like one. Two things to
know: showing or hiding the preview moved from Ctrl/Cmd+K to Ctrl/Cmd+Alt+B, and the Solid theme no longer brings
Geist, so a self-hosted playground that wants it names it in its hosting file (`theme.fonts`, `theme.vars`).

### Playground

- **Added** — **Settings, and runbun.json as a form.** The gear in the header holds your preferences, including whether
  runbun.json shows in the file tree, and edits the project's runbun.json field by field, keeping its comments.
- **Added** — **Arrangements to pick in Settings.** The Panels section shows seven panel layouts as small pictures
  (columns, console below, preview on the left, editor and preview only, editor and console only, and more); a click
  applies one.
- **Added** — **Go to a file and run any command from the keyboard.** Ctrl/Cmd+P finds a file by part of its name or
  path; Ctrl/Cmd+Shift+P (or F1) lists every command with its shortcut. Showing or hiding the preview moves from
  Ctrl/Cmd+K to Ctrl/Cmd+Alt+B.
- **Added** — **Zoom the preview.** The request bar has zoom buttons (25% to 200%) for page previews; click the
  percentage to go back to 100%.
- **Added** — **Devtools have a tab of their own.** In a project that uses `@solidjs/start-devtools`, Vue DevTools or
  Nuxt DevTools, the pane under the preview opens on a Devtools tab with the toolbar in it instead of over your page.
  It follows the active preview tab, and Alt+Shift+D brings it forward. Experimental, and only where previews run on
  the playground's own origin.
- **Added** — **Vue and Nuxt in the gallery.** A Vue 3 + Vite starter and a todo list with Pinia and Vue DevTools; a
  Nuxt 4 starter and an example with pages, shared state and Nuxt DevTools.
- **Added** — **The installed app feels like one.** In Chrome and Edge the header is the title bar, runbun.dev links
  open in a new app window, the app icon's menu has Blank starter and Starters and examples, and .zip files open with
  it from Finder or Explorer. A link like web+runbun://example/starter-http, from another app or page, opens that
  project in it.
- **Added** — **A short link can show a card of the project's own.** With `card` in `runbun.json`, a short link shows
  the project's title, description and tags where it is posted, instead of runbun.dev's card.
- **Added** — **A self-hosted playground can choose which panes it opens with.** The hosting file's `panels` shows or
  hides the file tree, the preview and the console; a hidden console opens by itself when the program fails.
- **Added** — **A self-hosted playground can load its own fonts.** The hosting file's `theme.fonts` lists stylesheets
  to load, for the fonts `--font-ui` and `--font-mono` name in `theme.vars`.
- **Added** — **Hosts can hide runbun.json.** A self-hosted playground's `showConfig: false` keeps a project's
  runbun.json out of the file tree and the tabs; it still applies.
- **Changed** — **Panels you can rearrange.** The file tree, editor, preview and console now tile the window: drag a
  border to resize, hold Alt and drag a panel to move it, or press Ctrl/Cmd+K and then a key (a hint lists them).
  Narrow windows stack the panels. The fixed columns from before are the Columns arrangement in Settings.
- **Changed** — **The debugger is a tab next to the console.** With Debug on, the pane under the preview has Console
  and Debug tabs in place of the Debug panel squeezed above the console; the Debug tab comes forward each time the
  program pauses, and a run that fails switches back to the console, where its output says why.
- **Changed** — **The run status lives in the status bar.** Installing, Running and Exited show as a pill beside the
  server's port instead of a toast over the console. The Git button is now the first of the status bar's panel
  buttons, instead of on the right.
- **Changed** — **A preview opened in a new tab takes the preview panel's place.** The panel hides while the tab is
  open and comes back when you close it.
- **Changed** — **Picking the Solid theme no longer shifts the layout.** It used a font of its own (Geist), which moved
  the text and buttons on every switch; it now uses the same fonts as the other themes.
- **Changed** — **An embed's borders can be dragged in a narrow frame too.** In a frame under 560px wide only the
  console's border moved, and none when stacked; now each one does, and where two meet they drag together.
- **Changed** — **The installed app opens on the playground.** A launch of runbun.dev installed as an app no longer
  shows the landing page first; it stays at runbun.dev/about.
- **Fixed** — **A preview opened in a new tab stays up to date.** It now loads again on Run and when you save a file
  the page uses, as the preview panel does; before, it kept the old page until you reloaded it yourself.
- **Fixed** — **Previews with many requests at once don't stall.** A page loading lots of modules in parallel could
  hang on some of them.
- **Fixed** — **The preview catches a dev server that starts late.** It showed "No server running" until you reloaded
  it.
- **Fixed** — **Buttons and fields follow the host's font.** With a host or an embed that sets `--font-ui`, the
  header's buttons and the text fields kept the browser's default.
- **Fixed** — **A lone preview tab is no longer a sliver.** A tab named "/" was only as wide as its slash; every tab
  now has the same least width.
- **Fixed** — **Pierre Vibrant keeps the code visible.** Previewing or picking it in the theme picker blanked the
  editor's code until a reload.
- **Fixed** — **Tooltips show in dialogs.** The Keyboard shortcuts dialog's tooltips were hidden behind it.

### Runtime

- **Added** — **Processes reach each other's servers.** `net` servers and connections, and `fetch` to `localhost`,
  work between a program, its child processes and its worker_threads threads.
- **Added** — **path.matchesGlob.** Matches a path against a glob, as in Bun.
- **Fixed** — **fs.cp copies into folders that don't exist yet.** It makes them, as in Node and Bun, where it failed
  with ENOENT; `force` and `errorOnExist` work too.
- **Fixed** — **A function's source is what you wrote.** `fn.toString()` showed code the playground adds for
  AsyncLocalStorage; code that sends a function to a page (Nuxt's loading screen) failed there.

### Docs

- **Added** — **Vue starter and Vue DevTools in the playground.** A Vue 3 + Vite starter and a Vue + Pinia example,
  whose Vue DevTools open in the Devtools tab under the preview.

## 0.8.1 — 2026-11-22

Solid's server functions now work in the preview, and the Solid examples show Solid's devtools: a dock with the
app's errors, actions, ownership tree and reactivity graph. A new example runs Solid's start mode with server
functions. Nothing needs action.

### Playground

- **Added** — **Solid's devtools in the Solid examples.** The Solid 2, ReactiveScript and Solid SSR examples show
  Solid's devtools dock, and a new Solid Start + devtools example runs start mode with server functions.

### Runtime

- **Fixed** — **Solid server functions work in the preview.** A `"use server"` call from a page answered 403, and with
  the check off it lost its arguments: the server got neither the `Origin` nor the `Content-Length` a browser sends.

## 0.8.0 — 2026-11-22

A self-hosted playground can now look like its own site: a hosting file gives it a brand (logo, name, share card), a
theme and the themes it offers, and the language packs it enables, ReactiveScript being the first. The playground
gains a Solid theme, and the step debugger, a prototype, is now off unless a host turns it on. Nothing needs action;
to update a self-hosted copy, unpack this release's archive.

### Playground

- **Added** — **A self-hosted playground can carry its own brand.** A hosting file's `brand` puts your logo and name in
  the header, the page's icon and its titles, and `brand.card` replaces runbun's picture where a link to it is shared.
  `theme` picks the theme a first visit gets, and `localRunner: false` leaves out the Local Bun switch.
- **Added** — **Self-hosted playgrounds pick their languages.** A hosting file's `languages` lists the language packs
  to enable, ReactiveScript being the first; a pack left out is gone from the editor, and so are the gallery's
  examples that need it. Leaving the key out enables them all.
- **Added** — **A self-hosted playground can offer only some themes.** The hosting file's `theme.families` lists them;
  with a single one, the picker is just system, light and dark.
- **Added** — **A self-hosted playground switches themes in the shape of its own logo.** The hosting file's
  `theme.transition` picks the logo, a plain circle, or no transition at all.
- **Added** — **A Solid theme.** The theme picker has a Solid family, light and dark, in the SolidJS sites' colors and
  their font, Geist.
- **Changed** — **The run status is a toast over the panes.** It used to be a pill in the status bar unless you
  switched it under Appearance; that switch is gone.
- **Changed** — **The step debugger is off unless a host turns it on.** It's a prototype: runbun.dev no longer shows
  the Debug button, and a self-hosted copy enables it with `"debugger": true`.
- **Changed** — **Install and format read as what they do.** Menus and tooltips say "Install dependencies" and "Format
  the open file" instead of naming `bun install` and `bun fmt`.
- **Fixed** — **A self-hosted copy no longer shows where it was configured.** `configure.ts` wrote the hosting file's
  full local path into the served `hosting.js`; it now names the file only.
- **Fixed** — **The ReactiveScript examples no longer reload once on their first run.** Vite found the ReactiveScript
  runtime only after the page had loaded, optimized it then and reloaded the preview.

### Editor

- **Fixed** — **A ReactiveScript app's `main.ts` has no type error.** `app.mount(main(app))` was underlined with
  "Argument of type 'Element' is not assignable to parameter of type '() => unknown'".

### Docs

- **Added** — **Host your own playground.** The new [Self-hosting](https://docs.runbun.dev/guides/self-hosting/) guide
  takes a release archive to your own domain: one hosting file for its name, gallery, default project and origins,
  then `configure.ts` and any static host that sends two headers.

## 0.7.0 — 2026-11-20

The playground can now run on your own domain: each release ships a build for any host, which one script points at
yours, with its own name, gallery and default project. Projects that use rolldown's threads or `Bun.plugin` (the
ReactiveScript, Astro Solid and Solid SSR examples) now run on runbun.dev, not only on a local dev server. Nothing
needs action.

### Playground

- **Added** — **Host your own copy of the playground.** Each release from this one on carries
  `runbun-playground-<version>.tar.gz`: a build for any host and `configure.ts`, which points it at yours from one
  hosting file (`node configure.ts dist my-hosting.json`). The file can also give it its own name, choose which
  examples the gallery lists and which one opens first, and leave out the landing page; short links, Feedback and the
  git proxy stay with runbun.dev. The archive's README says how to serve it.
- **Fixed** — **A program that doesn't start says so.** When a run didn't come up within 15 seconds the status still
  showed Running; it now shows that the program didn't start, and switches to Running if it comes up late.

### Runtime

- **Fixed** — **Vite projects that use rolldown's threads run on runbun.dev.** The ReactiveScript examples exited with
  "Worker: only the project's files can run in a Worker here"; they only worked on a local dev server.
- **Fixed** — **Programs that import through `Bun.plugin` start on runbun.dev.** The Solid SSR dashboard example, whose
  preload compiles its JSX, stopped with "worker start timed out"; it only worked on a local dev server.
- **Fixed** — **Threaded wasm bindings start their threads on runbun.dev.** The Astro Solid example stopped with
  "worker error: couldn't read a message from the runtime" when rolldown started its thread pool.
- **Fixed** — **Threads and child processes load the ES modules their parent required.** A `worker_threads` thread
  importing a module its parent had loaded with `require()` got an empty module, so threaded wasm bindings such as
  rolldown's failed to start their threads.
- **Fixed** — **`self` can be assigned, as in Bun.** `globalThis.self = …` threw "Cannot set property self", so
  rolldown's wasm thread workers failed to load.

## 0.6.0 — 2026-11-19

Git grows up in the playground: merge, rebase, stash and tag work in the terminal and in the Git view, with
conflicts to resolve. SQLite moves to its official WebAssembly build with real files and WAL, `node:sqlite`,
`node:test`, `node:wasi` and `Bun.plugin` run, and `bun install` takes git dependencies, lifecycle scripts and
patches. A fast path previews browser-only projects (React, Preact, Solid 2) without an install. Nothing needs action;
`bun test`'s `-t`, `--timeout` and the like with Local Bun need `@runbun/connect` 0.5.0.

### Playground

- **Added** — **`git merge` in the playground.** Fast-forwards and merge commits (`--no-ff`, `--ff-only`, `-m`), several
  branches at once, `--squash` and `--no-commit`; where both branches changed the same lines it stops with conflict
  markers, as git does: edit the files, `git add` them and `git commit`, or `git merge --abort`.
- **Added** — **`git tag` in the playground.** List tags (`-l <pattern>`, `-n`), create lightweight or annotated ones
  (`-a -m`) and delete them (`-d`); `git show` on an annotated tag shows its message. `--sort` (`git tag
  --sort=-v:refname` shows the newest version first, `tag.sort` too) and `--contains`/`--no-contains` order and filter
  the list as git does.
- **Added** — **`git stash` in the playground.** Set changes aside and bring them back (`stash`, `-m`, `-u`, `list`,
  `show`, `apply`, `pop`, `drop`, `clear`), keep the index (`-k`), include ignored files (`-a`), stash only some paths
  (`push -- <path>`) or branch from a stash (`stash branch`); the stashes are git's own, so a cloned or downloaded
  repository's stashes work too.
- **Added** — **`git pull` merges when your branch and its upstream have diverged.** It stopped with "Not possible to
  fast-forward" before; now it merges as git does (`--ff-only` still refuses), also from the Git view's Pull button, and
  a conflict stops with markers to resolve.
- **Added** — **`bun test --coverage` works with Local Bun.** Native Bun counts the coverage, its table prints in the
  console and `lcov.info` lands in the project; the console used to send you back to the browser for it.
- **Added** — **Merge branches, resolve conflicts and use stashes in the Git view.** Merge from the branch menu; a merge
  or pull that conflicts lists the files under Merge Changes with Mark as resolved, Abort and Commit merge, and Stash
  all changes and a Stashes list (apply, pop, drop) save a trip to the console.
- **Added** — **The Git view walks you through a stopped rebase.** It names the branch and how far the rebase got, and
  offers **Continue rebase**, **Skip this commit** and **Abort** once you have resolved the files.
- **Added** — **`bun test -t`, `--timeout`, `--bail`, `--rerun-each`, `--todo` and `--only` work with Local Bun.** They
  were refused with "Local Bun takes only -u and the coverage flags".
- **Added** — **A Fast path toggle runs browser-only projects without an install.** Packages load from esm.sh through an
  import map, so a React or Preact page shows up seconds sooner. Experimental; `?fast` in a link turns it on too.
- **Added** — **The fast path runs Solid 2 projects.** Their JSX is compiled by Solid's own compiler, loaded the first
  time one runs, so a Solid 2 page previews without an install, in the playground and in embeds.
- **Added** — **A Solid 2 SSR example in the gallery.** A dashboard that `Bun.serve` streams panel by panel and the page
  hydrates, with optimistic actions over `bun:sqlite`: no framework, no Vite.
- **Added** — **A Solid 2 + Vite example in the gallery.** Edit a component and it is swapped in the running preview,
  with the count and the notes left as they were.
- **Added** — **`"fastPath": false` in `runbun.json`.** A project whose dev server must run stays off the fast path even
  when the reader has turned it on, and the console says why.
- **Added** — **`.rx` files are highlighted.** ReactiveScript sources showed as plain text.
- **Added** — **A ReactiveScript example in the gallery.** A small `.rx` app, compiled to Solid 2 on the Vite dev
  server, with the compiler's errors, types and Format in the editor.
- **Added** — **A second ReactiveScript example: cascading selects.** Country, state and city selects, each loading its
  options from the one above, in `.rx`.
- **Changed** — **The Elysia 2 example runs the latest release candidate.** It was pinned to 2.0.0-rc.1.
- **Changed** — **Saving a page's script no longer restarts your server.** Under Watch, an edit only the browser page
  loads reloads the preview and keeps the program (and its state) running, about a third faster.
- **Changed** — **Code is highlighted by @pierre/highlights.** The editor, the response viewer and the Changes tab color
  code with Pierre's own highlighter; switching to Pierre Vibrant no longer blanks the editor. ReactiveScript files are
  now colored as TSX.
- **Fixed** — **A response stream that fails at once fails in the preview too.** A page's request got a 200 with an
  empty body from a stream that threw before its first chunk; as from Bun, it now gets a network error, and a stream's
  response arrives with its first chunk.
- **Fixed** — **The Git view's merge box shows the whole branch name, and Commit merge looks unavailable until the
  conflicts are resolved.** The title was cut to "Merge bra…", and the disabled button looked like an enabled one.
- **Fixed** — **Streamed pages show as they arrive.** An HTML page a server sends in parts (streamed SSR from Solid, Lit
  or React) appeared in the preview all at once, after its last part.
- **Fixed** — **Hot module replacement keeps the page's state with Watch on.** A save under Vite's dev server swapped
  the module and then reloaded the preview anyway. A program that watches the saved files itself now decides what the
  page does.
- **Fixed** — **Clicking the preview closes the theme picker.** A click in the preview left the picker open, still
  showing the theme under the pointer.

### Runtime

- **Added** — **`Bun.randomUUIDv7` works.** Time-ordered UUIDs as Bun makes them, in hex, base64, base64url or a Buffer,
  for now or a given timestamp; Elysia 2 apps no longer answer every request with a 500.
- **Added** — **`process.getBuiltinModule` works.** It returns a `node:` or `bun:` module (with or without the `node:`
  prefix), `undefined` for anything else, so packages that look for it, such as @elysia/static, no longer switch off.
- **Added** — **A program's WebSocket reaches its own server.** `new WebSocket("ws://localhost:3000")` to a `Bun.serve`
  of the same program connects, as in Bun, so WebSocket tests, Eden's `subscribe` and other in-process clients work;
  before, it failed to connect.
- **Added** — **`Bun.FileSystemRouter` works.** Next.js-style routes over the project's files match paths, URLs and
  Requests as in Bun, with params, query, src and reload().
- **Added** — **`Bun.stdout.writer()` and `Bun.stderr.writer()` print to the console.** Their FileSink buffers writes
  and flushes them when Bun would, so output keeps Bun's order.
- **Added** — **`Bun.plugin` works for imports and requires.** onResolve and onLoad hooks with filters and namespaces,
  build.module virtual modules, the js/ts/tsx/jsx/object/json/toml/yaml loaders and clearAll() behave as in Bun for what
  the program imports after registering them.
- **Added** — **`Bun.serve`'s `error` handler answers for a failing handler.** A handler that throws or rejects gets the
  `error` handler's Response, or Bun's 500 page (plain "Something went wrong!" with `development: false`); a `fetch` to
  the program's own server no longer rejects.
- **Added** — **`Bun.serve` takes `maxRequestBodySize`, `unix` and `server.requestIP`.** Too large a request body gets
  Bun's 413, `requestIP` says where a request came from, and `fetch(url, { unix })` reaches a server on a unix socket;
  `idleTimeout` and `reusePort` no longer go unchecked.
- **Added** — **`node:diagnostics_channel` works.** Subscribers receive what is published, `tracingChannel` traces sync,
  promise and callback calls, `bindStore` runs code in an `AsyncLocalStorage` store, and the `http` client publishes the
  channels Bun's does; before, nothing was delivered.
- **Added** — **`node:sqlite` works.** `DatabaseSync` and `StatementSync` run queries with named and positional
  parameters, user functions, aggregates and tagged-template statements, on files kept in the project; importing it used
  to fail.
- **Added** — **Tests written with `node:test` run under `bun test`.** `test`, `describe`, hooks, subtests,
  `skip`/`todo` and `mock` work as in Bun; before, importing `node:test` failed.
- **Added** — **`v8.serialize` and `v8.deserialize` work, with Bun's bytes.** Data serialized in the playground
  deserializes in Bun and back; heap statistics have the shape Bun gives. Before, they threw.
- **Added** — **More `node:*` modules import.** `domain` works, `constants` and `os.constants` have Linux's values,
  `trace_events` and an `inspector` session respond as in Bun, and `dgram`, `repl` and `wasi` load (their sockets and
  servers still can't run); before, importing them failed or gave empty objects.
- **Added** — **bunfig.toml's `preload` runs before your program.** A Bun.plugin registered there serves the entry's
  imports, and `[test] preload` sets up `bun test` (global hooks, plugins) as in Bun.
- **Added** — **`node:wasi` runs WebAssembly programs built for WASI.** A wasm32-wasi program gets its `args`, `env` and
  preopened project directories, prints to the console and exits with its code; before, `new WASI()` threw.
- **Added** — **`bun --preload <file>` works.** `bun -r ./setup.ts main.ts` in the console, in a package.json script or
  from a spawned process runs setup.ts first, after bunfig.toml's preload, as in Bun.
- **Added** — **`bun test --coverage` reports coverage.** The console prints Bun's table of the functions and lines that
  ran, `--coverage-reporter lcov` writes `coverage/lcov.info`, and bunfig.toml's coverage options (thresholds, ignore
  patterns, test files) apply.
- **Added** — **`node:sqlite`'s `db.setAuthorizer()` works.** The callback sees each action a statement takes as it is
  prepared and can allow, deny or ignore it, as in Bun; it used to throw.
- **Added** — **`node:sqlite` sessions work.** `db.createSession()` records changes as a changeset or patchset, and
  `db.applyChangeset()` applies one with `filter` and `onConflict`, as in Bun; both used to throw.
- **Added** — **`bun:sqlite` statements have `columnTypes` and `declaredTypes`.** They give each column's type in the
  first row and its declared type, as in Bun; both were undefined.
- **Added** — **`bun:sqlite` has `db.function()` and `db.aggregate()`.** User-defined SQL functions and aggregates
  (window functions too, with `inverse`) work as in Bun, with `deterministic`, `directOnly`, `varargs` and
  `safeIntegers`; they used to be missing.
- **Added** — **`bun:sqlite` has update hooks.** `db.onInsert`, `db.onUpdate` and `db.onDelete` call a function for
  every row a statement inserts, updates or deletes, with the table and the rowid, as in Bun.
- **Added** — **`db.fileControl()` in `bun:sqlite`.** Settings such as `SQLITE_FCNTL_PERSIST_WAL` reach the database
  file as in Bun, and `constants` has all of Bun's `SQLITE_*` values.
- **Added** — **More of Bun's `bun:sqlite`.** `iterate()` now reads rows as the loop asks for them instead of all at
  once, and statements have `raw()`, `reader`, `readonly` and `native`. `Database.open`, `db.handle`, `close(true)` and
  Bun's 20-statement query cache are there, and a `prepare()`d statement still works after `close()`.
- **Added** — **`node:sqlite`'s `db.limits` and the `timeout` option.** Limits such as `column` or `attach` can be read
  and lowered, and a connection opened with `timeout` waits that long for a lock before failing with "database is
  locked".
- **Added** — **Programs can run `bun test`.** `Bun.spawn(["bun", "test"])`, `child_process` and a package.json `"test":
  "bun test"` started with `bun run test` run the project's tests and exit with 1 when one fails; they used to refuse to
  start.
- **Added** — **node:test's `run()` works.** `run({ files })` runs each file and streams Node's test events (pass, fail,
  skip, todo, subtests, output, summaries) as Bun does; it used to throw "not supported".
- **Added** — **`bun test` takes `-t`, `--timeout`, `--bail`, `--rerun-each`, `--todo` and `--only`, in the console and
  spawned.** A spawned `bun test` (Bun.spawn, a "test" script) also takes `--coverage`; it took only `-u` before.
- **Added** — **Browser-only projects run with `bun ./index.html`.** A project whose script is `bun ./index.html` (or
  that is just an `index.html`) used to fail with "module not found: index.ts"; Run now serves the page with its scripts
  bundled, and `[serve.static] plugins` in bunfig.toml apply.
- **Added** — **`SourceMap` from `node:module`.** `findEntry`, `findOrigin`, `payload` and `lineLengths` work, so
  `@solidjs/vite-plugin` compiles Solid 2 components under Vite.
- **Changed** — **`bun:sqlite` and `node:sqlite` run on SQLite's official WebAssembly build.** Errors carry SQLite's own
  extended result code and byte offset (`SQLITE_CONSTRAINT_TRIGGER`, `SQLITE_CONSTRAINT_DATATYPE`, ...), and a BigInt
  binds as an exact 64-bit integer where it used to turn into text.
- **Changed** — **`bun:sqlite` and `node:sqlite` file databases are real files, WAL mode included.** `pragma
  journal_mode = wal` now returns `wal`, the `-journal`, `-wal` and `-shm` files appear next to the database as
  natively, and two connections to one file see each other's commits and get `SQLITE_BUSY` where Bun would.
- **Changed** — **`bun test` diffs are coloured in the console.** Failed `toEqual`, `toStrictEqual` and snapshot diffs
  show Bun's colours and highlight the characters that changed, as on a terminal; they were plain.
- **Fixed** — **`fetch` to your own server follows redirects.** A request to a `Bun.serve` route that redirects ended at
  the 302; it now arrives where it points, as in Bun, and `Response.redirect("/path")` keeps its relative Location.
- **Fixed** — **`Bun.serve` responses carry Bun's default headers.** `content-length` for strings, bytes and files,
  `application/octet-stream` for binary bodies, and HEAD answers without a made-up content type; a HEAD to a route with
  only a GET handler no longer falls through to `fetch`.
- **Fixed** — **Uploaded files and `Bun.file` in forms look as in Bun.** A file part parsed with `formData()` is typed
  by its extension (`text/plain;charset=utf-8` for `.txt`), and a `Bun.file` added to a `FormData` keeps its file name
  instead of `blob`.
- **Fixed** — **A response stream that fails at once fails the `fetch`.** A program fetching its own server got a 200
  and the first chunk from a stream that threw right away; as in Bun, the `fetch` now rejects with `ECONNRESET`.
- **Fixed** — **`ws.send(1)` works.** A server WebSocket's `send` and `publish` take a number or an object and send it
  as text, as in Bun, instead of throwing.
- **Fixed** — **node:http servers listen on their own port.** A server on 8080 showed as 3000, a fetch or http.get to it
  from the program failed, and listen(0) reported a made-up port.
- **Fixed** — **SQLite parameters bind with the types Bun gives them.** In `node:sqlite` a whole number bound as an
  INTEGER where Bun binds a REAL, and in both `bun:sqlite` and `node:sqlite` a BigInt was bound as text, which
  `typeof()` and untyped columns showed.
- **Fixed** — **`node:sqlite` rejects double-quoted string literals.** `"abc"` naming no column ran as the string 'abc'
  instead of failing with `no such column: "abc"` as in Bun, unless the database was opened with
  `enableDoubleQuotedStringLiterals`.
- **Fixed** — **CommonJS bins with a `#!` line run.** Running one, as a script or a child process, failed with a syntax
  error.
- **Fixed** — **`bun test` shows a failing error's properties and cause.** A thrown error was reported with its message
  only, without `code`, `actual`, `expected` or its `cause`.
- **Fixed** — **node:test reports failing subtests and waits for planned assertions as Bun does.** A failing subtest's
  error is shown as its parent's cause, and `t.plan(n, { wait })` no longer fails a test whose assertions come later.
- **Fixed** — **`node:sqlite`'s `columns()` says where each column comes from.** Its `column`, `table`, `database` and
  `type` were always null; they now give the source column, table, database and declared type, as in Bun.
- **Fixed** — **`node:sqlite` user functions return values typed as in Bun.** A whole number a `db.function()` returned
  was stored as an INTEGER where Bun stores a REAL, and a BigInt past 64 bits or a Promise gave the wrong error.
- **Fixed** — **`import Database from "bun:sqlite"` works.** The default export was the module object instead of the
  `Database` class.
- **Fixed** — **`using` and `await using` declarations work.** A program with one failed to start with "does not provide
  an export named '__callDispose'".
- **Fixed** — **Coverage counts generators when they are called.** With a rest parameter (destructured too) or a "use
  strict" body, `bun test --coverage` showed a generator called but never resumed as uncalled, code after `?.#private`
  as run when it was skipped, and a comment mentioning "use strict" atop a CommonJS file as a covered line.
- **Fixed** — **CommonJS TypeScript files with "use strict" run in strict mode.** Assigning to an undeclared variable or
  writing a frozen object's property no longer passes silently, as in Bun.
- **Fixed** — **`bun test` failure diffs show the whole value, as Bun prints them.** A failed `toEqual` or snapshot
  showed only the changed lines and one line around each, under `@@` headers.
- **Fixed** — **`bun test` lists the skipped, todo and failed tests again at the end.** Past 20 passing tests, Bun
  repeats them above the totals, so the failures of a long run are in one place; the playground didn't.
- **Fixed** — **A `bun test` child process counts coverage from its own folder's bunfig.toml.** A test run spawned in a
  subfolder whose bunfig.toml enables coverage printed no coverage table.
- **Fixed** — **`toEqual` diffs list object keys in Bun's order.** A diff of objects whose keys aren't alphabetical
  printed them in insertion order; Bun sorts them.
- **Fixed** — **A `bun:test` hook that throws is reported as Bun reports it.** A failing `afterAll` or `beforeAll` shows
  as `describe > (unnamed)`, a failing `beforeAll` skips its describe's tests, and the hooks of a describe without
  running tests run as in Bun.
- **Fixed** — **Packages with threaded WebAssembly bindings load.** A native package's wasm fallback built with threads,
  such as `@solidjs/compiler`, crashed with "failed to generate random data".
- **Fixed** — **A preloaded plugin compiles the entry file too.** A `Bun.plugin` `onLoad` registered in a `bunfig.toml`
  preload only applied to what the program imported, not to the program itself.
- **Fixed** — **Threaded WebAssembly bindings can read files.** A native package's wasm fallback built with threads,
  such as `@reactivescript/compiler`, got "no such file" for every path it opened.
- **Fixed** — **Native packages no longer print "command not found: ldd".** Their loaders now find the libc in
  `process.report.getReport()`.

### Toolchain

- **Added** — **`bun install` takes `file:` tarballs, `link:` and GitHub dependencies.** `github:user/repo#ref`,
  `user/repo` and `git+https://github.com/…` install from GitHub, `file:vendor/pkg.tgz` from the project, and `bun link`
  makes a folder a `link:` dependency; bun.lock is the one native Bun writes. Git dependencies on other hosts are
  reported.
- **Added** — **`bun install` runs lifecycle scripts.** The project's own `preinstall`, `postinstall` and `prepare` run,
  and so do those of the dependencies in `trustedDependencies` (or Bun's default list); the others are blocked as in
  Bun, `bun pm untrusted` lists them and `bun pm trust` runs them. `--ignore-scripts` skips them all.
- **Added** — **`patchedDependencies` and `bun patch` work.** Patches in `patchedDependencies` are applied as packages
  install, and `bun patch <pkg>` then `bun patch --commit node_modules/<pkg>` saves your edits as the patch native Bun
  writes.
- **Added** — **`Bun.build` takes plugins.** `onResolve` and `onLoad` (virtual modules, aliases, externals, namespaces,
  custom loaders), `onStart` and `onEnd` run as in Bun, async hooks too; before, passing `plugins` threw.
- **Added** — **`undici`, `node-fetch` and other packages Bun ships work without installing them.** As in Bun,
  `node-fetch`, `undici` (`request`, `fetch`), `isomorphic-fetch`, `@vercel/fetch`, `abort-controller` and
  `utf-8-validate` are Bun's own instead of `cannot resolve`, and so is `ws` even when it is installed.
- **Added** — **Git dependencies from GitLab, Codeberg and Bitbucket install.** `git+https://…`, `https://….git`,
  `git+ssh://git@<host>/…` and the `gitlab:`/`bitbucket:` shorthands are cloned in the browser, and bun.lock is the one
  native Bun writes.
- **Added** — **`git merge -s ours` and `-X ours`/`-X theirs`.** Merges can keep your side wholesale or settle
  conflicting hunks for one side, and `-X no-renames`/`find-renames=<n>` and `diff-algorithm=` work too.
- **Added** — **`git stash --staged`, `git stash create` and `git stash store`.** Set aside only what you staged, or
  make a stash commit without touching your files and add it to the list later.
- **Added** — **More of `git tag`: `--format`, `--merged`, `--points-at`, `-F`, `-i`.** List tags with your own format
  (`%(refname:short) %(subject)`), by what they point at or what is merged, and take an annotated tag's message from a
  file.
- **Added** — **`git tag --sort=v:refname` honors `versionsort.suffix`, and `--format` takes `%(align)` and `%(if)`.**
  `v1.0-rc1` sorts before `v1.0` once the suffix is configured, and formats can pad columns or print one thing for
  annotated tags and another for lightweight ones.
- **Added** — **`git rebase` and `git pull --rebase`.** Replay your branch's commits onto another one (`--onto`, `-X
  theirs`), resolve a conflict and `git rebase --continue`, `--skip` or `--abort`, or have `pull` rebase your local
  commits onto the fetched ones instead of merging.
- **Added** — **`git rebase main feat` rebases another branch.** Name the branch to rebase after the upstream, as in
  git, instead of switching to it first.
- **Added** — **`git status` says whether your branch is ahead of or behind its upstream.** As git does: up to date,
  ahead, behind, diverged or gone, with the hint on what to do.
- **Added** — **`git rebase --autostash`.** Rebase with uncommitted changes: they're set aside first and brought back
  once the rebase is done, as in git; `git config rebase.autoStash true` makes it the default.
- **Fixed** — **`import "ws"` works without installing ws.** As in Bun, a program gets Bun's built-in ws instead of
  `cannot resolve "ws"`.
- **Fixed** — **Dependencies' install scripts find their own dependencies' bins.** A `postinstall` calling a bin of a
  nested or hoisted dependency failed with `command not found`.
- **Fixed** — **`Bun.build` names chunks and hashes outputs as Bun does.** Split chunks were named after their module
  (`lazy-<hash>.js`) instead of `chunk-<hash>.js`, and a custom `naming` gave different hashes.
- **Fixed** — **`Bun.build` with several entry points in one folder puts their outputs at the top of `outdir`.** They
  landed in a subfolder named after that folder.
- **Fixed** — **`Bun.build`'s outputs report the same `loader` as in Bun.** An entry point's outputs showed their own
  loader (`"js"`, `"css"`) instead of the entry's (`"ts"`).
- **Fixed** — **`Bun.build` without `outdir` works for code that imports CSS.** It failed with "cannot write multiple
  output files without an output directory"; now it returns the JS, the CSS and the assets in memory, as Bun does.
- **Fixed** — **`git switch` and `git checkout` list the changes they carry over.** The `M	file` lines git prints were
  missing, and `git checkout --detach` without a commit did nothing.
- **Fixed** — **`git checkout` warns before you leave commits behind.** Detaching prints git's advice, and leaving a
  detached HEAD lists the commits no branch keeps, as git does; `git status` says where HEAD was detached from.
- **Fixed** — **`git commit -q` is quiet, and a commit on a detached HEAD says so.** The summary was printed anyway, and
  named the branch `HEAD` instead of git's `detached HEAD`.
- **Fixed** — **`git commit` without `-m` during a stopped rebase.** It takes the stopped commit's message, as `git
  commit --no-edit` does, instead of asking for `-m`.
- **Fixed** — **`git fetch` says when a branch was force-pushed.** The line for a remote branch that was rewritten ends
  in `(forced update)`, as in git.
- **Fixed** — **`git rebase` and `git pull --rebase` leave out commits a force-push removed upstream.** Like git, they
  replay only what you added since your branch forked from its upstream (`--fork-point`), instead of bringing the
  dropped commits back.

### Editor

- **Added** — **ReactiveScript files get errors, hovers and go to definition.** A `.rx` file shows its compiler's rule
  errors and TypeScript's type errors as you type, and the type of the name under the pointer.
- **Added** — **Format works on ReactiveScript files.** The Format button reflows a `.rx` module and leaves it as it is
  when the result can't be shown to be the same program.
- **Fixed** — **Errors about missing packages clear once they're installed.** A file that was open during `bun install`
  kept showing "Cannot find module" until you edited it.

### Docs

- **Added** — **Use cases, with a recommendation for each.** A new guide says what to start from for a server, a
  frontend, a database prototype, a bug reproduction, examples in your docs or a workshop.
- **Changed** — **Keyboard shortcuts look like keys.** The search shortcut and the keys named in the guides are small
  pixel keycaps, like the site's buttons.
- **Changed** — **The playground's features have a page each.** Editor, console, Git, running code, preview and fast
  path are separate pages you can skim: each item shows one line and opens for the detail.
- **Changed** — **The compatibility tables are scannable.** Each row's note is one line, with the full detail in a
  section below it.
- **Fixed** — **The compatibility overview matches the detail pages.** It said `bun install` doesn't write `bun.lock`
  and that `Bun.sql` is missing; both work.
- **Fixed** — **Runnable examples with several files have one frame.** Their code drew a second border and shadow inside
  the block, with a scrollbar beside it.
- **Fixed** — **The sidebar's sections stay in line.** The current section's button sat lower than the others.
- **Fixed** — **The phone layout's menu, search and "On this page" buttons match the site.** The menu button was round,
  the search button a narrow sliver and the page outline a rounded box.
- **Fixed** — **The page no longer jumps sideways.** Opening the menu or the search, or going from a short page to a
  long one, moved everything by a scrollbar's width.

## 0.5.0 — 2026-11-17

A large step in Bun and Node compatibility: node:crypto ciphers and signatures, HTTP clients, `HTMLRewriter`, zstd and
brotli, S3, `Bun.sql` on an in-tab Postgres, console input with a real terminal mode, AsyncLocalStorage across
`await`, and much more of `bun test`. `bun install` handles monorepos, catalogs, overrides and private registries.
Nothing needs action; `bun test -u` with Local Bun needs `@runbun/connect` 0.3.0.

### Playground

- **Added** — **`bun test -u` updates snapshots with Local Bun.** The changed snapshot files and inline snapshots land
  in your project and show in the editor; with a runner older than `@runbun/connect` 0.3.0 the console says to update
  it instead of losing the snapshots silently.
- **Fixed** — **Stack traces after an `await` point at the right column again.** A frame on a line with an `await`
  before it reported a column further along than Bun.

### Runtime

- **Added** — **`http.request` and `http.get` work.** Code that uses node:http or node:https clients (axios,
  node-fetch-style libraries) no longer throws; requests go over `fetch`, so remote hosts follow the browser's CORS
  rules.
- **Added** — **`HTMLRewriter` works.** Rewrite HTML as a stream with CSS selectors and element, text, comment, doctype
  and document-end handlers, on a Response, a string or a buffer, as in Bun. Handlers can be async when the input is a
  Response.
- **Added** — **bun:sqlite throws SQLiteError and covers more of Bun's API.** `SQLiteError` carries `code`, `errno` and
  `byteOffset`; `safeIntegers`, `Statement.as()`, `Database.deserialize()` and `inTransaction` now work, and nested
  `db.transaction()` calls use savepoints.
- **Added** — **Custom matchers and assertion counts in `bun test`.** `expect.extend`, `expect.assertions`,
  `expect.hasAssertions`, `test.failing` and `test.concurrent` no longer throw as unsupported.
- **Added** — **Fake timers in `bun test`.** `jest.useFakeTimers()`, `advanceTimersByTime`, `runAllTimers` and
  `setSystemTime` work, so tests of debounce, retry and date code run without waiting.
- **Added** — **Snapshot testing in `bun test`.** `toMatchSnapshot`, `toMatchInlineSnapshot` and `bun test -u` work and
  write the same `.snap` files as Bun.
- **Added** — **`mock.module` and `jest.mock` in `bun test`.** A module mocked before its first `import()` is replaced
  for everything that loads it after.
- **Added** — **node:crypto has ciphers, keys and signatures.** `createCipheriv` (AES, ChaCha20-Poly1305),
  `createPrivateKey`/`createPublicKey`/`KeyObject`, `generateKeyPair`, `sign`/`verify` and
  `publicEncrypt`/`privateDecrypt` were missing; libraries like `jsonwebtoken` that sign with RSA now run.
- **Added** — **`Bun.hash.cityHash32`, `cityHash64`, `xxHash3` and `rapidhash` work.** They threw before; all of
  `Bun.hash` now returns what Bun does, seeds included.
- **Added** — **`Bun.build` takes `loader`, `env`, `packages`, `drop` and `root`.** They were ignored before; the output
  now matches native Bun's.
- **Added** — **zstd and brotli work.** `Bun.zstdCompress`, `Bun.zstdDecompress` and their sync forms, `node:zlib`'s
  Brotli and zstd functions and streams, and `CompressionStream("brotli" | "zstd")` used to be missing or throw.
- **Added** — **Programs can read what you type in the console.** `readline`, `process.stdin`, `Bun.stdin`, `for await
  (const line of console)` and `prompt()` used to get nothing; now Enter sends the line to the program, Ctrl+D ends the
  input, and output without a newline keeps your answer on the prompt's row.
- **Added** — **`node:vm` runs code.** `vm.runInThisContext`, `Script`,
  `createContext`/`runInContext`/`runInNewContext`, `isContext` and `compileFunction` work instead of throwing. A
  context shares the worker's realm, so it isn't a sandbox.
- **Added** — **Prompt libraries and TUIs work in the console.** `process.stdin.setRawMode(true)` delivers each key as
  it is typed, `process.stdout` is a terminal with a size and colors, `readline` has a terminal mode and `keypress`
  events, and `@clack/prompts` selects, text inputs and confirms redraw in place.
- **Added** — **S3 from the browser.** `Bun.S3Client`, `Bun.s3`, S3 files, presigned URLs, multipart uploads and `s3://`
  URLs work against S3, R2 and MinIO, signed as Bun signs; the bucket must allow the page's origin in its CORS rules.
- **Added** — **`Bun.sql` and `SQL` work, with Postgres in the tab.** A `postgres://` URL opens a database that lives in
  your browser (PGlite) and stays with the project between runs; the first query downloads about 5 MB.
- **Fixed** — **fetch reaches your own server.** `fetch("http://localhost:3000")` failed when the same program served
  that port with `Bun.serve` or `http.createServer`.
- **Fixed** — **axios uses node:http.** `import axios from "axios"` picked the browser's XMLHttpRequest adapter; there
  is no `XMLHttpRequest` global now, as in Bun.
- **Fixed** — **`require.resolve` works in ES modules.** `require` in an ES module (and `import.meta.require`) threw
  "require.resolve is not a function"; it now has `resolve`, `cache` and `main`, as in Bun.
- **Fixed** — **AsyncLocalStorage keeps its store across await.** The store was lost at the first `await`, timer or
  promise callback, which broke request context in Hono's `contextStorage()`, pino-http and similar. It now follows the
  call through timers, promises, `for await` and a server's handler, as in Bun.
- **Fixed** — **Vite 8 projects run again.** vite-demo and astro-solid-demo failed with "Worker: only the project's
  files can run in a Worker here".

### Toolchain

- **Added** — **Monorepos install.** `bun install` reads the root's `workspaces` and `workspace:` dependencies,
  installs each workspace's dependencies and writes the same bun.lock native Bun does. A project that was refused with
  "workspaces don't work in the browser" now installs and runs.
- **Added** — **Catalogs install.** `"react": "catalog:"` and named catalogs in the root package.json resolve like
  native Bun, and bun.lock records them.
- **Added** — **`overrides` and `resolutions` apply.** Flat and scoped rules (nested objects, `name@range` keys,
  `parent/child` and `parent>child`) install the versions you pinned, and bun.lock records them as native Bun does.
- **Added** — **Private and mirrored registries.** `registry=` and `@scope:registry=` in the project's .npmrc choose
  where `bun install` fetches from, with the `_authToken` or `_auth` you put there. The registry has to allow
  cross-origin requests.

## 0.4.2 — 2026-11-16

Embedded playgrounds start faster and fail less on the way: a test run no longer leaves the preview without a server,
the playground's scripts stay cached between visits, and pinned packages install from the cache. Nothing needs action.

### Playground

- **Changed** — **Faster repeat visits.** The playground's scripts and styles are cached for a year: a page that loads
  an embed again doesn't ask for them again.
- **Fixed** — **Previews don't fail across a test run.** A request sent while `bun test` runs next to a running server
  waits for that server to be back instead of answering "No server running".

### Toolchain

- **Changed** — **Pinned dependencies install without asking the registry.** Package metadata cached earlier is reused
  past its 5 minutes when a project asks for an exact version it already lists.

## 0.4.1 — 2026-11-16

A small fix to the editor's tabs. Nothing needs action.

### Editor

- **Fixed** — **Tabs without a close button fit their name.** A tab that can't be closed is as wide as its name,
  without the empty space for a ×.

## 0.4.0 — 2026-11-15

The playground gets a step debugger: breakpoints on line numbers, the call stack and variables where a program stops,
and stepping. Programs can run `new Worker()` threads (Bun's and `node:worker_threads`), use `spawnSync` and
`execSync`, and serve the preview from a child process, and stack traces and file errors print as Bun prints them. A
project's runbun.json now sets pane sizes, read-only files, its layout and its gallery card, and an embed's tabs follow
the page's theme. Nothing needs action.

### Playground

- **Added** — **A step debugger.** Turn on Debug, click a line number to set a breakpoint and run: the program pauses
  there and shows its call stack and variables. Evaluate expressions where it stopped, and step over, into and out.
- **Added** — **runbun.json sets the panes' sizes.** `sizes` gives the file tree, the editor and the preview their share
  of space when a project opens, in the playground and in embeds.
- **Added** — **runbun.json marks files read-only.** Files and folders listed in `readonly` open in the editor but can't
  be edited, renamed or deleted there; the program can still write them.
- **Added** — **Embeds switch between side and stack without reloading.** The layout follows `setLayout`, and a
  project's runbun.json can choose one with `layout` when the host page doesn't.
- **Added** — **runbun.json can describe a project's card.** `name`, `description`, `kind` and `tags` in a project's
  runbun.json set how it shows in the gallery; an example.json beside it is still read.
- **Added** — **Choose which server the preview shows.** When a program and its child processes serve several ports, the
  port in the status bar (in an embed, the ⋯ menu's Preview port) lists them, and picking one reloads the preview from
  that server.
- **Added** — **Third-party licenses page.** runbun.dev/third-party-licenses.txt lists the open-source packages and
  crates the playground runs, with their license texts; the landing page's footer links it.
- **Added** — **CSS hints in Lit and styled-components templates.** Inside a css`…` template the editor shows a
  property's docs on hover, completes properties and values, and warns about unknown properties and empty rules, as it
  does in a stylesheet.
- **Added** — **Tab rows follow the page's theme.** `vars` takes `--tab-track`, `--tab-radius`, `--tab-selected`,
  `--tab-mark` and a few more, so an embed's editor and preview tabs can match a page's segmented controls, e.g. pill
  tabs on a track without the accent line.
- **Changed** — **Link previews show the kitchen.** A runbun.dev or docs link shared in a chat or on social media now
  previews as the landing page's pixel-art kitchen instead of the old dark card.
- **Changed** — **The terminal's scrollbar looks like the other panes'.** Its thumb is a rounded pill inset from the
  edge instead of a square block.
- **Changed** — **CSS and HTML in tagged templates are highlighted.** The editor colors CSS in css`…` and HTML in
  html`…` (Lit, styled-components) instead of showing them as one plain string.
- **Changed** — **The selected tab slides.** Switching tabs moves the selected tab's fill and mark to the new one in the
  editor, the preview and the request panel. `vars` takes `--tab-slide` (duration, `0s` to turn it off) and
  `--tab-slide-ease`.
- **Fixed** — **The landing page's sound button shows what you hear.** It read "on" before your first click, while the
  browser still kept the page silent, and the first press on it turned the sounds off.
- **Fixed** — **Embeds forget the last project's panes.** Opening a library project without `panels` in its runbun.json
  kept the panes the previous one showed or hid.
- **Fixed** — **runbun.json's env applies with Local Bun.** Programs run with native Bun on your machine now see the
  project's `env`, as they do in the browser.
- **Fixed** — **No stray line at the terminal's right edge.** A thin bright line ran down the right side of the console.

### Runtime

- **Added** — **`new Worker()` runs your files in a worker.** `new Worker(new URL("./w.ts", import.meta.url))` or `new
  Worker("./w.ts")` starts a project file with Bun's `argv`, `env` and `workerData` options, `postMessage` both ways
  with transfers, the `open`, `message`, `error` and `close` events and `terminate()`; inside, `self.postMessage` and
  `self.onmessage` talk to it. Before, it failed to load the file.
- **Added** — **The preview reaches a server a child process starts.** A script like `bun run dev` that starts `bun
  server.ts`, or a `Bun.spawn` of a server, now answers the preview instead of "No Bun.serve handler registered".
- **Added** — **`new Worker()` from `node:worker_threads` runs threads.** `workerData`, `parentPort`, `postMessage` with
  transfers, `terminate()`, `eval: true` and the `online`, `message`, `error` and `exit` events work as in Bun; before,
  the constructor threw.
- **Added** — **`spawnSync`, `execSync`, `execFileSync` and `Bun.spawnSync` work on runbun.dev.** They return the
  child's output (of any size), exit code and signal, and the files it wrote are there when they return. On a page that
  isn't cross-origin isolated, such as an embed whose host doesn't send COOP and COEP, they throw a `NotIsolatedError`
  that says so instead.
- **Changed** — **`Bun.spawn` and `Bun.spawnSync` refuse a string as stdin, as Bun does.** They threw nowhere else, so
  code that worked in the playground failed in Bun; pass bytes or a `Response` instead.
- **Fixed** — **Programs that start many processes keep running.** Past a dozen or so processes at once, a new one
  failed to start with "Out of memory: Cannot allocate Wasm memory" and its parent hung; now processes hold far less,
  and one that still can't start exits with code 1.
- **Fixed** — **A server on a port that's already served fails with EADDRINUSE.** A child process (or the program
  itself) starting a second server on a port the program already served got it without an error, and the preview kept
  going to the first.
- **Fixed** — **Proxies behave as in Bun.** `Bun.XML.stringify` treats a proxy of an array or a Date as an object, as
  Bun does, and `util.types.isProxy` recognizes proxies instead of always returning false.
- **Fixed** — **`Bun.markdown.ansi` lines up as in Bun.** Headings, wrapped lines and tables with keycaps, Devanagari,
  Hebrew, Hangul or zero-width characters measured those characters differently and came out misaligned.
- **Fixed** — **File errors print as in Bun.** An error from `fs.promises`, an fs callback or a `Bun.file` read prints
  as `[Error: ENOENT: ...]` with its properties in Bun's order, without a stack trace, and names the path you passed.
- **Fixed** — **`Bun.write` of a string or bytes is done when it returns.** Its promise prints `<resolved>` right after
  the call, as in Bun, instead of `<pending>`.
- **Fixed** — **Stack traces read as in Bun.** `error.stack` shows your files' paths, lines and columns and Bun's
  function names instead of the playground's internal URLs and transpiled lines, and an uncaught error from inside
  `JSON.parse` shows the source line that called it.
- **Fixed** — **Cookies scoped to a folder work in the preview.** A cookie a page's script sets under `/admin/`, and a
  script's changes to a cookie the server set for `/admin`, now reach the server; a closed tab's persistent cookies are
  cleared by the next preview, and an embed on another site keeps the server's cookies working.
- **Fixed** — **A `.cjs` or `.mjs` program runs as Bun runs it.** Run directly, a `.cjs` file without `require` or
  `module.exports` runs as CommonJS and an `.mjs` file that calls `require` as an ES module, as in Bun, instead of the
  other way round.

### Editor

- **Fixed** — **JSON files check against 2020-12 schemas.** A schema using `$dynamicRef` no longer puts a warning on
  every file, and what it points to is validated.
- **Fixed** — **SchemaStore `$schema` URLs load.** A JSON file naming `https://json.schemastore.org/…` got "Unable to
  load schema: Failed to fetch" instead of completions and checks.

### Docs

- **Added** — **The embedding guide shows four looks for one embed.** Fire, wind, earth and water each set a theme
  family, chrome colors for both schemes and a frame of their own, live and with the snippet to copy.
- **Added** — **The embedding guide shows a themed embed before it starts.** The four looks appear as posters too, with
  the properties that color the code and the Run button until a reader starts the embed.

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
- **Fixed** — **Imports of `file:` URLs load.** `import "file:///node_modules/…"` failed with "cannot resolve", so a
  Vite
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
