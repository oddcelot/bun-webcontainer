# Changelog

Notable changes per release of `@runbun/embed`. Each release is tagged `embed-v<version>` and has a GitHub Release
with its section. The element talks to the playground deployed at runbun.dev over the embed protocol (version 1),
which only grows, so any release works with the live playground.

## 0.5.0 — 2026-11-15

Projects describe themselves in runbun.json: `pack` reads a project's card from it, and an embed changes layout in
place. runbun.dev's `embed.js` has both already. Nothing needs action to upgrade; `example.json` still works.

- **Added** — **`pack` reads cards from runbun.json.** A project folder can name and describe itself in its
  runbun.json instead of an example.json, which `pack` still reads.
- **Changed** — **Changing `layout` no longer reloads the embed.** The preview moves beside or under the editor in
  place, and `setLayout()` does the same from script.

## 0.4.0 — 2026-11-13

Embeds for teaching: a page can give an embed files of its own that the reader never sees, such as the tests a lesson
checks their code with, learn who changed a file, and get test results per file. A host can also bring its own example
library, and turn on Git. runbun.dev's `embed.js` has all of it already. Nothing needs action to upgrade.

- **Added** — **Embeds take files the page owns: `data-generated`.** Checks a `test()` runs stay out of the reader's
  tree and tabs, aren't saved with `persist`, and are written fresh on every load, so a saved project can't keep an old
  check.
- **Added** — **`test()` says which test files failed, and always settles.** The reply and the `test` event carry
  `results`, failed tests per file. A `test()` sent while a run, test or install is under way waits its turn instead
  of leaving Run busy, and Stop, a test hanging past 30 s or `process.exit` in a test end the run as failed instead of
  hanging or passing.
- **Added** — **`change` events say who changed the file.** `by` is "reader", "program" or "host", so a host can grade
  only the reader's edits, and a write that leaves a file as it was no longer sends one.
- **Added** — **`removeFile(path)` deletes a file from the host.** Its tab closes; a missing file rejects.
- **Added** — **Your own example library in an embed.** Point `library` at a JSON file of your projects (or put it
  inline) and readers get a gallery of just those, switching in place; `npx @runbun/embed pack` builds the file from a
  folder of examples.
- **Added** — **`git` feature.** `features="git"` (on in `full`) turns on the playground's Git panel and the `git`
  command; readers can switch it on from the ⋯ menu (1 MB on first use).

## 0.3.0 — 2026-11-05

Embeds take preset requests to try against their server. runbun.dev's `embed.js` has it already. Nothing needs action to
upgrade.

- **Added** — **List requests for an embed's preview.** `requests="GET /; POST /form {…}"` on `<bun-playground>` opens a
  preview tab per request, the first sent when the server starts and the others when opened.

## 0.2.0 — 2026-11-04

More control over how an embed looks and loads: a stacked layout, parts and a state to style and animate the poster's
switch to the playground, generated files kept out of the tabs, and tabs that close only in `full` mode. runbun.dev's
`embed.js` has all of it already. Nothing needs action to upgrade; an inline example that relied on closable tabs can
turn them back on with `features="close"`.

- **Added** — **Put the preview under the editor.** `layout="stack"` stacks the editor, preview and console in rows
  instead of columns; with `height="auto"` the editor fits its code.
- **Added** — **Animate the switch from poster to playground.** `::part(poster)`, `::part(frame)` and `::part(box)` with
  `bun-playground:state(live)` let a page crossfade the poster into the running embed and ease the height, where the
  poster used to disappear in one step.
- **Added** — **Style the Run button and the spinner from your page.** `bun-playground::part(play)` and
  `::part(spinner)` reach them, for styles the `--play-*` variables can't express.
- **Added** — **Hide generated files from the tabs.** An inline `<script type="text/plain" data-file="package.json"
  data-hidden>` is part of the project but doesn't open in the editor, so an example shows only its own code.
- **Added** — **Tabs close only where it makes sense.** The new `close` feature is on in `full` mode and off elsewhere,
  so an inline example keeps its tabs; `features="close"` or `-close` changes that.
- **Fixed** — **The page stays put under an expanded embed.** Scrolling over the modal's backdrop, or past the end of
  the embed, no longer scrolls the page behind it.

## 0.1.1 — 2026-11-03

A fix for short code blocks: their poster now fits the code, so the Run button sits on the block. runbun.dev's
`embed.js` has it already. Nothing needs action to upgrade.

- **Fixed** — **The Run button stays on a short block.** A one- or two-line block's poster no longer gets a strip of
  empty space below it, with the Run button sitting outside the code.

## 0.1.0 — 2026-11-03

The first release on npm of the `<bun-playground>` element that runbun.dev serves as `embed.js`, with the types of its
API and of the postMessage protocol.

- **Added** — **`<bun-playground>` from npm.** `import "@runbun/embed"` registers `<bun-playground>` and
  `<bun-playground-defaults>`, framing runbun.dev; `define({ src })` from `@runbun/embed/element` frames another
  playground, such as a local dev server. `@runbun/embed/protocol` has the message types for talking to the iframe
  directly.
