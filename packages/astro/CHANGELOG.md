# Changelog

Notable changes per release of `@runbun/astro`. Each release is tagged `astro-v<version>` and has a GitHub Release
with its section.

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
