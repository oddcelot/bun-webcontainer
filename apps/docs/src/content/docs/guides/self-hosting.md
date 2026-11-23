---
title: Host your own playground
description: "Run the runbun playground on your own domain from a release archive: one hosting file sets its name, its gallery, the project it opens and the origins it uses. No build, only static files."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Self-host the Bun playground on your own domain | Run Bun"
sidebar:
  order: 8
---

Every runbun release from 0.7.0 on comes with the playground as static files you can serve yourself: on your own domain, under your own name, with a gallery of the examples you pick and the project you want people to start in. Nothing is built: you download the release archive, describe your host in a small JSON file, and a script writes that into the files.

[solid.runbun.dev](https://solid.runbun.dev) is one, a playground for SolidJS. Its repository, [oddcelot/solid-playground](https://github.com/oddcelot/solid-playground), holds no playground code: a pinned archive, a hosting file, and a check that runs its projects in headless Chrome.

## What you need

- A host that serves static files over HTTPS (or on `localhost`), from the root of a domain or subdomain. The archive's paths start at `/`; a copy under a sub-path has to be [built from source](https://github.com/oddcelot/bun-webcontainer) with `vite build --base=/sub/path/`.
- Two headers on every response, for cross-origin isolation: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. The archive's `_headers` file sets them on Cloudflare (Workers static assets, Pages) and Netlify; on another server, set them there. GitHub Pages can't send headers, so it doesn't work yet.
- Node 24 or later, or Bun, to run the configure script once per deploy.

Visitors run code in browsers with WebAssembly Memory64: Chrome and Edge 133+, Firefox 134+. Safari and iOS browsers get the editor without Run, as on runbun.dev ([Browsers](/compatibility/browsers/)).

## 1. Download a release

Each [release](https://github.com/oddcelot/bun-webcontainer/releases) from v0.7.0 on has a `runbun-playground-<version>.tar.gz`:

```sh
curl -LO https://github.com/oddcelot/bun-webcontainer/releases/download/v0.9.0/runbun-playground-0.9.0.tar.gz
tar -xzf runbun-playground-0.9.0.tar.gz && cd runbun-playground-0.9.0
```

Inside: `dist/` (the site), `configure.ts` and `load.ts` (the script that points it at your host), a `README.md`, and `hosting.example.json`. To pin a version in a deploy script, keep the archive's SHA-256 (`shasum -a 256`) next to the version and check it after the download, as solid-playground's [`scripts/build.ts`](https://github.com/oddcelot/solid-playground/blob/main/scripts/build.ts) does.

## 2. Write a hosting file

The hosting file says where the copy lives and how it differs from runbun.dev. This is solid.runbun.dev's:

```json
{
  "name": "Solid Playground",
  "brand": { "logo": "brand/solid.svg", "logoDark": "brand/solid-dark.svg", "home": "https://www.solidjs.com/", "card": "brand/card.png" },
  "theme": { "families": ["solid-light"] },
  "localRunner": false,
  "gallery": ["solid-vite-hmr", "solid-ssr-dashboard", "solid-start-devtools", "astro-solid-demo", "reactivescript", "reactivescript-selects"],
  "languages": ["reactivescript"],
  "defaultProject": "solid-vite-hmr",
  "landing": false,
  "editorOrigins": ["https://solid.runbun.dev"]
}
```

Every field is optional:

| Field | Default | What it sets |
| --- | --- | --- |
| `editorOrigins` | `["http://localhost:5173"]` | Where people open your playground. The first is its canonical URL: the page's `<link rel="canonical">`, its share cards, `robots.txt` and `sitemap.xml` point there. |
| `name` | `"runbun.dev"` | Your site's name in the page titles, share cards and "Open in …". |
| `brand` | none | Your logo and name in place of runbun's, see [Your own brand and theme](#your-own-brand-and-theme). |
| `theme` | Pierre, every theme | The theme a first visit gets, the themes the picker offers, CSS variables on top of every theme, and how a theme switch looks. |
| `localRunner` | `true` | `false` leaves out the header's Local Bun switch. |
| `showConfig` | `true` | `false` keeps a project's [`runbun.json`](/guides/project-config/) out of the file tree and the tabs. It still applies, and visitors can show it again in Settings. |
| `debugger` | `false` | `true` turns on the [debugger](/playground/running-code/#debugger), a prototype. |
| `panels` | as the visitor left them | Which panes the playground opens with: `files`, `preview` and `console`, each `true` or `false`. `{ "console": false }` opens without the console. A project's own [`panels`](/guides/project-config/) win, visitors can still show and hide every pane, and a console you hid opens when the program fails. Embeds keep their modes. |
| `gallery` | all of them | Which bundled examples the gallery lists, by folder name, in this order. `dist/examples.json` lists the folders a release has; the others still open with `?example=<folder>`. |
| `languages` | all of them | The [language packs](/playground/editor/) the editor enables, by id; today `reactivescript`. A file of a pack you leave out is a plain file, and examples that need it leave the gallery. `[]` enables none. configure stops on an id it doesn't have. |
| `defaultProject` | a small demo | The example (a folder name) that opens at `/`. |
| `landing` | `true` | `false` opens the playground right away instead of runbun.dev's landing page. |
| `contentOrigin` | none | A second origin that runs project code, see [below](#a-separate-origin-for-project-code). |
| `docsUrl` | `https://docs.runbun.dev/` | Where the playground's Docs links go. |
| `worker` | `false` | Your host runs runbun.dev's Cloudflare Worker next to the files, see [What stays with runbun.dev](#what-stays-with-runbundev). |

### Your own brand and theme

`brand`, `theme`, `localRunner`, `debugger` and `languages` need 0.8.0 or later, `panels` and `showConfig` 0.9.0.

With a `brand`, the playground reads as yours: your logo and `name` stand in the header where runbun.dev has its dumpling and a random bun pun, the logo is the page's icon, and the page title is `name` alone. The status bar's About link opens runbun.dev's about page, which says what the playground runs on (with `landing` on, it opens your copy of that page instead).

| `brand` field | What it sets |
| --- | --- |
| `logo` | Required. An SVG, PNG or WebP file, as a path relative to the hosting file, at most 64 kB. Shown 24px high. |
| `logoDark` | The logo on dark themes. Default: `logo`. |
| `home` | Where the logo links to. Default: no link. |
| `description` | The pages' description for search results and share cards. Default: runbun's. |
| `card` | The picture a link to your playground gets where it is shared: a PNG file, 1200 by 630 pixels, at most 1 MB, as a path relative to the hosting file. Default: runbun's. |
| `cardAlt` | What the card shows, for people who can't see it. Default: `name`. |

Configure reads the logo files into `hosting.js` and copies the card into `dist/` as `brand-card-<hash>.png`, so there is nothing else to deploy. Share sites cache a card by its URL; a changed picture gets a new name.

`theme.family` is the theme family a first visit opens in, by the name of its light variant: `"solid-light"` (the SolidJS sites' colors), `"github-light"`, `"rose-pine-dawn"` and the others in the theme picker. Visitors can still pick another, and one they picked earlier stays. `theme.vars` sets CSS custom properties on top of whichever theme is on, for both schemes (`base`) or one (`light`, `dark`):

```json
{
  "theme": {
    "family": "github-light",
    "vars": { "base": { "--radius": "8px" }, "dark": { "--accent": "#65c5ff" } }
  }
}
```

The variables are the [embed's](/reference/embed-api/#theming): `--bg`, `--panel`, `--canvas`, `--fg`, `--muted`, `--border`, `--accent`, `--radius`, `--font-ui`, `--font-mono`.

A font named there shows only if the visitor has it, unless the playground loads it: `theme.fonts` lists stylesheets for that, each an https URL or a path from your site's root (a stylesheet you deploy beside the playground).

```json
{
  "theme": {
    "fonts": ["https://fonts.googleapis.com/css2?family=Inter&display=swap"],
    "vars": { "base": { "--font-ui": "Inter, system-ui, sans-serif" } }
  }
}
```

Until the stylesheet arrives the text shows in the next font of the list.

`theme.families` narrows the theme picker to the families you list, in the same names; a first visit gets the first unless `theme.family` names another of them. With a single family the picker offers the color scheme alone: system, light and dark.

```json
{
  "theme": { "families": ["solid-light"] }
}
```

A visitor who picked another theme before you narrowed the list gets yours on their next visit.

`theme.transition` is how a switch between light and dark, or to another theme, reveals the new colors:

| Value | What a switch looks like |
| --- | --- |
| `"logo"` (default) | The new colors grow out of the middle of the window in the shape of your logo (runbun's dumpling without a `brand`). The shape is the logo's opaque part, so use one with a transparent background. |
| `"circle"` | The same, in a plain circle. |
| `"none"` | The colors change at once. |

Visitors who ask their system for reduced motion always get the change at once.

The gallery's examples come from [runbun-examples](https://github.com/oddcelot/runbun-examples): a release bundles the ones it had when it was built. To add one, open a pull request there; it ships in the next release.

## 3. Configure the files

```sh
node configure.ts dist my-hosting.json
```

It checks the file (an unknown field, a URL with a path or an example folder that isn't in the release stops it with the reason) and writes your settings into `dist/`: `hosting.js`, which every page and worker reads when it starts, the service worker's first lines, the HTML's titles and links, and `_headers`. Run it again with another file to move the copy; it starts from what the last run wrote.

## 4. Serve `dist/`

On Cloudflare, a `wrangler.jsonc` next to `dist/` serves it as static assets, `_headers` included:

```jsonc
{
  "name": "my-playground",
  "compatibility_date": "2026-11-20",
  "assets": { "directory": "./dist" },
  "routes": [{ "pattern": "play.example.org", "custom_domain": true }]
}
```

`npx wrangler deploy` uploads it. On Netlify, publish `dist/`: it reads the same `_headers`. On any other server, serve `dist/` with the two headers on every response, and with a content origin also that origin's rules from `dist/_headers`. Requests for `/embed` and `/configure` should answer with `embed.html` and `configure.html`, as Cloudflare and Netlify do.

Then open your origin. A first visit downloads about 10 MB before the first project runs (the WebAssembly builds of Bun's toolchain and the project's packages); the service worker keeps them for the next visit.

## A separate origin for project code

By default, project code runs on the same origin as the editor. That is the simplest setup, and fine when you and people you trust run code there. Code that runs on the editor's origin can read the projects visitors saved in it, though, so a playground that opens other people's links should run project code on an origin of its own, as runbun.dev does on `run.runbun.dev`:

```json
{
  "editorOrigins": ["https://play.example.org"],
  "contentOrigin": "https://run.play.example.org"
}
```

Serve the same `dist/` on both. The content origin must be a subdomain of the editor's site (same site, different origin): for another site, the browser partitions its service worker under the editor's, and previews opened in a new tab find none. `configure.ts` adds the content origin's rules to `_headers`: it may be framed by the editor, and stays out of search results.

## What stays with runbun.dev

A few features are runbun.dev's Cloudflare Worker, not static files: short links for Share, the Feedback dialog, signing in with GitHub, and the git proxy that `git clone` and GitHub dependencies in `bun install` go through. A copy without it leaves them out: Share offers the full link, there's no Feedback button, and git and GitHub dependencies say they need a proxy. Opening a public GitHub repository with `?repo=owner/name` still works, since it talks to GitHub directly.

The Worker is in the [repository](https://github.com/oddcelot/bun-webcontainer) (`apps/playground/worker/`, `wrangler.jsonc`). If you deploy it next to your copy, with your own KV namespace and D1 database, set `"worker": true`.

## Embed your copy

Your copy serves its own `<bun-playground>` element at `/embed.js`, and it frames your copy, not runbun.dev:

```html
<script type="module" src="https://play.example.org/embed.js"></script>
<bun-playground example="solid-vite-hmr"></bun-playground>
```

With the `@runbun/embed` package, register it with your origin: `define({ src: "https://play.example.org/" })` from `@runbun/embed/element` ([Embedding](/guides/embedding/#from-npm)).

## Update

Download the newer archive, run `configure.ts` with the same hosting file, and deploy `dist/` again. Visitors' service workers pick up the new files on their next visit. The [changelog](https://github.com/oddcelot/bun-webcontainer/blob/main/CHANGELOG.md) says what changed; a release can bundle different examples, so check `dist/examples.json` against your `gallery` (configure stops on a name it doesn't have).
