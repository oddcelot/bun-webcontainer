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
- `defaultProject`: the example folder a URL without a project opens. Default: the confetti demo (then at
  `?example=demo`).
- `landing`: `false` opens the playground at `/` right away, also for first-time visitors and at `/about`, and drops
  the status bar's About link. Default: `true`.

The page's canonical and share-card URLs, `robots.txt` and `sitemap.xml` follow the first editor origin.

Single env vars override a field, for the test scripts: `VITE_CONTENT_ORIGIN`, `VITE_EDITOR_ORIGINS`
(comma-separated), `DOCS_URL`, `CANARY=1`.

A build from source serves from any base path (`bunx vite build --base=/sub/path/`; the archive's is `/`) and needs
cross-origin isolation headers, see the playground's README, Deploying. On Cloudflare, `wrangler.jsonc` keeps its own copy of the hosts (`vars`, `routes`):
`bun scripts/hosting-check.ts` checks the two agree.
