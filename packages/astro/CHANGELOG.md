# Changelog

Notable changes per release of `@runbun/astro`. Each release is tagged `astro-v<version>` and has a GitHub Release
with its section.

## 0.1.0 — 2026-11-03

The first release: code blocks for Astro 7, highlighted at build time with `@pierre/highlights`, that turn into a
runnable Bun playground on runbun.dev when a reader clicks Run.

- **Added** — **`<Code>` and ` ```ts playground ` fences.** The `runbun()` integration and the `remarkRunbun` plugin
  highlight code blocks at build time; `<Code playground>`, or `playground` on a Markdown fence, adds a Run button
  that opens the code in an embedded playground.
