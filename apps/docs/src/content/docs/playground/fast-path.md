---
title: Fast path for browser-only projects
description: "Run a browser-only project without bun install or a worker, with packages loaded from esm.sh: what qualifies, what is inlined and what isn't supported."
sidebar:
  order: 6
---

The fast path is an experimental way to run a project that only needs a browser. It is off unless you ask for it.

<details>
<summary>How to turn it on and what it does</summary>

Turn on **Fast path** (the lightning icon next to Auto-save and Restart on save in the header; the setting is remembered), or open the playground with `?fast` added to the URL (handy in a link), and a browser-only project runs without `bun install` and without a worker. Each file is transpiled on its own, the project's packages load from [esm.sh](https://esm.sh) through an import map, and the page appears as soon as they arrive, usually a second or two sooner than the first run of a normal install. The console says `[fast] packages come from https://esm.sh`. Turning the toggle on or off applies from the next **Run**.

</details>

- <details>
  <summary><strong>What qualifies:</strong> an <code>index.html</code> at the project's root, and no file the page loads that uses <code>Bun.</code>, <code>node:</code>, <code>bun:</code> or <code>require()</code>.</summary>

  The files the page loads are the module scripts `index.html` references and everything they import from the project. None of them may use `Bun.`, `node:`, `bun:`, `require()` or `process.env`, `process.argv` or `process.cwd`.

  Files the page doesn't load (a server, build scripts, tests, config) don't count.

  Otherwise the project runs the normal way, and the console says which file ruled it out (`[fast] not used, running normally: main.ts uses Bun.`).

  </details>
- <details>
  <summary><strong>Packages</strong> come from esm.sh at the version in <code>bun.lock</code>, else the <code>package.json</code> range, so the page needs a network.</summary>

  The package names and versions are sent to esm.sh, a third-party service, so the page needs a network and doesn't work offline.

  The preview doesn't wait for `node_modules`: once it shows, `bun install` runs in the background, so the editor gets the packages' types (until then, imports of packages show as not found).

  </details>
- <details>
  <summary><strong>The page</strong> runs in a sandboxed frame, and its <code>console.log</code> and uncaught errors show in the console.</summary>

  The sandbox allows scripts, forms, dialogs, popups and downloads, and gives no access to the playground's storage.

  Uncaught errors and unhandled rejections show in the console, and so do the page's `console.log`, `info`, `debug`, `warn` and `error` (up to 1000 lines per run; objects are printed to a depth of 2, and `%s`-style format strings aren't applied).

  `localStorage` and `sessionStorage` work, but only in memory: each Run starts them empty and nothing is kept (the sandbox gives the page no storage of its own). IndexedDB and cookies don't work.

  </details>
- <details>
  <summary><strong>Files the page refers to</strong> (images, icons, fonts in your stylesheets) are inlined into the page, up to 2 MB in all.</summary>

  This covers project files that `index.html` points at (an `<img>`, `<source>`, `<video poster>`, `<audio>`, a favicon or other icon, the manifest) and the `url(…)` of project files in its `<style>` and stylesheets (an image, a font). Each use counts toward the 2 MB.

  Over that, the project runs the normal way and the console says so.

  </details>
- <details>
  <summary><strong>CSS modules:</strong> <code>import styles from "./app.module.css"</code> works, with class names made unique to the file.</summary>

  The class names are made unique to the file (`.box` becomes `.app_box_…`), the stylesheet is added to the page, and `styles` maps each written name to the new one (a name that is a valid identifier is a named export too).

  `:global(.x)` keeps a class as written; keyframe names are not scoped and `composes` is not followed.

  </details>
- <details>
  <summary><strong>Solid 2:</strong> a project that depends on <code>@solidjs/web</code> (or <code>solid-js</code> 2) has its JSX compiled by Solid's own compiler.</summary>

  The compiler, `@solidjs/compiler`, loads (about 6 MB) the first time such a project runs.

  Solid 1's JSX isn't compiled; use `solid-js/html` there.

  </details>
- <details>
  <summary><strong>No dev server, no hot module replacement:</strong> the project's program doesn't start, so a save builds the page again.</summary>

  A project with a root `index.html` qualifies even when its program starts a dev server, such as the [Vite](https://runbun.dev/?example=vite-demo) example. On the fast path that server never runs: there is no hot module replacement, and the page's state is lost on each save.

  Turn Fast path off to run those projects with their dev server. A project can also rule the fast path out for itself with `"fastPath": false` in its [`runbun.json`](/guides/project-config/), as the Solid 2 + Vite example does: it then runs the normal way whatever the toggle says, and the console says so.

  </details>
- <details>
  <summary><strong>Not supported:</strong> <code>import.meta.url</code> assets, <code>fetch</code> of project files, IndexedDB, cookies and source-mapped stack traces.</summary>

  The full list: assets loaded with `import.meta.url` (workers too), `fetch` of the project's files (there is no server), IndexedDB and cookies, and source-mapped stack traces.

  </details>

For example, a React counter qualifies: it has an `index.html` at the root and nothing that needs Bun or Node. This one runs here with the fast path on (an embed's `fast` attribute):

```html playground mode=preview group=fast-counter fast title="index.html"
<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

```tsx playground mode=preview group=fast-counter fast title="main.tsx"
import { useState } from "react";
import { createRoot } from "react-dom/client";

function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>;
}

createRoot(document.getElementById("root")!).render(<Counter />);
```

```json playground mode=preview group=fast-counter fast title="package.json"
{
  "name": "fast-counter",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

[Open it in the playground with the fast path on](https://runbun.dev/?fast#code=XVHBbtswDP0Vlicbc-3kOMf2YcUOvXbHaQNciem02pQh0UEDw_8-SHYyoCcRfO-Rj3oLXrA-Fni2AwWsF7Rs6KP8I-OANTYPxmm5TgSx0Slu9hegeXXmmiqAxtgLWNMq9M6Jwq6pjL3cwKC9nQTimFbh6Mw8kEIIXrcKq7G3XEr4SKqNus2v9gVNte_EAm9krNGOk_MCC8yBfkgvBCucvRtBoadei8KT4jtJe-qFXpyTT7RH48ZKD5Z4Uyg-z6zFOoYnN7OQz3JYoiHtOAj81LFbQCBJ-C9o7w6yQ36KTE8ye4bmdRZxDI6fBqvf2yXLoe3uyixNgi9wzNcuMcjAkporiB0pNNU2oTspXqO1_1dkxul5JJbyjeT7QLH8dn022S2C_CEvPbEhnzX7IVB10R8WOPX6vX-j8m9wjDWm8xRyP5LCGhSe-yCPyQl5hcUGT95eekkM8TPt3ZjqJroFuwOGprietaUQCWlJBPZ0ouT38Wt5KA-75g7GTD4RIr6mX8B1_Qc), and press **Run**: no install, and the console lists `react` and `react-dom` from esm.sh.

A Solid 2 counter runs the same way, its JSX compiled by Solid's compiler:

```html playground mode=preview group=fast-solid fast title="index.html"
<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

```tsx playground mode=preview group=fast-solid fast title="main.tsx"
import { createSignal } from "solid-js";
import { render } from "@solidjs/web";

function Counter() {
  const [count, setCount] = createSignal(0);
  return <button onClick={() => setCount(count() + 1)}>Clicked {count()} times</button>;
}

render(() => <Counter />, document.getElementById("root")!);
```

```json playground mode=preview group=fast-solid fast title="package.json"
{
  "name": "fast-solid-counter",
  "private": true,
  "type": "module",
  "dependencies": {
    "@solidjs/web": "^2.0.1",
    "solid-js": "^2.0.1"
  }
}
```

```json playground mode=preview group=fast-solid fast title="tsconfig.json"
{
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "@solidjs/web",
    "strict": true
  }
}
```
