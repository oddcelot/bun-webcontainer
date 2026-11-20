# runbun playground, for self-hosting

The playground that runs on https://runbun.dev, built for any host: static files in `dist/`, and `configure.ts`, which
points them at yours. Nothing here is built again; Node 24+ or Bun runs the script.

## 1. Write a hosting file

```json
{
  "contentOrigin": "https://run.play.example.org",
  "editorOrigins": ["https://play.example.org"]
}
```

All fields are optional:

- `editorOrigins`: where people open the playground. The first is where the content origin sends visitors who open
  one of its pages directly.
- `contentOrigin`: a second origin that runs project code, on a subdomain of the editor's site (the same site, so its
  service worker isn't partitioned). It serves the same `dist/`. Project code there can't read the projects people
  saved in the editor. Leave it out to run project code on the editor's origin, which is simpler and fine when only
  you and people you trust run code in it.
- `docsUrl`: where the playground's Docs links go. Default: https://docs.runbun.dev/.
- `canary`: shows a "canary build" badge. Default: false.
- `name`: your site's name, in the page titles and share cards in place of "runbun.dev".
- `gallery`: which bundled examples the gallery lists, in order, by folder name; `dist/examples.json` lists them.
  The others still open by `?example=<folder>`. Default: all of them.
- `defaultProject`: the example (a folder name) your playground opens at `/`. Default: a small demo.
- `landing`: `false` opens the playground right away instead of runbun.dev's landing page. Default: true.
- `brand`: your logo and `name` in the header in place of runbun's, your logo as the page's icon, and `name` alone
  as the page title: `{ "logo": "logo.svg", "logoDark": "logo-dark.svg", "home": "https://example.org/",
  "description": "…" }`. Only `logo` is required: an SVG, PNG or WebP file next to the hosting file, at most 64 kB.
  `"card": "card.png"` is the picture a shared link gets, in place of runbun's: a 1200x630 PNG next to the hosting
  file, at most 1 MB (`"cardAlt"` says what it shows). Configure copies it into `dist/`.
  The status bar's About link then opens runbun.dev's about page (its tip: "Powered by runbun"), unless `landing` is on.
- `theme`: `{ "family": "solid-light" }` is the theme family a first visit gets, by its light variant (the theme
  picker lists them: `pierre-light`, `github-light`, `solid-light`, …). `vars` sets CSS custom properties on top of
  every theme: `{ "vars": { "base": { "--radius": "8px" }, "dark": { "--accent": "#65c5ff" } } }`.
  `"families": ["solid-light"]` narrows the theme picker to the families it lists (one: only light, dark and system
  are left to pick), and the first is what a first visit gets unless `"family"` names another.
  `"transition"` is how a theme switch reveals the new colors: `"logo"` (the default) in the shape of your logo,
  `"circle"` in a plain circle, `"none"` at once.
- `localRunner`: `false` leaves out the header's Local Bun switch. Default: true.
- `debugger`: `true` turns on the step debugger, a prototype. Default: false.

`hosting.example.json` is a whole one: a Solid playground with the logos in `brand/`.

The canonical URL, the share cards' URLs, `robots.txt` and `sitemap.xml` point at the first editor origin.

## 2. Configure the build

```sh
node configure.ts dist my-hosting.json
```

It writes `dist/hosting.js` (which the pages and workers load), the service worker's first lines, the docs links and,
with a content origin, that origin's rules in `dist/_headers`. Run it again with another file to move the copy.

## 3. Serve `dist/`

- From the root of the origin (`https://play.example.org/`): the build's paths start at `/`. A copy under a sub-path
  has to be built from source with `vite build --base=/sub/path/`.
- Over HTTPS (or `localhost`): service workers need a secure context.
- With cross-origin isolation, on every response:
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`.
  `dist/_headers` sets them on Cloudflare (Pages, Workers static assets) and Netlify; on another server, set them
  there, along with the content origin's rules from `_headers` if you have one.

Running code needs WebAssembly Memory64: Chrome and Edge 133+, Firefox 134+. Safari and iOS browsers get the editor
without Run.

What runbun.dev has that a static copy doesn't: short links for Share, the Feedback dialog, signing in with GitHub,
and the git proxy that `git clone` and GitHub dependencies in `bun install` go through. They are runbun.dev's
Cloudflare Worker, not part of this archive, so the playground leaves them out: Share offers the full link, and git
and GitHub dependencies say they need a proxy. Opening a public GitHub repository (`?repo=owner/name`) still works.
