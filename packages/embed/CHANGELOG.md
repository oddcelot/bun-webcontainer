# Changelog

Notable changes per release of `@runbun/embed`. Each release is tagged `embed-v<version>` and has a GitHub Release
with its section. The element talks to the playground deployed at runbun.dev over the embed protocol (version 1),
which only grows, so any release works with the live playground.

## 0.1.0 — 2026-11-03

The first release on npm of the `<bun-playground>` element that runbun.dev serves as `embed.js`, with the types of its
API and of the postMessage protocol.

- **Added** — **`<bun-playground>` from npm.** `import "@runbun/embed"` registers `<bun-playground>` and
  `<bun-playground-defaults>`, framing runbun.dev; `define({ src })` from `@runbun/embed/element` frames another
  playground, such as a local dev server. `@runbun/embed/protocol` has the message types for talking to the iframe
  directly.
