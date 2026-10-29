---
title: Overview
description: What the playground is and how it runs your code.
sidebar:
  order: 1
---

The playground runs a Bun project entirely in your browser:

- **Bun's own code, compiled to wasm64.** The transpiler, resolver and semver come from Bun's JSC-independent Rust crates, built for Memory64.
- **JS shims for the runtime.** `Bun.*`, `bun:*` and `node:*` APIs are implemented in JavaScript on top of the browser's engine.
- **A virtual file system.** Your project lives in memory and is saved to the browser's storage.
- **A service worker** serves your modules and the preview of `Bun.serve` and `node:http` servers.
