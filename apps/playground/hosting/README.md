# Hosting files

Where a playground build is hosted: one JSON file per deploy, picked at build time with `HOSTING=<file>` (relative to
`apps/playground`). `load.ts` reads and checks it; `vite.config.ts` compiles the values in and adds the content origin's
rules to the build's `_headers`.

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

Single env vars override a field, for the test scripts: `VITE_CONTENT_ORIGIN`, `VITE_EDITOR_ORIGINS`
(comma-separated), `DOCS_URL`, `CANARY=1`.

The build serves from any base path (`bunx vite build --base=/sub/path/`) and needs cross-origin isolation headers, see
the playground's README, Deploying. On Cloudflare, `wrangler.jsonc` keeps its own copy of the hosts (`vars`, `routes`):
`bun scripts/hosting-check.ts` checks the two agree.
