---
title: Embedding
description: "Put a runnable Bun example in your own page with the <bun-playground> element or an iframe; the code runs in the reader's browser, with no server."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Embed runnable Bun examples in your site | Run Bun"
sidebar:
  order: 4
---

An embed runs Bun code in your page, in the visitor's browser. Nothing runs on a server. This page shows the options; the full list is in the [embed reference](/reference/embed-api/), and the [configurator](/guides/configurator/) builds a snippet from them with a live preview.

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

The code runs when the element comes into view and the page is ready. Add `load="click"` to wait for a click on its Run button, and put a `slot="poster"` child inside to show something until it starts:

```html
<bun-playground load="click" mode="preview" example="elysia-demo">
  <img slot="poster" src="/elysia.png" alt="Elysia demo" />
</bun-playground>
```

### From npm

With a bundler, install the element as [`@runbun/embed`](https://www.npmjs.com/package/@runbun/embed) instead of loading the script. It's the same element, with TypeScript types for its attributes, methods, events and the postMessage protocol:

```sh
bun add @runbun/embed
```

```ts
import "@runbun/embed";
```

Importing it registers `<bun-playground>`, framing `https://runbun.dev/`. To frame another playground, such as a local dev server, register it yourself:

```ts
import { define } from "@runbun/embed/element";

define({ src: "http://localhost:5173/" });
```

The package has its own versions. Every version works with the playground at runbun.dev, because the protocol between them only grows (see [Versioning](/reference/embed-api/#versioning)).

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
| `code` | The editor and a console below it. | wasm for the transpiler and resolver (about 4 MB, once per site) | fits the code |
| `console` | The editor beside the console, which takes `bun test` and other commands. | same | 360px |
| `preview` | The editor with file tabs beside the preview. Installs missing packages. | same, plus the packages | 420px |
| `full` | The whole playground: file tree, tabs, preview over console, Format, Install, Git. Waits for Run. | same, plus the formatter (7 MB) and Git (1 MB) once used | 600px |
| `result` | Only the preview, with an Edit button that switches to `preview`. | same | 420px |

Every mode except `full` runs the code once it has loaded; `autorun="false"` waits for Run. While the program runs, saving an edit restarts it, like `bun --watch` (`features="-watch"` turns that off). Each restart clears the console. A crash doesn't stop the watching: the next save runs it again. A save that leaves an open file with a syntax error (half-typed, as auto-save saves it) keeps the program running as it was until a save parses.

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

In these docs, a fence marked `playground` becomes an embed. Consecutive fences with the same `group=<name>` become one embed with a tab per file:

````md
```ts playground group=demo title="index.ts"
import { greet } from "./greet";
```

```ts playground group=demo title="greet.ts"
export const greet = (n: string) => n;
```
````

To get the same in your own Astro site, see [Astro](/guides/astro/).

## Bring your own examples

Give an embed a library of your projects and readers can switch between them, like the playground's gallery but with only yours. Write the library as JSON on your site, and point `library` at it:

```html
<bun-playground mode="preview" library="/runbun/examples.json" project="hello"></bun-playground>
```

```json
{
  "projects": [
    { "id": "hello", "name": "Hello", "description": "Routes and validation", "kind": "starter", "tags": ["Elysia"],
      "files": { "index.ts": "…", "package.json": "…" } },
    { "id": "ws", "name": "WebSocket chat", "kind": "example", "tags": ["Elysia", "WebSocket"], "files": { "index.ts": "…" } }
  ]
}
```

The element reads the file on your page, so one on your own site needs no CORS headers. A bar button then names the open project and opens the gallery, and each pick loads in place. `project` names the one to start with. For several embeds on a page, set `library` once on `<bun-playground-defaults>` and give each embed its `project`. Small libraries can go inline as a `<script type="application/json" data-library>` child instead. Fields, the `openProject()` method and the `project` event are in the [reference](/reference/embed-api/#libraries).

To build the file from a folder of projects (one folder each, its card in a [`runbun.json`](/guides/project-config/) or an `example.json`, as in [runbun-examples](https://github.com/oddcelot/runbun-examples)):

```sh
npx @runbun/embed pack ./examples --out public/runbun/examples.json
```

## Turn features on and off

`features` is a comma list added to the mode's defaults. A leading `-` turns one off and locks it, so readers can't turn it back on.

```html
<bun-playground mode="code" features="types,-open"></bun-playground>
```

Readers get a **⋯** menu to show or hide the file tree, tabs, console and preview, and to turn on type hints, formatting, Git, restart on save and the Auto-save switch. It only offers what you haven't locked. With `format` or `install` on, the menu also has **Format file** and **bun install**; **Reset** loads the original files again. **Open in runbun.dev** opens the current files as a share link. The feature list is in the [reference](/reference/embed-api/#features).

Readers can drag the borders between panes (or focus one and use the arrow keys) to resize them; a double click goes back to the default. Sizes are kept for the browser tab.

Type checking downloads 10 MB the first time it's used, format 7 MB and Git 1 MB. They are off until someone turns them on.

Edits are lost on reload. Set `persist="some-key"` to keep them in the reader's browser, or `readonly` to stop editing (Run still works).

The run status shows as a toast over the panes that fades once the program settles; `status="bar"` shows it as a pill in the bar instead.

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
| `click` | When the reader clicks the poster's Run button |

Prefer `click` for pages with several embeds, or for modes that download a lot.

## Theme

`theme="auto"` follows the visitor's system setting. Use `light`, `dark`, or a theme family's light variant such as `github-light`. To follow your own page's theme, set the attribute when it changes. These docs do that with a small script.

`family` picks a family without touching the color mode, so `theme="light"`/`theme="dark"` can follow your page while the family stays put:

```html
<bun-playground family="github-light" fonts="https://fonts.googleapis.com/css2?family=Inter&display=swap"></bun-playground>
```

`vars` brings the embed's colors in line with your page. It sets CSS custom properties on top of the theme's, on both schemes or one:

```html
<bun-playground
  vars='{"base":{"--accent":"#ff5a5f","--radius":"1rem","--font-ui":"Inter, sans-serif","--font-mono":"JetBrains Mono, monospace"}}'
  fonts="https://fonts.googleapis.com/css2?family=Inter&family=JetBrains+Mono&display=swap"
></bun-playground>
```

`fonts` takes stylesheet URLs (whitespace-separated) and loads them inside the embed; `--font-ui` and `--font-mono` are what the chrome and the code use. When your page's own theme changes, call `el.setVars(vars)` with the new values; the object's shape and the variables are in the [reference](/reference/embed-api/#theming).

## Defaults for a page

With several embeds on a page, set what they share once with `<bun-playground-defaults>`. Each embed's own attributes still win:

```html
<bun-playground-defaults family="github-light" load="click" expand="full" theme="dark"></bun-playground-defaults>

<bun-playground mode="preview">…</bun-playground>
<bun-playground mode="code" expand="false">…</bun-playground>
```

To follow your page's theme, set `theme` (or `vars`) on the defaults element; every embed that doesn't set its own updates in place. Keys, precedence and how `vars` merges are in the [reference](/reference/embed-api/#page-defaults).

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

### Check a reader's code with tests

Give the embed test files of your own and mark them `data-generated`. The reader never sees or edits them, and with `persist` their saved edits stay while your checks are written fresh on every load. One `test()` call grades every task at once:

```html
<bun-playground id="lesson" mode="code" persist="lesson-1" autorun="false">
  <script type="text/plain" data-file="index.ts">export const add = (a: number, b: number) => 0;</script>
  <script type="text/plain" data-file="add.test.ts" data-generated>
    import { test, expect } from "bun:test";
    import { add } from "./index";
    test("adds", () => expect(add(1, 2)).toBe(3));
  </script>
</bun-playground>

<script type="module">
  const el = document.getElementById("lesson");
  await el.ready;
  const { failed, results } = await el.test(["add.test.ts"]);
  // results: [{ file: "add.test.ts", failed: 1 }]
</script>
```

`el.removeFile(path)` deletes a file, generated or not.

## Limits

- **Browsers.** Embeds need WebAssembly Memory64: Chrome and Edge 133+, Firefox 134+. Safari doesn't have it yet. There the embed still shows and edits the code, says why it can't run it, and sends `unsupported`. See [Browsers](/compatibility/browsers/).
- **Vite and Rolldown.** Projects that bundle with Vite or Rolldown need `SharedArrayBuffer`, so cross-origin isolation. An iframe is isolated only if your page is too (it sends `COOP: same-origin` and `COEP: credentialless`) and the iframe has `allow="cross-origin-isolated"`. These docs aren't isolated, so such examples run only on [runbun.dev](https://runbun.dev). Everything else works in any iframe.
- **Storage.** The service worker and saved files are partitioned per host site. The first visit on each site downloads the wasm again. Embeds on one page are independent: each has its own files, program and preview.
- **Where code runs.** An embed runs its project code on run.runbun.dev, a separate origin from runbun.dev, and your page needs no change for it. On a third-party site installed packages' large files stay in memory (no cross-origin isolation is delegated to that origin), and **Open preview in a new tab** opens the playground instead.
