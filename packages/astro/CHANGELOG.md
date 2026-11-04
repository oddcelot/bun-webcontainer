# Changelog

Notable changes per release of `@runbun/astro`. Each release is tagged `astro-v<version>` and has a GitHub Release
with its section.

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
