---
title: Use cases
description: "What to use the runbun.dev playground for and what to start from: trying a Bun API, building a small server, a database prototype, a bug reproduction, runnable examples in your docs, and when to use real Bun instead."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Bun playground use cases and what to start from | Run Bun"
sidebar:
  order: 1
---

Find what you want to do, and start from the recommendation beside it. Each row has a section below with more.

| You want to | Start from | Good to know |
|---|---|---|
| [Try Bun or one of its APIs](#try-bun-or-one-of-its-apis) | The **Blank** starter, or an [example](/examples/) | Nothing to install, no account |
| [Build a small server or API](#build-a-small-server-or-api) | The **HTTP API** starter, [Elysia](https://runbun.dev/?example=elysia-demo) or [Hono](https://runbun.dev/?example=hono) | The preview sends any request |
| [Build a page or a frontend](#build-a-page-or-a-frontend) | The **React** starter, or [Vite](https://runbun.dev/?example=vite-demo) | The fast path skips the install |
| [Prototype with a database](#prototype-with-a-database) | The **SQLite** starter | SQLite and Postgres run in the tab |
| [Share a bug reproduction](#share-a-bug-reproduction) | Your project's **Share** link | The link is the whole project |
| [Put runnable examples in your docs](#put-runnable-examples-in-your-docs) | The [embed configurator](/guides/configurator/) | One script tag, or an Astro integration |
| [Teach a class or run a workshop](#teach-a-class-or-run-a-workshop) | A share link or a `?repo=` link | Everyone runs the same project |
| [Check a package or a framework](#check-a-package-or-a-framework) | The [frameworks](/compatibility/frameworks/) list | Native bindings are what usually fails |
| [Use an API a browser doesn't have](#when-you-need-real-bun) | [Local Bun](/guides/local-bun/) | The same editor, real Bun underneath |

The starters and examples are in the project gallery: the project button in the playground's header.

## Try Bun or one of its APIs

Open [runbun.dev](https://runbun.dev/), pick the **Blank** starter and press Run. For one API, the [examples](/examples/) each have a short program you can run and edit on the page: `Bun.serve`, `bun:sqlite`, `Bun.file`, `Bun.password` and `Bun.$`.

Recommended:

- Check the API in [Bun APIs](/compatibility/bun/) or [Node built-ins](/compatibility/node/) first. Each one is marked Works, Partial, Stub or Missing.
- Use the console for `bun test`, `bun add` and shell lines. See [Console](/playground/console/).

## Build a small server or API

`Bun.serve` runs in the page and the [preview](/playground/preview/) shows what it answers. Start from the **HTTP API** starter for plain `Bun.serve`, or from [Elysia](https://runbun.dev/?example=elysia-demo) or [Hono](https://runbun.dev/?example=hono) for a framework. For WebSockets, the **WebSocket chat** starter has a server and a page that talk to each other.

Recommended:

- Use the preview's request bar to send a method, headers and a body, without leaving the tab.
- Turn on Watch, so a save restarts the server. See [Running code](/playground/running-code/).
- Keep the requests a reader should try in [`runbun.json`](/guides/project-config/), so they open with the project.

Servers answer the preview, not the network: nobody else can reach them.

## Build a page or a frontend

Start from the **React** starter. A project with an `index.html` and no Bun or Node APIs can use the [fast path](/playground/fast-path/), which shows the page without `bun install`. For a dev server with HMR, start from [Vite](https://runbun.dev/?example=vite-demo) or [Astro + Solid](https://runbun.dev/?example=astro-solid-demo).

Recommended:

- Try the fast path first for a page that only needs a few npm packages. It is experimental, and loads them from esm.sh.
- Use Vite when you need its plugins or its config.

## Prototype with a database

`bun:sqlite` needs no package and runs in the tab: start from the **SQLite** starter or the [bun:sqlite example](/examples/bun-sqlite/). `Bun.sql` runs Postgres in the tab too, on PGlite, kept in the project's browser storage.

Recommended:

- Use SQLite for a quick schema or query. Use `Bun.sql` when the code must be Postgres.
- For a database over the network (a hosted Postgres, Redis), use [Local Bun](/guides/local-bun/): a browser can't open those connections.

## Share a bug reproduction

The **Share** menu copies a link that carries the whole project in its URL. Nothing is uploaded, and whoever opens it runs the same files. Paste it in an issue.

Recommended:

- Let a coding agent write the reproduction and hand you the link. [Reproduce a bug with an agent](/guides/agent-repro/) has a prompt to paste.
- Keep it small: one file and the fewest packages that still show the bug.
- If the bug is in Bun itself, confirm it with real Bun as well. The playground runs your code in the browser's engine, so a difference may be the playground's.

## Put runnable examples in your docs

The [`<bun-playground>` element](/guides/embedding/) turns a code block into one that runs in the reader's browser. In an Astro site, [`@runbun/astro`](/guides/astro/) does it from a Markdown fence. The [configurator](/guides/configurator/) builds the snippet for you.

Recommended modes:

| The example is | Mode |
|---|---|
| A snippet that prints something | `code` |
| A server or a page | `preview` |
| A test file, or something run with a command | `console` |
| A finished demo, where the code is secondary | `result` |
| A whole project to explore | `full` |

- Prefer the lighter modes. `full` loads the most and waits for Run.
- Readers on Safari and iOS can read and edit but not run. See [Browsers](/compatibility/browsers/).

## Teach a class or run a workshop

Everyone opens one link and has the same project, with no install and no account. Use a share link for a small exercise, or `runbun.dev/?repo=owner/repo` for a repository on GitHub. Each person's edits stay in their own browser.

Recommended:

- Ask for Chrome, Edge or Firefox. See [Browsers](/compatibility/browsers/) for the versions.
- Have people open the link once before the session: after the first visit the playground works offline, except for installing packages.
- Collect answers as share links.

## Check a package or a framework

`bun install` fetches packages from npm, so the quick test is to add the package and run it. [Frameworks](/compatibility/frameworks/) lists what is known to run, each with a link that opens it.

Recommended:

- Read [what usually blocks a framework](/compatibility/frameworks/#what-usually-blocks-a-framework) before a long attempt: native bindings without a wasm fallback, install scripts, and tools that spawn other programs.
- If a framework's CLI doesn't start, start its dev server from a file instead.

## When you need real Bun

Some things a browser can't do: start other programs, open raw sockets, load native addons. Benchmarks mean nothing here either.

Recommended:

- Keep the playground and run with Bun on your machine: `bunx @runbun/connect --open`. See [Run with local Bun](/guides/local-bun/).
- For a real project, install Bun. **Download as zip** takes the project with you. See [runbun.dev vs installing Bun locally](/compare/local-bun/).
- For Node with npm, pnpm or yarn in the browser, see [runbun.dev vs StackBlitz WebContainers](/compare/webcontainers/).
