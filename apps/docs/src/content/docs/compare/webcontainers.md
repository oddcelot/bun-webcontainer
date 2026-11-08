---
title: runbun.dev vs StackBlitz WebContainers
description: "runbun.dev and StackBlitz WebContainers both run code in a browser tab with no server. WebContainers run Node.js with npm, pnpm and yarn; runbun.dev runs Bun's APIs and toolchain. When to pick which."
head:
  - tag: title
    content: "runbun.dev vs StackBlitz WebContainers: Bun or Node.js in the browser | Run Bun"
sidebar:
  order: 1
  label: vs WebContainers
---

Both run your code inside the browser tab, with no remote machine behind it. The difference is the runtime: [WebContainers](https://webcontainers.io/) describe themselves as "a browser-based runtime for executing Node.js applications and operating system commands", while runbun.dev runs **Bun**: Bun's transpiler, resolver and bundler compiled to WebAssembly, and Bun's APIs as shims.

| | runbun.dev | StackBlitz WebContainers |
|---|---|---|
| Runtime | Bun: `Bun.*`, `bun:*`, plus `node:*` built-ins | Node.js |
| Package manager | `bun install` | npm, pnpm and yarn |
| `Bun.serve`, `bun:sqlite`, `Bun.file` | Yes ([compatibility](/compatibility/)) | Not documented |
| Shell and child processes | No: no `Bun.spawn` or `Bun.$` | Yes: runs operating system commands |
| Chrome, Edge | Chrome and Edge 133+ | Fully supported |
| Firefox | Firefox 134+ | Alpha |
| Safari | Edit only, until Safari ships WebAssembly Memory64 | Beta, from Safari 16.4 |
| Put it in your own page | [`<bun-playground>` element or iframe](/guides/embedding/), free | WebContainer API; a license for commercial production use |

Project code on runbun.dev runs on its own origin, run.runbun.dev, apart from the editor, so a program you run can't read your saved projects, folder access or the Local Bun token.

WebContainers' details are from [their introduction](https://webcontainers.io/guides/introduction), [browser support](https://webcontainers.io/guides/browser-support) and [licensing](https://webcontainers.io/enterprise) pages, as of November 2026.

## Pick WebContainers when

- Your project targets **Node.js**, or needs npm, pnpm or yarn specifically.
- You need a **shell**, child processes, or tools that spawn other programs.
- You want Safari support today.

## Pick runbun.dev when

- Your code uses **Bun's APIs**: `Bun.serve`, `Bun.file`, `bun:sqlite`, `Bun.password`, `bun test`.
- You want Bun's own behavior: its transpiler, its module resolution, `Bun.build` with Bun's bundler.
- You want a runnable Bun example in docs or a blog post, with no license to sort out.

Neither is the real thing: a browser has no raw sockets and no native addons, so both reimplement parts of their runtime. Check [what works](/compatibility/) before you port a project.
