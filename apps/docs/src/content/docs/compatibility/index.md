---
title: How to read these pages
description: What the status labels mean and how the compatibility pages are checked.
sidebar:
  order: 0
  label: Overview
---

The playground runs your code in the browser's JavaScript engine, not in Bun. Bun's transpiler, resolver, semver and bundler run as WebAssembly. Everything else (`Bun.*`, `bun:*`, `node:*`) is a JavaScript shim, so coverage is uneven. These pages list what works today.

| Label | Meaning |
|---|---|
| ✅ Works | Behaves like Bun for normal use. |
| 🟡 Partial | The common parts work; the notes list what's missing. |
| ⚪ Stub | Imports fine, but its functions throw or do nothing. |
| ❌ Missing | Not available. Importing it fails, or the property is `undefined`. |
| ❔ Untested | Expected to work, but not checked yet. |

Sections:

- [Browsers](/compatibility/browsers/): which browsers run the playground.
- [Bun APIs](/compatibility/bun/): the `Bun` global, `bun:sqlite`, `bun:test`, `import.meta`.
- [Node built-ins](/compatibility/node/): every `node:*` module.
- [Toolchain](/compatibility/toolchain/): transpiler, module resolution, CommonJS, `bun install`, the bundler.
- [Frameworks](/compatibility/frameworks/): projects known to run.

The status comes from reading the playground's source and from the bundled examples, checked in Chrome. Found something wrong? [Open an issue](https://github.com/oddcelot/bun-webcontainer/issues).
