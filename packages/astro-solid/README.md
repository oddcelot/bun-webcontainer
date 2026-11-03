# @astrojs/solid-js (vendored v8, Solid 2)

A copy of `packages/integrations/solid/src` from [withastro/astro#17891](https://github.com/withastro/astro/pull/17891)
(Ryan Carniato's Solid 2 port of `@astrojs/solid-js`), because v8 is not on npm yet and 7.x needs `solid-js` 1.x.

- Source: `ryansolid/astro` @ `7c75f9dc9ff3ca99d5cca5bfe4618a917608050d` (branch `solid-2`). MIT, © withastro.
- `src/` is unedited; keep it that way so updating is a plain re-copy.
- It keeps the upstream package name (private, linked with `workspace:*`), so its own `@astrojs/solid-js/client.js`
  entrypoints resolve and consumers' imports don't change.

Update to a newer PR commit:

```sh
scripts/vendor-astro-solid.ts [sha]   # default: the PR's current head
```

Once v8 is on npm: in `apps/docs/package.json` replace `"@astrojs/solid-js": "workspace:*"` with the npm range,
delete this directory, `bun install`. Tracked in bead `bwc-j01.15`.
