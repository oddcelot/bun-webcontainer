---
title: Preview
description: "How the playground's preview shows a Bun.serve or node:http server: the request bar, tabs, WebSockets, cookies, streaming and HTML imports."
sidebar:
  order: 5
---

When your code starts a server (`Bun.serve`, `node:http`, or `export default { fetch }`), the preview shows it. The request bar sends any request to it, and pages the server returns open in the preview.

<details>
<summary>Which server the preview shows when there are several</summary>

With several, it shows the program's first; a program that serves nothing itself shows the first server one of its child processes starts (a `package.json` script that runs `bun server.ts`, a `Bun.spawn`), and the status bar lists those ports too. To see another of them, pick it in the status bar's port list (in an embed, the ⋯ menu's **Preview port**): the preview loads again from that server, and its WebSockets that name no port go there too, for as long as it runs. When it stops, the preview goes back to the default.

</details>

- <details>
  <summary><strong>Request bar:</strong> send any method, path and body, with Params, Headers, Auth and Body sections and a Raw switch.</summary>

  The request panel under the bar has its toggle next to Send. It has Params, Headers, Auth and Body, and a Raw switch.

  **Params and headers**

  - Params lists the path's query as rows and writes your edits back into the path.
  - Params and headers are rows you can turn off one by one; a param turned off leaves the path and keeps its place until you turn it on again.
  - Every header reaches the server, including ones a page's `fetch` can't set, such as `Cookie`, `Origin` and `Referer`.
  - A `Cookie` is joined with the cookies the app has set, and yours wins when a name is in both.
  - An HTML page you send headers to gets them on its first load, but not its scripts, fetches or links.

  **Auth**

  Auth sends a Bearer token, Basic credentials or an API key, the key as a header or a query parameter. What it adds shows as a read-only row under Headers or Params, and a header row with the same name wins over it.

  **Body**

  - A body is sent as JSON or text, written in the same editor as files (Format, or <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> in the body, indents a JSON body), or as a form, from rows.
  - A GET or HEAD request has no body; Body says so and offers to switch to POST.
  - A form is URL-encoded, or multipart, where a row can send a file from the project.

  **Raw and copy**

  - Raw shows the whole request as `.http` text in place of the section: the request line, a header per line (`#` turns one off), a blank line and the body. Edit it there and the other sections follow.
  - The copy menu copies the request as a curl command or a `fetch` call for `http://localhost:3000`, where the app runs when you start it locally with `bun`.

  **Responses**

  - A response from before the request last changed is dimmed, with a note to send it again.
  - Each preview tab keeps its own params, headers, auth and body.
  - HTML responses open in the page; anything else shows status, headers and the body: JSON formatted, and JSON, HTML, CSS, JavaScript, XML and Markdown highlighted.
  - A link or redirect in a page that leads to JSON or plain text shows it the same way, with its status but not its headers (the request isn't sent again; press Send for them).

  </details>
- <details>
  <summary><strong>Tabs:</strong> several previews at once; <kbd>Cmd</kbd>-click or middle-click a link to open it in a new preview tab.</summary>

  <kbd>Cmd</kbd>-click (<kbd>Ctrl</kbd>-click off macOS) or middle-click a link in a page to open it in a new preview tab in the background; add <kbd>Shift</kbd> to switch to it.

  </details>
- **Open in a new tab:** the page gets its own browser tab, still served by the playground (keep the playground tab open). It loads again when the panel's preview does: on Run, and when you save a file the page uses.
- **Requests stay inside:** `fetch("/api/x")`, links, forms and redirects from the preview page reach your server.
- <details>
  <summary><strong>WebSockets:</strong> the preview page's <code>WebSocket</code> connects to your server, and so does the program's own <code>new WebSocket</code>.</summary>

  This works with `Bun.serve` `upgrade`, `node:http` `upgrade` and the `ws` package. `localhost:<port>` URLs pick the server on that port. The program's own `new WebSocket("ws://localhost:<port>")` reaches its servers too.

  </details>
- **Streaming:** streamed responses and Server-Sent Events arrive as they're sent.
- **Requests from the page** reach your server as if the page were at the server's own URL (`http://localhost:<port>`): a `POST` carries the `Origin` and `Content-Length` a browser sends, so same-origin checks and body parsers (Solid's server functions, for one) work as they do locally.
- <details>
  <summary><strong>Cookies</strong> are kept in the browser across restarts; list them with <code>cookies</code> in the console.</summary>

  The preview's scripts read and set them with `document.cookie` and DevTools lists them (HttpOnly ones stay hidden from scripts and DevTools); see them with `cookies`.

  </details>
- <details>
  <summary><strong>HTML imports:</strong> <code>import page from "./index.html"</code> in <code>Bun.serve</code> routes is bundled with Bun's bundler.</summary>

  A browser-only project runs the way Bun runs it: Run (or `bun ./index.html`, or a `"dev": "bun ./index.html"` script) serves the page at `/` with its scripts and styles bundled, and `bunfig.toml`'s `[serve.static] plugins` apply.

  </details>
- The preview follows the playground's light/dark mode.

Limits: the server isn't reachable from outside the browser, there's no HTTP caching (conditional requests are dropped), and only the preview page can open WebSockets to it.

For browser-only projects there is also an experimental way to skip the install and the worker: see [Fast path for browser-only projects](/playground/fast-path/).

## Devtools

The pane under the preview has a **Devtools** tab, next to the console, in a project with Solid's, Vue's or Nuxt's devtools. It shows them for the page in the active preview tab, in place of the panel that would sit over your page.

<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> brings the tab forward from anywhere in the playground, and a run that fails switches to the console, where its output says why.

### Solid

In a project that uses [`@solidjs/start-devtools`](https://github.com/solidjs/solid-start-devtools) (the [Solid Start + devtools](https://runbun.dev/?example=solid-start-devtools) and [Solid 2 SSR](https://runbun.dev/?example=solid-ssr-dashboard) examples do), the pane under the preview opens on a **Devtools** tab next to the console. The toolbar that would sit over your page is there instead, always open: Health, Activity and Structure for the page in the active preview tab. Switch preview tabs and it switches with them; reload the page and it comes back with it.

- The toolbar's own keys work in the tab: <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> finds a component, signal or call, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> picks an element in the page, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> highlights updates.

### Vue

In a project with [`vite-plugin-vue-devtools`](https://devtools.vuejs.org/guide/vite-plugin) (the [Vue + Pinia + DevTools](https://runbun.dev/?example=vue-demo) example has it), the tab shows Vue DevTools: the component tree with each component's props and state, Pinia's stores, the timeline, routes and the Vite module graph. The floating Vue button in the page goes; the tab is its panel. Switching preview tabs, or a new run, loads them for that page.

### Nuxt

In a [Nuxt](https://nuxt.com/) project (the [Nuxt + DevTools](https://runbun.dev/?example=nuxt-demo) example), the tab shows [Nuxt DevTools](https://devtools.nuxt.com/): pages, components, imports, modules, the payload and the server's hooks, for the page in the active preview tab. The Nuxt button in the page goes; the tab is its panel. Actions that write files ask for a token Nuxt prints in the console, unless the project's `nuxt.config.ts` sets `devtools.disableAuthorization`.

### Where it works

Experimental. The tab needs the preview on the playground's own origin, so it isn't there on runbun.dev, which runs project code on a separate origin: there the devtools stay over the page, as in a browser tab. A [self-hosted](/guides/self-hosting/) copy without a `contentOrigin` has it.
