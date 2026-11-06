---
title: runbun.dev vs online Bun compilers
description: "Online Bun compilers such as OneCompiler and codedamn send your code to a server that runs real Bun; runbun.dev runs Bun in your browser with no server. The trade-offs, and when to pick which."
head:
  - tag: title
    content: "runbun.dev vs online Bun compilers (OneCompiler, codedamn) | Run Bun"
sidebar:
  order: 2
  label: vs online compilers
---

Search for "Bun online" and you find multi-language online compilers with a Bun option, such as [OneCompiler](https://onecompiler.com/bun) and [codedamn](https://codedamn.com/online-compiler/bun). They run your code **on their servers**: codedamn says its Bun compiler "starts a docker container on a remote linux computer, set up with Bun". runbun.dev runs your code **in your browser**, with Bun's toolchain compiled to WebAssembly and its APIs as shims.

| | runbun.dev | Server-side online compilers |
|---|---|---|
| Where your code runs | In your browser tab | On the service's servers |
| Bun itself | Bun's toolchain, its APIs reimplemented for the browser | The real Bun binary |
| Every Bun API (`Bun.spawn`, sockets, `bun:ffi`) | No: only what a browser can do ([compatibility](/compatibility/)) | As far as the service allows |
| Your code leaves your machine | No ([privacy](/privacy/)) | Yes, to run it |
| `Bun.serve` apps | Served and previewed in the page, WebSockets included | Depends on the service |
| Projects, `bun install`, share links | Yes: several files, npm packages, the project in a link | Depends on the service |
| Browsers | Chrome, Edge, Firefox (Safari edit only) | Any |

The compilers' details are from their own pages, as of November 2026; each site has more on what it supports.

## Pick a server-side compiler when

- You need behavior only real Bun has: processes, raw sockets, `bun:ffi`, exact performance.
- You're on Safari or iOS and want to run code, not just edit it.

## Pick runbun.dev when

- Your code shouldn't leave your machine, or you want it to start instantly and keep working offline after the first visit.
- You're building a server: `Bun.serve` runs in the page, and the preview shows its responses and pages.
- You want a project of several files with npm packages, saved in your browser and shareable as one link.
