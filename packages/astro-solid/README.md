# @astrojs/solid-js (vendored v8, Solid 2)

A copy of `packages/integrations/solid/src` from [withastro/astro#17891](https://github.com/withastro/astro/pull/17891)
(Ryan Carniato's Solid 2 port of `@astrojs/solid-js`), because v8 is not on npm yet and 7.x needs `solid-js` 1.x.
The integration re-exports its renderer from `@astrojs/solid-js-renderer`, whose npm release is also Solid 1.x, so
the PR's `packages/renderers/solid-js/src` is vendored next to it in `../astro-solid-renderer`.

- Source: `ryansolid/astro` @ `ae554462b7e3c3230995b08c36924923672a9923` (branch `solid-2`). MIT, © withastro.
- Both `src/` directories are unedited; keep them that way so updating is a plain re-copy.
- Both keep the upstream package names (private, linked with `workspace:*`), so their own entrypoints
  (`@astrojs/solid-js/client.js`, `@astrojs/solid-js-renderer/server.js`) resolve and consumers' imports don't change.
- Upstream links `@astrojs/internal-helpers` and `@astrojs/runtime` from its workspace; here they come from npm, at
  the versions `astro` itself depends on.

Update to a newer PR commit (both packages):

```sh
scripts/vendor-astro-solid.ts [sha]   # default: the PR's current head
```

Once v8 (and a Solid 2 renderer) is on npm: in `apps/docs/package.json` replace `"@astrojs/solid-js": "workspace:*"`
with the npm range, delete this directory and `../astro-solid-renderer`, `bun install`. Tracked in bead `bwc-j01.15`.
