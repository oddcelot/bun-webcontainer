---
title: Reproduce a bug with an agent
description: Let a coding agent write a minimal reproduction and hand you a runbun.dev link to post in an issue.
sidebar:
  order: 7
---

A playground link carries the whole project in its URL, so a reproduction is one link: whoever opens it gets the same files, installs the same packages and sees the same output. A coding agent (Claude Code, Codex, Cursor and the like) can write that link for you. It doesn't need an account or an upload, because the files never leave the URL.

## Ask your agent

Paste something like this, with the bug filled in:

```text
Make a minimal reproduction of this bug as a runbun.dev link:
<what happens, and what you expected>

Read https://runbun.dev/llms.txt first: it explains the link format.
Keep it to the fewest files that still show the bug. Log what you
expected next to what you got. Give me the link and the files.
```

The agent writes the files, packs them into a link and gives it back. Open it: the playground installs the dependencies and runs the entry file, and the console shows the output. If it shows the bug, post the link.

## Let the agent check it

An agent that can drive a browser can check the link before you see it. With a browser tool such as [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), add to the prompt:

```text
Open the link in Chrome, wait for the run to finish and read the
console. If it doesn't show the bug, change the files and try again.
```

Use Chrome, Edge or Firefox; Safari can open the link but not run it (see [Browsers](/compatibility/browsers/)). The console is the panel at the bottom of the playground; a project with `Bun.serve` also shows its response in the preview.

## The link format

For agents and scripts that build links themselves:

```
https://runbun.dev/#code=<base64url(deflate-raw(JSON))>
```

The JSON is `{ "v": 1, "files": { "<path>": "<text>" } }`, with paths relative to the project root (`index.ts`, `src/db.ts`, `package.json`). In Bun or Node:

```ts
import { deflateRawSync } from "node:zlib";

const files = {
  "index.ts": `console.log(Bun.version);\n`,
};
const hash = deflateRawSync(JSON.stringify({ v: 1, files })).toString("base64url");
console.log(`https://runbun.dev/#code=${hash}`);
```

- **Entry file:** Run starts `package.json`'s `module` or `main`, or the file its `dev` or `start` script runs with `bun`, else the first of `index.ts`, `index.tsx`, `index.js` and `src/index.ts`.
- **Dependencies:** list them in `package.json`; the link installs them from npm when it opens. Leave out `bun.lock` unless the bug depends on exact versions.
- **Text files only.** Binary files can't travel in a link. Leave out secrets: a link is as public as wherever you post it.
- **Length:** some chat apps cut links off past about 32 KB. GitHub issues take longer ones. A project that big is rarely minimal; otherwise put it in a public GitHub repo and link `https://runbun.dev/?repo=<owner>/<repo>` instead.

Before blaming Bun, check the [compatibility pages](/compatibility/): the playground runs your code in the browser's JavaScript engine, so an API marked Partial, Stub or Missing there behaves differently than in Bun itself.
