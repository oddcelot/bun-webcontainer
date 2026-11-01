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
| `path` | URL path | `/` | What the preview requests first, e.g. `/user/123`. |
| `autorun` | `true`, `false` | `true`, except in `full` | Run once loaded, after installing any missing packages. |
| `theme` | `auto`, `light`, `dark`, or a theme family's light variant | `auto` | The color mode. e.g. `dark`. |
| `family` | a theme family's light variant | none | e.g. `github-light`. Picks both halves of the family without changing the color mode, so `theme` can follow your page. |
| `fonts` | stylesheet URLs, whitespace-separated | none | Loaded inside the embed, for the fonts `--font-ui` and `--font-mono` name. |
| `vars` | JSON object | none | Chrome CSS variables to set on top of the theme's. Element only; see [Theming](#theming). |
| `readonly` | boolean | `false` | The editor takes no edits. Run still works. |
| `persist` | key | none | Keeps edits in the reader's browser under this key. Without it every load starts from the source. |
| `expand` | empty, a mode, `false` | none | A button that opens the embed in a modal over the page. With a mode (`expand="full"`) it switches to that mode while open. Escape or the button closes it. |
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
| `setFamily(theme)` | a theme family's light variant | picks both halves without changing the color mode |
| `setVars(vars)` | a `vars` object | sets the chrome's CSS variables |
| `getShareUrl()` | | the share link as a string |
| `activate()` | | Starts an embed waiting for `load="click"` or `visible`. |
| `expand()` | | Opens the modal (works without the `expand` button too). |
| `collapse()` | | Puts the embed back in the page. |

`el.expanded` is true while the modal is open.

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
| `expand` | `{ open }`: on the element, the modal opened or closed. Over postMessage, the reader pressed the expand button (or Escape while open); the host opens or closes its modal and answers with `setExpanded` |
| `boot` | `{ version }`: postMessage only; see below |

## postMessage protocol

Use this with a bare iframe. Every message in either direction is an object with the key `bunPlayground: 1`. Others are ignored.

Host to embed:

```js
iframe.contentWindow.postMessage({ bunPlayground: 1, id: 1, method: "writeFile", params: { path: "index.ts", text: "…" } }, "https://runbun.dev");
```

The embed answers with the same `id`: `{ bunPlayground: 1, id: 1, result }` or `{ bunPlayground: 1, id: 1, error: "message" }`. Methods and params are those above, plus `init` and `setExpanded` (`{ open }`: tell the embed the host's modal opened or closed, so it switches mode and its button follows).

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

`files` maps paths to text. `options` takes `mode`, `features`, `file`, `path`, `autorun`, `theme`, `family`, `fonts`, `readonly` and `persist`. `vars` takes the object described under [Theming](#theming). Without `?init=1`, the page loads from its URL and `init` isn't needed; `setFamily` and `setVars` change both afterwards.

## Theming

A theme family (`theme`'s variant or `family`) colors the editor and the app chrome. `vars` overrides chrome values on top of the theme, as an object with `base` (both schemes) and optionally `light` or `dark`:

```json
{
  "base": { "--accent": "#ff5a5f", "--radius": "1rem" },
  "light": { "--bg": "#ffffff" },
  "dark": { "--bg": "#171723" }
}
```

Names and values are CSS custom properties; anything that isn't a `--name` with a string value is ignored. The chrome variables are:

| Name | What |
|---|---|
| `--bg` | The code surface |
| `--canvas` | Behind the panes |
| `--panel` | The bar, tabs and file tree |
| `--fg` | Text |
| `--muted` | Secondary text |
| `--border` | Lines between panes |
| `--accent` | Selection, focus rings, the Run button |
| `--error`, `--warn`, `--info`, `--ok` | Status colors |
| `--radius`, `--pad` | A pane's corner and the space inside it |
| `--font-ui`, `--font-mono` | The UI and code fonts; load them with `fonts` |
| `--control`, `--control-hover`, `--control-border` | Buttons and inputs |

Others in `style.css` work too, but these are the ones a page usually wants to match its own design. To follow a page's light and dark themes, send `base` for the scheme in effect and update it (with `setVars`) when the page changes.

To draw over the embed (a border, a glow), style `bun-playground::part(overlay)`: an empty layer covering the poster and the frame, in the modal too, that lets clicks through.

The poster (shown until the embed is ready) is styled by CSS custom properties set on `<bun-playground>` or an ancestor:

| Name | What | Default |
|---|---|---|
| `--poster-bg`, `--poster-fg` | The poster's background and text | `Canvas`, `CanvasText` |
| `--font-mono` | The default poster's code font (`load="click"` without a `slot="poster"`) | `ui-monospace`, … |
| `--play-bg`, `--play-fg` | The Run button's background and text | `ButtonFace`, `ButtonText` |
| `--play-border`, `--play-radius`, `--play-font` | The Run button's border color, corner radius and font | `GrayText`, `6px`, inherited |

## Versioning

This is version 1. Changes only add: new methods, events, options, features and fields. Nothing is renamed or removed within a version. Ignore message keys and events you don't know; the embed does the same.
