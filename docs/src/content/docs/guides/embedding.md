---
title: Embedding
description: Put a runnable Bun example in your own page, with a custom element or an iframe.
sidebar:
  order: 4
---

An embed runs Bun code in your page, in the visitor's browser. Nothing runs on a server. This page shows the options; the full list is in the [embed reference](/reference/embed-api/).

This one is live. Click it to start:

```ts playground title="index.ts"
import { Database } from "bun:sqlite";

const db = new Database(":memory:");
db.run("create table t (n integer)");
for (const n of [1, 2, 3]) db.run("insert into t values (?)", [n]);
console.log(db.query("select sum(n) as total from t").get());
```

## Embed with the element

Load the script once, then use `<bun-playground>`:

```html
<script type="module" src="https://runbun.dev/embed.js"></script>

<bun-playground mode="code">
  <script type="text/plain" data-file="index.ts">
    console.log("hello from Bun");
  </script>
</bun-playground>
```

The code runs when the element comes into view and the page is ready. Add `load="click"` to wait for a click, and put a `slot="poster"` child inside to show something until it starts:

```html
<bun-playground load="click" mode="preview" example="elysia-demo">
  <img slot="poster" src="/elysia.png" alt="Elysia demo" />
</bun-playground>
```

## Embed with an iframe

No script needed. The URL parameters have the same names as the attributes:

```html
<iframe
  src="https://runbun.dev/embed?mode=preview&example=elysia-demo"
  allow="cross-origin-isolated; clipboard-write"
  style="width: 100%; height: 420px; border: 0"
></iframe>
```

A share link's `#code=…` hash works too: `https://runbun.dev/embed?mode=code#code=…`. An iframe doesn't resize itself; listen for the `resize` event (see [scripting](#script-it)) or set a height.

## Pick a mode

| Mode | Shows | Loads | Default height |
|---|---|---|---|
| `code` | The editor and a console below it. | wasm for the transpiler and resolver (about 5 MB, once per site) | fits the code |
| `console` | The editor beside the console, which takes `bun test` and other commands. | same | 360px |
| `preview` | The editor with file tabs beside the preview. Installs missing packages. | same, plus the packages | 420px |
| `full` | The whole playground: file tree, tabs, preview over console, Format, Install. Waits for Run. | same, plus the formatter (9 MB) once used | 600px |
| `result` | Only the preview, with an Edit button that switches to `preview`. | same | 420px |

Every mode except `full` runs the code once it has loaded; `autorun="false"` waits for Run.

Set `height` to any CSS length, or `auto` to fit the code.

## Add files

Each `<script type="text/plain" data-file="path">` is one file. The text is dedented, so you can indent it with the HTML around it. Write `<\/script` for a literal `</script` inside a file.

```html
<bun-playground mode="full" file="src/index.ts">
  <script type="text/plain" data-file="src/index.ts">
    import { greet } from "./greet";
    console.log(greet("Bun"));
  </script>
  <script type="text/plain" data-file="src/greet.ts">
    export const greet = (name: string) => `Hello, ${name}`;
  </script>
</bun-playground>
```

Other sources: `example="<name>"` (a bundled example), `repo="owner/repo"` (a public GitHub repo), or `share="#code=…"`.

In these docs, a fence marked `playground` becomes an embed. Fences with the same `group=<name>` become one embed with several files:

````md
```ts playground group=demo title="index.ts"
import { greet } from "./greet";
```

```ts playground group=demo title="greet.ts"
export const greet = (n: string) => n;
```
````

## Turn features on and off

`features` is a comma list added to the mode's defaults. A leading `-` turns one off and locks it, so readers can't turn it back on.

```html
<bun-playground mode="code" features="types,-open"></bun-playground>
```

Readers get a **⋯** menu to show or hide the file tree, tabs, console and preview, and to turn on type hints and formatting. It only offers what you haven't locked. With `format` or `install` on, the menu also has **Format file** and **bun install**; **Reset** loads the original files again. **Open in runbun.dev** opens the current files as a share link. The feature list is in the [reference](/reference/embed-api/#features).

Type checking downloads 12 MB the first time it's used, and format 9 MB. They are off until someone turns them on.

Edits are lost on reload. Set `persist="some-key"` to keep them in the reader's browser, or `readonly` to stop editing (Run still works).

## Open in a modal

`expand` adds a button to the embed's bar that opens it in a modal over your page. The program keeps running, and edits stay. Give it a mode to switch to while it's open, so a small snippet becomes the whole playground:

```html
<bun-playground mode="code" expand="full">…</bun-playground>
```

Escape or the button closes it. Your own controls can call `el.expand()` and `el.collapse()`. The code blocks in these docs open as `full`; write `expand=false` in a fence's meta to leave the button out.

## Load and sizing

| `load` | The embed starts |
|---|---|
| `visible` (default) | When it scrolls into view |
| `eager` | At once |
| `click` | When the reader clicks the poster |

Prefer `click` for pages with several embeds, or for modes that download a lot.

## Theme

`theme="auto"` follows the visitor's system setting. Use `light`, `dark`, or a theme family's light variant such as `github-light`. To follow your own page's theme, set the attribute when it changes. These docs do that with a small script.

## Script it

```html
<bun-playground id="p" mode="console" autorun="false">
  <script type="text/plain" data-file="index.ts">console.log(1 + 1);</script>
</bun-playground>

<script type="module">
  const el = document.getElementById("p");
  el.addEventListener("bun-playground:console", (e) => console.log(e.detail.text));
  await el.ready;
  await el.writeFile("index.ts", "console.log(40 + 2);");
  await el.run();
</script>
```

Every method and event is in the [reference](/reference/embed-api/).

## Limits

- **Browsers.** Embeds need WebAssembly Memory64: Chrome and Edge 133+, Firefox 134+. Safari doesn't have it yet. There the embed still shows and edits the code, says why it can't run it, and sends `unsupported`. See [Browsers](/compatibility/browsers/).
- **Vite and Rolldown.** Projects that bundle with Vite or Rolldown need `SharedArrayBuffer`, so cross-origin isolation. An iframe is isolated only if your page is too (it sends `COOP: same-origin` and `COEP: credentialless`) and the iframe has `allow="cross-origin-isolated"`. These docs aren't isolated, so such examples run only on [runbun.dev](https://runbun.dev). Everything else works in any iframe.
- **Storage.** The service worker and saved files are partitioned per host site. The first visit on each site downloads the wasm again. Embeds on one page are independent: each has its own files, program and preview.
