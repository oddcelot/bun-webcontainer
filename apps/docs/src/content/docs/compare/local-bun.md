---
title: runbun.dev vs installing Bun locally
description: "Installed Bun is the real runtime with every API; runbun.dev runs Bun in a browser tab with nothing to install, at the cost of the APIs a browser can't offer. When each makes sense, and how to move a project between them."
head:
  - tag: title
    content: "runbun.dev vs installing Bun locally: when a browser playground is enough | Run Bun"
sidebar:
  order: 3
  label: vs Bun installed locally
---

runbun.dev isn't a replacement for Bun. Installed Bun is the real runtime: JavaScriptCore, every API, native speed. runbun.dev is the quickest way to run Bun code when installing it isn't worth it, or isn't possible.

| | runbun.dev | Bun installed |
|---|---|---|
| Setup | Open a tab | [Install Bun](https://bun.com/docs/installation) on macOS, Linux or Windows |
| Engine | The browser's JavaScript engine | JavaScriptCore |
| APIs | Most of `Bun.*`, `bun:*` and `node:*` ([compatibility](/compatibility/)) | All of them |
| Processes, sockets, `bun:ffi`, native addons | No | Yes |
| Your files | A project saved in the browser, or a folder you open | Your disk |
| Sharing | A link carries the whole project | A repository or an archive |
| Runs on locked-down machines, Chromebooks | Yes, in Chrome | Where you can install software |

## Use runbun.dev for

- **Trying Bun**, or a Bun API, before installing anything.
- **Bug reproductions**: a [share link](/guides/agent-repro/) is a whole project in one URL, which anyone can run.
- **Teaching and docs**: examples that run where the reader is, [embedded](/guides/embedding/) in a page.

## Install Bun for

- **Real projects**: anything that spawns processes, talks to a database over TCP, or needs every API.
- **Performance**: benchmarks and heavy workloads mean nothing in a browser shim.

## Move a project between them

From the playground, **Download as zip** saves the project; unzip it, then `bun install` and `bun index.ts` (or `bun run dev`). The other way, open a folder from disk in the playground, or a GitHub repository with `runbun.dev/?repo=owner/repo`.
