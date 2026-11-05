# Changelog

Notable changes per release of `@runbun/astro`. Each release is tagged `astro-v<version>` and has a GitHub Release
with its section.

## 0.3.0 — 2026-11-05

Static code blocks catch up with Expressive Code: with `fences: "all"` every fence renders as a runbun block, with
marked lines, numbered notes and tabbed groups. Playground fences take preset requests, and can show the responses you
wrote before a reader clicks Run. Nothing needs action to upgrade; a playground fence whose first line is a file-name
comment now uses it as the file name.

- **Added** — **Render every fence as a runbun block.** With `runbun({ fences: "all" })`, fences without `playground`
  become static, highlighted blocks with a Copy button, and a file-name comment such as `// server.ts` becomes the
  title. Fences with other meta (`ins=`, `{5}`, …), shell languages, or `runbun=false` stay with the site's own
  highlighter.
- **Added** — **Mark lines in code blocks.** Fences in `fences: "all"` mode take `{1,4-6}`, `mark={…}`, `ins={…}` and
  `del={…}`, and `<Code>` takes `mark`, `ins` and `del` (`"1,4-6"`): marked lines get a background, added and removed
  ones a `+` or `−` in the gutter, and Copy still gets the code as written. `--runbun-mark-bg`, `--runbun-ins-bg` and
  `--runbun-del-bg` set the colors.
- **Added** — **Annotate code with numbered notes.** In `fences: "all"` mode, a `// (1)` comment at a line's end (`#
(1)`, `<!-- (1) -->`, as the language comments) and an ordered list after the fence turn into a numbered button that
  opens its note next to the line; `<Code notes>` does the same with plain-text notes. Copy gets the code without the
  markers, and a browser without popovers shows the list.
- **Added** — **Group fences into tabs.** In `fences: "all"` mode, consecutive fences with the same `group=<name>` show
  as one block with a tab per fence, named by each fence's title or file-name comment. Tabbed blocks on a page no longer
  risk unchecking each other's tabs after a cached rebuild.
- **Added** — **Preset requests in playground fences.** `requests='GET /; POST /form {"hello":"Elysia"}'` in a fence's
  meta, or `requests` on `<Playground>` and `<Code playground>`, gives the preview a tab per request to try.
- **Added** — **Show responses before Run.** `requests='GET / => Hello Elysia; POST /form {"a":1} => {"a":1}'` in a
  playground fence, or on `<Playground>` and `<Code playground>`, shows a tab per request with the response you wrote
  under the code, so readers see answers without running anything; Run opens the live embed with the same requests.
- **Changed** — **A playground fence's file-name comment names its file.** A first line like `// index.ts` (or
  `//package.json` in a JSON fence) now names the fence's file and leaves the code, as in static fences and Expressive
  Code, so a group needs no `title=` on each fence.
- **Changed** — **The request panel before Run looks like the one after.** Its tabs, method badges and focus ring match
  the live preview's, a request's answer is labelled "Response" under its body, and the Run button no longer covers the
  text.
- **Fixed** — **Request presets with `-H` headers show them apart from the body.** Before Run, a request tab showed `-H
"Authorization: …"` as part of the request body; the headers now get their own block.

## 0.2.0 — 2026-11-04

Fences and `<Code>` blocks take more of the embed's options: a starting path, pinned packages, a stacked layout, an
accessible name and hidden files in a group. Every code block gets a Copy button and says its language. Nothing needs
action to upgrade.

- **Added** — **Copy a code block's source.** Code blocks and playground posters have a Copy button (on hover or focus,
  always on touch screens), styled with `--runbun-copy-bg`, `--runbun-copy-fg`, `--runbun-copy-border` and
  `--runbun-copy-radius`.
- **Added** — **Pin a fence's packages without a package.json tab.** `deps="elysia@rc,@elysia/openapi@rc,zod@^4"` in a
  playground fence's meta installs those versions; a name without a version gets `latest`.
- **Added** — **Open a server example at a path.** `<Playground path="/user/123">`, `<Code playground path=…>` and a
  fence's `path="/user/123"` meta make the preview request that path first instead of `/`.
- **Added** — **Stack a fence's preview under its code.** `layout=stack` in a playground fence's meta, or
  `layout="stack"` on `<Code>` and `<Playground>`, puts the preview under the editor instead of beside it.
- **Added** — **Hide a fence of a playground group.** `hidden` in a fence's meta keeps that file, such as a package.json
  pinning versions, in the embed but out of the code block and its tabs.
- **Added** — **Give a fence's or `<Code>`'s embed its own accessible name.** `label="Elysia playground"` becomes the
  embed frame's title, where every embed used to be announced as "Bun playground".
- **Added** — **Code blocks say their language.** Each block's `<pre>` carries `data-language` (`ts`, `json`, …), as
  Expressive Code's does, so tools that convert the page back to Markdown keep the fence's language.

## 0.1.1 — 2026-11-03

Static code blocks get lighter: their styles go into the page's own stylesheet, so a page of `<Code>` blocks loads
nothing for them beyond its HTML and CSS. Nothing needs action to upgrade.

- **Changed** — **A static `<Code>` block needs no request of its own.** Its styles go into the page's stylesheet,
  once per page, instead of a link to `/_runbun/highlights.css` for every block. ` ```ts playground ` fences in MDX
  share that copy; in plain Markdown they keep the link.

## 0.1.0 — 2026-11-03

The first release: code blocks for Astro 7, highlighted at build time with `@pierre/highlights`, that turn into a
runnable Bun playground on runbun.dev when a reader clicks Run.

- **Added** — **`<Code>` and ` ```ts playground ` fences.** The `runbun()` integration and the `remarkRunbun` plugin
  highlight code blocks at build time; `<Code playground>`, or `playground` on a Markdown fence, adds a Run button
  that opens the code in an embedded playground.
