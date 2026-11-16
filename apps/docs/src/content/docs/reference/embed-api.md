---
title: Embed API
description: "Reference for the <bun-playground> embed and its iframe: attributes, features, methods, events, theming and the postMessage protocol."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "bun-playground embed API reference | Run Bun"
sidebar:
  order: 1
---

Version 1. For how to use it, see [Embedding](/guides/embedding/). The element comes from `https://runbun.dev/embed.js`, or from npm as `@runbun/embed` (with the types of everything below); the page it wraps is `https://runbun.dev/embed`.

## Attributes and URL parameters

The element's attributes and the iframe's URL parameters share names.

| Name | Values | Default | Notes |
|---|---|---|---|
| `mode` | `code`, `preview`, `console`, `full`, `result` | `code` | Which panes show. See [Features](#features). |
| `features` | comma list | none | Added to the mode's features. `-name` turns one off and locks it. |
| `file` | path | the entry file | The file opened first. |
| `path` | URL path | `/` | What the preview requests first, e.g. `/user/123`. |
| `requests` | `;`-separated `METHOD /path [-H "Name: value"…] [body]` | none | Requests a reader can try, each in its own preview tab, in order, the first active, e.g. `requests='GET /user/1; GET /user/617; POST /form {"hello":"Elysia"}'` (single quotes keep a JSON body's double quotes). An entry is an uppercase method, a path from `/` to the next space, optionally headers, each `-H` and a quoted `Name: value` as in curl (`GET /me -H "Authorization: Bearer demo"`), and optionally a body, sent as the request bar sends one (`application/json` when it parses as JSON, else `text/plain`). A `;` ends an entry only where an uppercase method and ` /` follow, so a body may hold `;`. The first request goes when the server starts, as `path`'s does; each other one the first time its tab opens while the server runs (a tab showing when the server comes up goes then). After that the tabs work as usual, and a tab isn't sent again by opening it. Malformed entries are skipped. Wins over `path`. The attribute takes requests only: the `=> response` form is the [Astro integration's](/guides/astro/), which shows written responses before Run and passes the requests alone to the embed. |
| `autorun` | `true`, `false` | `true`, except in `full` | Run once loaded, after installing any missing packages. |
| `theme` | `auto`, `light`, `dark`, or a theme family's light variant | `auto` | The color mode. e.g. `dark`. |
| `family` | a theme family's light variant | none | e.g. `github-light`. Picks both halves of the family without changing the color mode, so `theme` can follow your page. |
| `fonts` | stylesheet URLs, whitespace-separated | none | Loaded inside the embed, for the fonts `--font-ui` and `--font-mono` name. |
| `vars` | JSON object | none | Chrome CSS variables to set on top of the theme's. Element only; see [Theming](#theming). |
| `readonly` | boolean | `false` | The editor takes no edits. Run still works. |
| `persist` | key | none | Keeps edits in the reader's browser under this key. Without it every load starts from the source. |
| `expand` | empty, a mode, `false` | none | A button that opens the embed in a modal over the page. With a mode (`expand="full"`) it switches to that mode while open, with that mode's features plus your `features` (so `types` stays on, `-name` stays locked). While it's open the page behind is inert (no clicks, no focus) and doesn't scroll, and scrolling inside the embed doesn't carry over to it. Escape or the button closes it, and the embed is back inline as it was: its mode, features, layout and open tabs. |
| `status` | `toast`, `bar` | `toast` | Where the run status shows: a toast over the panes' bottom-right corner that fades a few seconds after it settles (errors stay), or a pill beside Run. |
| `layout` | `side`, `stack` | `side` | Where the preview (or the console, in `console` mode) goes: beside the editor, or under it, e.g. `<bun-playground mode="preview" layout="stack" height="auto">`. Stacked, there's no file tree. With `height="auto"` the editor fits its code (3 to 30 lines), the preview fits its request bar, the request panel when it shows (its params or headers, or a body of one line up to 7em) and a response (under a body at least room for a short one, 200px in all; a page keeps 200px; dragging the handle under the body only moves room between the two), and the console gets 120px, up to the 640px cap; past it, or at another height, they share the height and the response scrolls. Frames narrower than 560px stack either way. Inline only: expanded (`expand`), the embed has its usual layout, file tree included. Changing it moves the panes without reloading (a playground older than that reloads the embed); without it, the project's [`runbun.json`](/guides/project-config/) may pick one. |
| `example` | name | none | A bundled example. |
| `repo` | `owner/repo[@ref]` | none | A public GitHub repo. |
| `share` | `#code=…` | none | A share link's hash. In an iframe URL put it after `#`. |
| `library` | URL | none | Element only. Your own example library: a JSON file (see [Libraries](#libraries)) read on your page, once per URL for every embed. The embed gets a project button whose gallery lists only these projects. A `<script type="application/json" data-library>` child does the same inline. Set at load: changing it reloads the embed. |
| `project` | a library project's `id` | the library's `open`, else the inline files if any, else the first project | Element only. The project to start with. Changing it opens that project in place. |
| `load` | `eager`, `visible`, `click` | `visible` | Element only. When the embed starts. |
| `height` | CSS length, `auto` | `code`: `auto`; `console`: `360px`; `preview`: `420px`; `full`: `600px`; `result`: `420px` | Element only. `auto` fits the content once: the poster's, then the running embed's (with a stacked preview, once its first response shows). After that, switching tabs, responses and edits don't change it; a taller response scrolls in its pane. Changing the mode, features, layout or project fits it again. |
| `src` | URL | where `embed.js` came from; `https://runbun.dev/` from npm, or what `define({ src })` set | Element only. Another playground base URL. |
| `title` | text | none | The iframe's title, for assistive technology. |

A boolean is on unless it is `false` or `0`. Unknown or malformed values fall back to the default.

Inline files: child `<script type="text/plain" data-file="path">` elements, dedented. Mark one `data-hidden` to keep it out of the editor's tabs (it's still in the project, and in the file tree where there is one), e.g. a generated `<script type="text/plain" data-file="package.json" data-hidden>`. Mark one `data-generated` when your page owns it, such as a check `test()` runs: it's written on every load over a copy `persist` kept, never saved, and stays out of the file tree and the tabs, so readers can't open or edit it. Run and test still see it. The element also lists generated files as hidden, so an older playground keeps them out of the tabs at least. Poster: children with `slot="poster"`, shown until the embed is ready; with `load="click"` a Run button over them starts it.

## Libraries

A library is JSON: `{ "projects": [ … ], "open"?: "<id>" }`. Each project:

| Field | | |
|---|---|---|
| `id` | required | Names it for `project` and `openProject`. |
| `name` | required | The card's title. |
| `description` | | One line under it. |
| `kind` | `starter`, `example` | Starters list first; with both kinds the gallery has a section for each. Default `example`. |
| `tags` | strings | The frameworks and libraries it uses. The gallery filters by them; known ones (React, Elysia, Hono, SQLite, …) show their logo. |
| `files` | `{ path: text }` | The project. |
| `repo` | `owner/repo[@ref]` or a github.com URL | Instead of `files`: opened from GitHub when picked (60 projects an hour per reader without a token). |

Each project loads in place of the last: the embed stays, and the project installs and runs as `autorun` says. With `persist`, each project keeps its own edits; **Reset** puts the open one back as the library has it. `npx @runbun/embed pack <dir>` builds a library from a folder of projects laid out like [runbun-examples](https://github.com/oddcelot/runbun-examples), one folder per project with its card (`name`, `description`, `kind`, `tags`) in a [`runbun.json`](/guides/project-config/) or an `example.json`.

## Page defaults

`<bun-playground-defaults>` sets defaults for every `<bun-playground>` on the page. It takes the same attribute names and values, and renders nothing. Put it before the embeds.

```html
<bun-playground-defaults family="github-light" status="bar" load="click" fonts="https://fonts.googleapis.com/css2?family=Inter&display=swap"></bun-playground-defaults>
```

- Keys: `mode`, `features`, `autorun`, `theme`, `family`, `fonts`, `readonly`, `expand`, `status`, `layout`, `vars`, `load`, `height`, `src`, `library`. The others (`file`, `path`, `requests`, `example`, `repo`, `share`, `title`, `persist`, `project`) are per embed; a shared `persist` key would make embeds overwrite each other's edits. A shared `library` is read once, and each embed names its `project`.
- Precedence: built-in default, then the page default, then the element's attribute, then what the reader picks in the embed's menu. An element opts out of a boolean default with `false`, e.g. `readonly="false"`. Removing an element's attribute falls back to the page default.
- `vars` merges per scheme: the element's `base`, `light` and `dark` go over the page default's. Every other key replaces the default, `features` too. Malformed `vars` JSON in either place is skipped.
- Changing `theme`, `family`, `vars`, `mode`, `layout` or `height` on the defaults element updates running embeds without reloading them. The other keys only reach embeds that haven't started yet.
- The first `<bun-playground-defaults>` in the document wins; with more than one the element logs a warning. It is looked up every time, so a page that swaps its content (client-side navigation) can swap it too.

## Features

`mode` picks a preset; `features` adjusts it.

| Name | What | On in | Cost |
|---|---|---|---|
| `files` | File tree | `full` | |
| `tabs` | Tab bars: the open files', and the preview's. Off (`features="-tabs"`), the bar names the open file, and a preview has no tab bar unless it has several tabs (`requests`), which leaves the code and the response more of a short embed | `preview`, `full` | |
| `console` | Console output | `code`, `console`, `full` | |
| `preview` | Preview of a server | `preview`, `full`, `result` | |
| `types` | Type errors, hover and completions | none | 10 MB on first use |
| `format` | Format button (`bun fmt`) | `full` | 7 MB on first use |
| `install` | Install button | `preview`, `full` | |
| `terminal` | Interactive terminal | `console`, `full` | |
| `open` | "Open in runbun.dev" | all | |
| `watch` | Restart the running program when an edit is saved, like `bun --watch`; also after a crash, and not while an open file has a syntax error | all | |
| `close` | Close buttons on the editor's tabs (also middle-click, Delete and Ctrl/Cmd+W). Off, a reader can't close the example's tabs | `full` | |
| `git` | A Git panel in place of the file tree (with `files`), and `git` in the terminal; see [Git](/guides/features/#git) | `full` | 1 MB on first use |
| `resize` | A handle on the bottom edge (`height="auto"`, inline): drag it, or focus it and press ↑/↓ (Shift for bigger steps), to set the height by hand, 120px up to most of the window; double-click or Enter goes back to the content's height. The element's own; `setFeatures({ resize })` and `-resize` hide it | all | |
| `run` | The Run/Stop button. Off, Ctrl/Cmd+Enter, `autorun`, `watch` and `run()` still run the program | all | |
| `autosave` | An Auto-save switch over the editor: off, edits save on Ctrl/Cmd+S and before Run (switching it back on, or turning the feature off, saves what's waiting). Without it, edits save as you type | none | |

Readers can switch features on or off from the **⋯** menu, except those you locked with `-name`.

The embed's controls sit in the editor's tab bar: the Files button of a frame too narrow for the file tree and a library's project button before the tabs, and the status pill (`status="bar"`), Run/Stop, `expand` and the **⋯** menu after them. With `tabs` off, or in `result` mode, they're in a bar over the panes instead, which also names the open file.

## Methods

On the element, each returns a promise. Call them after `await el.ready`.

| Method | Params | Result |
|---|---|---|
| `run(entry?)` | file to start instead of the entry | resolves when started |
| `stop()` | | |
| `install()` | | resolves when done |
| `test(files?)` | file paths (default: every test file) | `{ failed, results }`: `results` is `{ file, failed }[]`, one per file that ran |
| `readFile(path)` | path | the file's text (bytes for a binary file) |
| `writeFile(path, text)` | path, text | |
| `listFiles()` | | array of paths |
| `openFile(path)` | path | rejects for a missing or generated file |
| `removeFile(path)` | path | deletes the file and closes its tab; rejects for a missing file |
| `setMode(mode)` | a mode | |
| `setFeatures(obj)` | `{ types: true, format: false }` | |
| `setLayout(layout)` | `"side"` or `"stack"` | The `layout` attribute does the same. Rejects on a playground older than it. |
| `setTheme(theme)` | a theme | |
| `setFamily(theme)` | a theme family's light variant | picks both halves without changing the color mode |
| `setVars(vars)` | a `vars` object | sets the chrome's CSS variables |
| `getShareUrl()` | | the share link as a string |
| `openProject(id)` | a library project's `id` | resolves once it has loaded (and, with `autorun`, started); rejects for an unknown id |
| `activate()` | | Starts an embed waiting for `load="click"` or `visible`. |
| `expand()` | | Opens the modal (works without the `expand` button too). |
| `collapse()` | | Puts the embed back in the page. |

`el.expanded` is true while the modal is open.

`test()` counts a file that fails to load as one failure. A run that ends before `bun test` reports fails, with no `results`: a test called `process.exit` (with any code), `stop()` ended it, or it ran past 30 seconds. `results` is also missing from playgrounds older than it. Without `results`, treat each file as not passed, or unknown: `failed` alone doesn't say which one failed. `run()`, `test()` and `install()` take turns: one called while another is under way starts when that one is done, so a `test()` right after `ready` waits for the install the embed starts then.

`el.ready` resolves once the embed has sent `ready` (or `unsupported`); read the data from the `bun-playground:ready` event. Requests sent earlier wait until the project has loaded.

## Events

On the element they are DOM events named `bun-playground:<event>`, with the data as `detail`. Over postMessage they have the same names without the prefix.

| Event | Data |
|---|---|
| `ready` | `{ version, bun, canRun, mode, features }` |
| `unsupported` | `{ checks: { name, ok, why }[] }`: the browser lacks something, so nothing runs; the code still shows and edits |
| `status` | `{ state: "idle" \| "busy" \| "running" \| "error", text }` |
| `console` | `{ level, text }` |
| `change` | `{ path, removed, by }`: a file changed; `by` says who changed it, see below |
| `test` | `{ failed, results }`, as `test()` returns |
| `mode` | `{ mode, features }`: after `setMode`, `setFeatures` or the reader's menu |
| `resize` | `{ height }`: the content's height in pixels, for iframes |
| `expand` | `{ open }`: on the element, the modal opened or closed. Over postMessage, the reader pressed the expand button (or Escape while open); the host opens or closes its modal and answers with `setExpanded` |
| `project` | `{ id }`: another library project opened, picked by the reader or by `openProject` |
| `boot` | `{ version }`: postMessage only; see below |

`change` comes when a file's contents change, not for a write that left a file as it was, and never for `node_modules`, generated files or the files the project loads with. `by` is `"reader"` for the reader's edits in the editor, the file tree and the console (`bun add` writing `package.json` included), `"program"` for files the running code writes (`run` or `test`: a database, a file written at startup), `"host"` for your `writeFile` and `removeFile`, and `"install"` for `bun install` writing `bun.lock` (playgrounds older than `"install"` say `"reader"` for it). Playgrounds older than `by` leave it out: treat a `change` without it as the reader's. A host that checks the reader's code on each change can skip the others, so a program that writes a file as it starts, or the install a project runs on load, doesn't set off another check.

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

`files` maps paths to text; `hidden` lists those not to open as tabs (`data-hidden`); `generated` those your page owns (`data-generated`). Send generated files in `hidden` too: a playground older than `generated` ignores it. `options` takes `mode`, `features`, `file`, `path`, `requests`, `autorun`, `theme`, `family`, `fonts`, `readonly`, `persist`, `expand`, `status` and `layout`. `vars` takes the object described under [Theming](#theming). `library` takes a [library](#libraries), already read; its `open` is the project to start with. Without `?init=1`, the page loads from its URL and `init` isn't needed; `setFamily` and `setVars` change both afterwards.

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
| `--canvas` | Behind the panes; a `background`, so a gradient works too |
| `--panel` | The bar, tabs and file tree |
| `--fg` | Text |
| `--muted` | Secondary text |
| `--border` | Lines between panes |
| `--accent` | Selection, focus rings, the Run button |
| `--error`, `--warn`, `--info`, `--ok` | Status colors |
| `--radius`, `--pad` | A pane's corner and the space inside it |
| `--pane-border` | A 1px line around each pane (editor, preview, console, file tree), following `--radius`; default none. With `--canvas: transparent`, the panes are framed boxes on your page |
| `--gutter` | The room between the panes and the embed's edge; default `4px`. `0px` puts the panes flush with the edge inline, for a page that frames the embed itself; the large view keeps 4px |
| `--font-ui`, `--font-mono` | The UI and code fonts; load them with `fonts` |
| `--control`, `--control-hover`, `--control-border` | Buttons and inputs |
| `--tab-track`, `--tab-track-border`, `--tab-track-radius`, `--tab-track-pad` | A track behind the editor's and the preview's tab rows: its background, 1px border, corner and the space inside it. Unset, there's none. The padding doesn't make the bar taller |
| `--tab-radius`, `--tab-hover` | A tab's corner (default `--inner-radius`) and its background on hover (default `--control`) |
| `--tab-selected`, `--tab-selected-border` | The selected tab's background (default `--control-hover`) and 1px border (default none) |
| `--tab-mark` | The line under the selected tab (default `--accent`); `transparent` hides it |
| `--tab-slide`, `--tab-slide-ease` | How the selected tab's look slides to the next selected tab and takes its size: the duration (default `220ms`; `0s` jumps) and the easing (default `cubic-bezier(0.22, 1, 0.36, 1)`; e.g. `cubic-bezier(0.34, 1.56, 0.64, 1)` overshoots like a spring). Off with reduced motion |

Others in `style.css` work too, but these are the ones a page usually wants to match its own design. To follow a page's light and dark themes, send `base` for the scheme in effect and update it (with `setVars`) when the page changes.

To draw over the embed (a border, a glow), style `bun-playground::part(overlay)`: an empty layer covering the poster and the frame, in the modal too, that lets clicks through.

The poster (shown until the embed is ready) is styled by CSS custom properties set on `<bun-playground>` or an ancestor:

| Name | What | Default |
|---|---|---|
| `--poster-bg`, `--poster-fg` | The poster's background (a color or a gradient) and text | `Canvas`, `CanvasText` |
| `--font-mono` | The default poster's code font (`load="click"` without a `slot="poster"`) | `ui-monospace`, … |
| `--play-bg`, `--play-fg` | The Run button's background and text; `--play-bg` also colors the spinner shown while the embed starts | `ButtonFace`, `ButtonText` |
| `--play-bg-hover` | The Run button's background on hover | `--play-bg` mixed 15% toward `--play-fg` |
| `--play-border`, `--play-radius`, `--play-font` | The Run button's border color, corner radius and font | `GrayText`, `6px`, inherited |

If the embed isn't ready after 60 seconds, the spinner turns back into the button, as "Try again".

Beyond these, style the button as `::part(play)` (also as "Try again") and the spinner as `::part(spinner)`, e.g. `bun-playground::part(play):hover { background: linear-gradient(90deg, #f472b6, #a78bfa); }`.

The `resize` handle is `::part(resize)`, a 10px strip over the box's bottom edge with a grip that shows on hover and focus (`[data-dragging]` while dragged). Dragging sets the height at once; ↑/↓, Enter and double-click go through `::part(box)`'s transition, if it has one.

To animate the swap from the poster to the running embed, style `::part(poster)`, `::part(frame)` (the iframe) and `::part(box)` (the box around both; its height is set inline, so it can transition). Once the embed is ready, the element is in the `live` state (`bun-playground:state(live)`): the poster, which sits above the frame, stops taking clicks, and the element hides it when its transitions have finished (at once without any). A blur and scale crossfade:

```css
bun-playground::part(poster),
bun-playground::part(frame) { transition: opacity .45s, filter .45s, scale .45s; }
bun-playground:state(live)::part(poster) { opacity: 0; filter: blur(8px); scale: 1.03; }
bun-playground:not(:state(live))::part(frame) { opacity: 0; filter: blur(8px); scale: .98; }
bun-playground::part(box) { transition: height .45s; }
```

Wrap it in `@media (prefers-reduced-motion: no-preference)` to keep the swap instant for readers who ask for less motion.

## Versioning

This is version 1. Changes only add: new methods, events, options, features and fields. Nothing is renamed or removed within a version. Ignore message keys and events you don't know; the embed does the same. So an `@runbun/embed` element from npm keeps working as runbun.dev updates.
