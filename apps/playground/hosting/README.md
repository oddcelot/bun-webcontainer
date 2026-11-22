# Hosting files

Where a playground build is hosted: one JSON file per deploy. `load.ts` reads and checks it. Nothing about the host is
compiled in: `configure.ts` writes it into a built folder (`hosting.js`, which pages and workers load at startup,
`src/hosting.ts`; `sw.js`'s first lines; the HTML's docs links; the content origin's rules in `_headers`). A build
runs it last with `HOSTING=<file>` (relative to `apps/playground`); a prebuilt copy runs it on its own:
`node hosting/configure.ts <dist> <file>`. In dev, the server serves the `HOSTING` file's values.

The release archive is that prebuilt copy: `moon run playground:release-archive` builds without a hosting file and
packs `dist/` with `configure.ts`, `load.ts` and `RELEASE.md` (its README) into
`dist-release/runbun-playground-<version>.tar.gz`; `moon run playground:check-release-archive` unpacks it elsewhere,
configures it for two origins under node and runs the gallery from it. Attach it to the release:
`gh release upload v<version> apps/playground/dist-release/runbun-playground-<version>.tar.gz`.

| File              | Deploy                                     | moon task                    |
| ----------------- | ------------------------------------------ | ---------------------------- |
| `runbun.dev.json` | https://runbun.dev, code on run.runbun.dev | `playground:build`, `deploy` |
| `canary.json`     | https://canary.runbun.dev                  | `playground:deploy-canary`   |

`example.json` is the one the release archive ships (`hosting.example.json`, with `brand/`'s logos): a Solid
playground with its own logo, theme and gallery. `scripts/hosting-check.ts` configures a build with it.

Fields, all optional:

- `docsUrl`: the docs the playground links to. Default: http://localhost:4321/ in dev, https://docs.runbun.dev/ in
  builds.
- `contentOrigin`: the origin that runs project code (the runtime Worker, the previews), which keeps it away from the
  editor's saved projects. Serve the same build there, on a subdomain of the editor's site (`src/contentOrigin.ts` says
  why). Default: none, project code runs on the editor's origin.
- `editorOrigins`: the editors the content origin answers; only these may drive project code there. The first is
  where the content host sends visitors (`EDITOR_ORIGIN` in `wrangler.jsonc`). Add `http://127.0.0.1:7357` for the
  local runner (`packages/connect`). Default: `["http://localhost:5173"]`.
- `canary`: shows the canary badge (`src/canary.ts`). Default: `false`.
- `name`: the site's name, in place of "runbun.dev" in the page titles, the share cards' site name and "Open in …".
  Default: `"runbun.dev"`.
- `gallery`: the example folders (`examples/`) the gallery lists, in this order. The others still open by
  `?example=<folder>`. Default: all of them. The build lists its folders in `dist/examples.json`; configure refuses a
  name that isn't one.
- `languages`: the language packs (`src/languages`) the playground enables, by id; today `reactivescript`. A file of a
  pack left out is a plain file: no errors or types of the pack's own, no formatter, and no gallery card for an example
  that needs it. A pack's code loads only when a project has a file it reads. Default: all of them; `[]` enables none.
  configure refuses an id that isn't one.
- `defaultProject`: the example folder a URL without a project opens. Default: the confetti demo (then at
  `?example=demo`).
- `landing`: `false` opens the playground at `/` right away, also for first-time visitors and at `/about`, and drops
  the status bar's About link. Default: `true`.
- `brand`: makes the playground the host's own. Its `logo` (an SVG, PNG or WebP next to the hosting file, at most
  64 kB; `logoDark` for dark themes) and `name` stand in the header where runbun has its dumpling and the visit's
  random name, linking to `home` if it names one; the logo is the page's icon; `name` alone is the page title, and
  `description` the pages' description. The status bar's About link then opens runbun.dev's about page (its tip: "Powered by runbun"), unless `landing` is on. Configure reads the logos into
  `hosting.js` as data: URLs, so there is no file to serve. `card` is the picture a shared link gets (og:image) in
  place of runbun's kitchen: a 1200x630 PNG next to the hosting file, at most 1 MB, which configure copies into the
  folder as `brand-card-<hash>.png`; `cardAlt` says what it shows (default: `name`).
  `bun scripts/brand-card.ts <hosting.json> <card.png>` draws one from the file's logo, name, description and theme
  (the example's `brand/solid-card.png`). Default: none, runbun's own.
- `theme`: how the playground looks before a visitor picks a theme. `family` is the theme family a first visit gets,
  by its light variant (`"solid-light"`, `"github-light"`; `src/themeColors.ts` lists them). `families` are the ones
  the picker offers (default: all, and `family` then defaults to the first); with one, the picker is the color scheme
  alone, and a visitor's earlier pick outside the list gives way to `family`. `vars` are CSS custom
  properties on top of every theme's, in the embed's `vars` shape: `base` for both schemes, `light` and `dark` for
  one (`{ "base": { "--radius": "8px" } }`). `transition` is how a theme switch reveals the new colors: `"logo"` in the
  shape of the logo, growing from the middle of the window (`brand.logo` with a circle behind it, or runbun's
  dumpling), `"circle"` in a plain circle, `"none"` at once, without a view transition (`src/theme.ts`). Default:
  Pierre, no variables, `"logo"`.
- `localRunner`: `false` leaves out the header's Local Bun switch (`packages/connect`). Default: `true`.
- `debugger`: `true` turns on the step debugger, a prototype: the Debug buttons, breakpoints and the Debug panel
  (`src/debugSession.ts`). Default: `false`; `DEBUGGER=1` turns it on for one dev server or build.

- `worker`: the host runs `worker/index.ts` next to the files (`wrangler.jsonc`): short links, Feedback, signing in
  with GitHub and the git proxy (git clone, GitHub dependencies). Without it the playground leaves them out: no short
  link in Share, no Feedback button, no sign-in, and git and GitHub dependencies say why they can't. Default: `true`
  in dev (the dev server answers the git proxy and sign-in), `false` in builds; this repo's files set `true`.

The page's canonical and share-card URLs, `robots.txt` and `sitemap.xml` follow the first editor origin.

Single env vars override a field, for the test scripts: `VITE_CONTENT_ORIGIN`, `VITE_EDITOR_ORIGINS`
(comma-separated), `DOCS_URL`, `CANARY=1`.

To look at a file written for a deploy on a dev server, `HOSTING_LOCAL=1` leaves out its `contentOrigin` and
`editorOrigins`, so project code runs on localhost: `HOSTING=hosting/example.json HOSTING_LOCAL=1 bunx vite`.

A build from source serves from any base path (`bunx vite build --base=/sub/path/`; the archive's is `/`) and needs
cross-origin isolation headers, see the playground's README, Deploying. On Cloudflare, `wrangler.jsonc` keeps its own copy of the hosts (`vars`, `routes`):
`bun scripts/hosting-check.ts` checks the two agree.
