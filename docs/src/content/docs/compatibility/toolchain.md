---
title: Toolchain
description: Transpiler, module resolution, CommonJS, bun install and the bundler in the playground.
sidebar:
  order: 4
---

## Transpiler

Bun's own parser and printer, compiled to WebAssembly. Output matches `bun build --no-bundle --target=browser`.

- ✅ `.ts`, `.tsx`, `.jsx`, `.mts`, `.cts`, `.js`, `.mjs`
- ✅ JSX with Bun's defaults (React automatic runtime)
- ✅ `/** @jsxImportSource preact */` pragma comments
- ✅ Legacy decorators with `experimentalDecorators` and `emitDecoratorMetadata` in `tsconfig.json`
- ✅ Top-level `await`
- ❌ `tsconfig.json` `paths`, `baseUrl`, `jsx`, `jsxImportSource` and `extends` are not read (use the pragma for another JSX runtime)
- ❌ No type checking

## Module resolution

- ✅ Relative imports, with `.ts .tsx .js .jsx .mjs .json` and `index.*` tried in that order
- ✅ Packages from `node_modules`, walking up folders: `exports` (nested conditions, arrays, `./*` patterns), then `module`, then `main`
- ✅ Conditions: `bun`, `node`, `import`, `development`, `default` for server code; `browser`, `module`, `import`, `development`, `default` for code in the preview page
- ✅ `#imports` from the nearest `package.json`
- ✅ JSON imports
- ✅ CSS imported from code that goes through an HTML import (bundled), or through Vite
- ❌ `import "./x.css"` in server code fails to load (Bun gives an empty module)
- ✅ `http:`/`https:` imports are left to the browser
- `rolldown` is replaced by the playground's own `@rolldown/browser`, since the native binding can't load

An import that can't be resolved shows `cannot resolve "x"` in the console.

## CommonJS and `require`

- ✅ `.cjs` files, and `.js` files without ESM syntax in packages that aren't `"type": "module"`
- ✅ `require("x")` with a string literal. Modules run on first `require`, as in Node; cycles see partial exports.
- ✅ Named imports from CommonJS, found by a static scan (`exports.x =`, `module.exports = { … }`, re-exports). Exports computed at runtime aren't visible as named imports.
- ✅ `createRequire(import.meta.url)` and `import.meta.require` with string literals
- ❌ `require(variable)` throws. So does a `require` that can't be resolved, when it runs.
- ❌ `require.cache`, `require.main`, native `.node` addons

## `bun install`

Runs in the console (`bun install`, `bun add`, `bun remove`) and automatically when a project opens with missing dependencies.

- ✅ Packages from the npm registry, with Bun's semver
- ✅ `dependencies`, `devDependencies`, `optionalDependencies` and required peer dependencies
- ✅ `bun.lock` (text format): exact versions, nested `node_modules`, integrity checks. A stale lockfile logs a warning.
- ✅ Optional packages limited to other platforms (native bindings) are skipped
- 🟡 Without a lockfile, the install is flat: the first version seen wins
- ❌ No `bun.lock` is written. `bun add` refuses to run when a `bun.lock` exists.
- ❌ No lifecycle scripts (`postinstall`, …)
- ❌ No git, tarball, `file:`, `workspace:` or `npm:` dependencies
- ❌ Only `registry.npmjs.org`; `.npmrc` isn't read
- ❌ Binary `bun.lockb`

## Bundler

`Bun.build` and HTML imports use Bun's real bundler, compiled to WebAssembly (~10 MB, loaded on first use). See [`Bun.build`](/compatibility/bun/#the-bun-global) for the supported options.

- Single-threaded; each build starts fresh
- HTML imports in `Bun.serve` are built for the browser, without minification or source maps
- If a build fails, errors go to the console and the page is served unbundled
