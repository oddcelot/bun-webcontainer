---
title: Embed API
description: Attributes, features, methods, events and the postMessage protocol of the embed.
sidebar:
  order: 1
---

Version 1. For how to use it, see [Embedding](/guides/embedding/). The element comes from `https://runbun.dev/embed.js`; the page it wraps is `https://runbun.dev/embed`.

## Attributes and URL parameters

The element's attributes and the iframe's URL parameters share names.

| Name | Values | Default | Notes |
|---|---|---|---|
| `mode` | `code`, `preview`, `console`, `full`, `result` | `code` | Which panes show. See [Features](#features). |
| `features` | comma list | none | Added to the mode's features. `-name` turns one off and locks it. |
| `file` | path | the entry file | The file opened first. |
| `autorun` | `true`, `false` | `true`, except in `full` | Run once loaded, after installing any missing packages. |
| `theme` | `auto`, `light`, `dark`, or a theme family's light variant | `auto` | e.g. `github-light`. |
| `readonly` | boolean | `false` | The editor takes no edits. Run still works. |
| `persist` | key | none | Keeps edits in the reader's browser under this key. Without it every load starts from the source. |
| `example` | name | none | A bundled example. |
| `repo` | `owner/repo[@ref]` | none | A public GitHub repo. |
| `share` | `#code=…` | none | A share link's hash. In an iframe URL put it after `#`. |
| `load` | `eager`, `visible`, `click` | `visible` | Element only. When the embed starts. |
| `height` | CSS length, `auto` | `code`: `auto`; `console`: `360px`; `preview`: `420px`; `full`: `600px`; `result`: `420px` | Element only. |
| `src` | URL | where `embed.js` came from | Element only. Another playground base URL. |
| `title` | text | none | The iframe's title, for assistive technology. |

A boolean is on unless it is `false` or `0`. Unknown or malformed values fall back to the default.

Inline files: child `<script type="text/plain" data-file="path">` elements, dedented. Poster: children with `slot="poster"`, shown until the embed is ready; with `load="click"` a click on them starts it.

## Features

`mode` picks a preset; `features` adjusts it.

| Name | What | On in | Cost |
|---|---|---|---|
| `files` | File tree | `full` | |
| `tabs` | Tab bar for open files | `preview`, `full` | |
| `console` | Console output | `code`, `console`, `full` | |
| `preview` | Preview of a server | `preview`, `full`, `result` | |
| `types` | Type errors, hover and completions | none | 12 MB on first use |
| `format` | Format button (`bun fmt`) | `full` | 9 MB on first use |
| `install` | Install button | `preview`, `full` | |
| `terminal` | Interactive terminal | `console`, `full` | |
| `open` | "Open in runbun.dev" | all | |

Readers can switch features on or off from the **⋯** menu, except those you locked with `-name`.

## Methods

On the element, each returns a promise. Call them after `await el.ready`.

| Method | Params | Result |
|---|---|---|
| `run(entry?)` | file to start instead of the entry | resolves when started |
| `stop()` | | |
| `install()` | | resolves when done |
| `test(files?)` | file paths | `{ failed }` |
| `readFile(path)` | path | the file's text (bytes for a binary file) |
| `writeFile(path, text)` | path, text | |
| `listFiles()` | | array of paths |
| `openFile(path)` | path | |
| `setMode(mode)` | a mode | |
| `setFeatures(obj)` | `{ types: true, format: false }` | |
| `setTheme(theme)` | a theme | |
| `getShareUrl()` | | the share link as a string |
| `activate()` | | Starts an embed waiting for `load="click"` or `visible`. |

`el.ready` resolves once the embed has sent `ready` (or `unsupported`); read the data from the `bun-playground:ready` event. Requests sent earlier wait until the project has loaded.

## Events

On the element they are DOM events named `bun-playground:<event>`, with the data as `detail`. Over postMessage they have the same names without the prefix.

| Event | Data |
|---|---|
| `ready` | `{ version, bun, canRun, mode, features }` |
| `unsupported` | `{ checks: { name, ok, why }[] }`: the browser lacks something, so nothing runs; the code still shows and edits |
| `status` | `{ state: "idle" \| "busy" \| "running" \| "error", text }` |
| `console` | `{ level, text }` |
| `change` | `{ path, removed }` |
| `test` | `{ failed }` |
| `mode` | `{ mode, features }`: after `setMode`, `setFeatures` or the reader's menu |
| `resize` | `{ height }`: the content's height in pixels, for iframes |
| `boot` | `{ version }`: postMessage only; see below |

## postMessage protocol

Use this with a bare iframe. Every message in either direction is an object with the key `bunPlayground: 1`. Others are ignored.

Host to embed:

```js
iframe.contentWindow.postMessage({ bunPlayground: 1, id: 1, method: "writeFile", params: { path: "index.ts", text: "…" } }, "https://runbun.dev");
```

The embed answers with the same `id`: `{ bunPlayground: 1, id: 1, result }` or `{ bunPlayground: 1, id: 1, error: "message" }`. Methods and params are those above, plus `init`.

Embed to host, unsolicited:

```js
{ bunPlayground: 1, event: "ready", data: { version: 1, bun: "…", canRun: true, mode: "code", features: ["console", "open"] } }
```

### Handshake

With `?init=1` in its URL, the page sends `boot` as soon as it listens, then waits for an `init` request before loading a project (the element always works this way):

```js
window.addEventListener("message", (e) => {
  if (e.data?.bunPlayground === 1 && e.data.event === "boot") {
    iframe.contentWindow.postMessage(
      { bunPlayground: 1, id: 1, method: "init", params: { files: { "index.ts": "console.log(1)" }, options: { mode: "code", readonly: true } } },
      "https://runbun.dev",
    );
  }
});
```

`files` maps paths to text. `options` takes `mode`, `features`, `file`, `autorun`, `theme`, `readonly` and `persist`. Without `?init=1`, the page loads from its URL and `init` isn't needed.

## Versioning

This is version 1. Changes only add: new methods, events, options, features and fields. Nothing is renamed or removed within a version. Ignore message keys and events you don't know; the embed does the same.
