---
title: Toolchain
description: "How Bun's toolchain runs in the browser: the transpiler, bun install and bun.lock, module resolution, CommonJS, Bun.build, bun fmt, bun check and type checking."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "bun install, the transpiler and the bundler in the browser | Run Bun"
sidebar:
  order: 4
---

## Transpiler

Bun's own parser and printer, compiled to WebAssembly. Output matches `bun build --no-bundle --target=browser`.

- ✅ `.ts`, `.tsx`, `.jsx`, `.mts`, `.cts`, `.js`, `.mjs`; JSX in `.js` files too, as Bun parses them (not in `.mjs` or `.cjs`)
- ✅ JSX with Bun's defaults (React automatic runtime, development `jsxDEV`)
- ✅ `/** @jsxImportSource preact */` pragma comments
- ✅ Legacy decorators with `experimentalDecorators` and `emitDecoratorMetadata` in `tsconfig.json`
- ✅ Top-level `await`
- ✅ `jsx` (`react`, `react-jsx`, `react-jsxdev`), `jsxImportSource`, `jsxFactory` and `jsxFragmentFactory` from the nearest `tsconfig.json` (or `jsconfig.json`), following a relative `extends` as Bun does (Preact, Solid or `hono/jsx` without a pragma); pragmas in a file still win. `NODE_ENV` doesn't change the JSX output, as in `bun build --no-bundle`

```ts playground title="index.ts"
enum Level { Low = 1, High = 10 }

interface Task { title: string; level: Level }
const tasks = [{ title: "docs", level: Level.High }] satisfies Task[];

class Queue<T> {
  #items: T[] = [];
  constructor(private readonly name: string) {}
  push(item: T) { this.#items.push(item); return this; }
  get size() { return this.#items.length; }
}

const queue = new Queue<Task>("main").push(tasks[0]);
await Bun.sleep(10); // top-level await
console.log(Level[tasks[0].level], queue.size);
```

## Type checking

The language service of [tsrs](https://github.com/oxc-project/tsrs) (TypeScript 7's compiler ported to Rust), compiled
to WebAssembly. The editor shows type errors in `.ts`, `.tsx`, `.mts` and `.cts` files a moment after you stop typing,
once the file parses. It loads with the first TypeScript file you open (~2.2 MB compressed, Bun's type definitions
included) and keeps the project in memory: the first check takes a fraction of a second (about 0.6 s with the Astro
example's `node_modules`), later ones a few milliseconds.

- 🟡 Errors for the open file only, with the editor's unsaved text; other files are checked as saved
- ✅ Uses the nearest `tsconfig.json` or `jsconfig.json` (the one the transpiler reads, so `jsxImportSource: "hono/jsx"` or Preact type-check as they run), including `extends` (relative, from packages, or a list); without one, the options `bun init` writes plus `types: ["bun"]`
- ✅ Types for `Bun.*`, `bun:*`, `node:*` and HTML imports from `@types/bun`, bundled; a project's own `@types/bun` or `@types/node` takes their place
- ✅ Package types from installed `node_modules` (`.d.ts` files and `package.json` `types`/`exports`)
- ✅ Hover info: rest the pointer on a name for its type and documentation (JSDoc, with examples), highlighted in the editor's theme
- ✅ Completions: members after `.`, names in scope, keywords, and import paths, each with its type and documentation. Auto-imports offer what the project's other files, its installed packages and Bun's and Node's built-in modules (`bun:sqlite`, `node:fs`) export, and add the import
- ✅ Parameter hints in calls: the signature, its overloads, and the current parameter's documentation
- 🟡 Go to definition: <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+click a name, or <kbd>F12</kbd>; opens the file it's declared in, including `.d.ts` files in `node_modules`. Not into TypeScript's own libs or Bun's bundled types (a project without `@types/bun` installed)
- ✅ JSON files from a JSON schema: completions for property names and values, hovers with each field's description, and errors and warnings as you type, for schemas of any draft up to 2020-12 (`$dynamicRef` included). [`runbun.json`](/guides/project-config/) gets its schema built in; another file gets the one its `$schema` names: a path relative to the file is read from the project (a schema of your own, or one an installed package ships in `node_modules`), and a URL is fetched (https, from a host that allows cross-origin requests, as SchemaStore, GitHub, unpkg and jsDelivr do). A schema's `$ref`s load the same way. Comments and trailing commas are allowed in `runbun.json`, `tsconfig.json` and `jsconfig.json`, errors elsewhere
- ✅ `bun check` in the console, Bun's own type checker (below)
- ❌ No `tsc` command in the console

### `bun check`

Bun's type checker, the one behind `bun check` (TypeScript 7.0 ported into Bun), compiled to WebAssembly. Type
`bun check` in the console: it reads the project like Bun reads the disk and prints what Bun prints, the errors with
the lines in question, then a summary. It loads the first time (~3.3 MB compressed) and takes a fraction of a second on
a small project.

- ✅ `bun check` with the project's `tsconfig.json`, `bun check <file…>` without one, `-p <tsconfig>`, `--all`, `--no-pretty`, and compiler options as flags (`--strict`, `--noImplicitAny`)
- ✅ `bun --check <file>` and `bun run --check <file or script>` (also in a `package.json` script): type-check the file and what it imports, print the errors as Bun does, and run the program only if there are none. The Run button doesn't check
- ✅ Types from `node_modules`, as in Bun: without `@types/bun` installed, `Bun` and `console` are errors and the note says to run `bun add -d @types/bun` (the editor has Bun's types built in; `bun check` doesn't)
- ✅ TypeScript's `lib.*.d.ts` files built in, those of the version Bun's checker is a port of
- ❌ `--watch`, `--threads`, `--cwd`, and a `check` script in `package.json` (`bun check` always runs the checker)

## Formatter (`bun fmt`)

Bun's own formatter, compiled to WebAssembly. It formats like Prettier, and its output matches `bun fmt` byte for byte:
each file goes through `bun fmt --stdin-filepath`, Bun's own code, with the project's files. It loads the first time you
format (~2.3 MB compressed). Use **Format** (top right of the code, on hover) or <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> for the open
file, or `bun fmt` in the console.

- ✅ JavaScript, TypeScript, JSX, JSON, CSS, SCSS, Less, HTML, Markdown, MDX, YAML, TOML, GraphQL, Handlebars and Svelte
- ✅ The project's config: `bunfig.toml` `[fmt]`, `.prettierrc` (JSON, YAML or TOML), `package.json` `"prettier"`, `.editorconfig`; the nearest one applies, as in Bun
- ✅ `.prettierignore`
- ✅ `bun fmt [path…]` formats a folder or files; `--check` (`-c`) lists what isn't formatted and changes nothing
- ✅ `bun fmt`'s formatting flags (`--no-semi`, `--single-quote`, `--print-width=<n>`, …), which win over the config
- ✅ A syntax error leaves the file as is and prints `bun fmt`'s message with the line in question; Format also marks it in the editor
- ✅ Skips `node_modules`, lock files and minified files, like `bun fmt`
- ✅ The editor's Format is one undoable edit, and the cursor stays where the text didn't change
- 🟡 In a folder, files that `.prettierignore` lists count as unchanged instead of being left out of the count
- ❌ Configs written in JavaScript (`prettier.config.js`) and Prettier plugins
- ❌ No import sorting or Tailwind class sorting
- ❌ No `--staged` or `--changed` (no git)

## Module resolution

Bun's own resolver, compiled to WebAssembly (~900 KB, loaded with the first module), over the project's files.

- ✅ Relative and absolute imports, with Bun's extension order (`.tsx` and `.ts` before `.js`) and `index.*`
- ✅ Packages from `node_modules`, walking up folders: `exports` (nested conditions, arrays, `./*` patterns), then the main fields (`module`, `main` for server code; `browser`, `module`, `main` for the page)
- ✅ Conditions: `bun`, `node`, `import` or `require`, `development`, `default` for server code; `browser`, `module`, `import`, `development`, `default` for code in the preview page
- ✅ `#imports` from the nearest `package.json`
- ✅ `tsconfig.json` `paths` and `baseUrl`
- ✅ JSON, JSONC, JSON5, TOML and YAML imports (`.json`, `.jsonc`, `.json5`, `.toml`, `.yaml`, `.yml`) with Bun's parsers, as Bun has them: the document is the default export and an object's top-level keys (but `default`) named ones; anything else (an array, a string, `null`) comes with `__esModule: true` instead. An empty file is `{}`, except for JSON.
- ✅ `require` of a data file returns the parsed value, or its namespace once the file has been imported, as in Bun (a file required first stays its value)
- ✅ Markdown imports (`.md`, `.markdown`) with Bun's renderer, as Bun has them: the HTML is the default export; `require` returns the module's namespace
- ✅ CSS imported from code that goes through an HTML import (bundled), or through Vite
- ✅ CSS imported from server code (`import "./x.css"`, also `.module.css`) is `{}`, as in Bun's runtime. In a page served without bundling, it is linked as a stylesheet and CSS module class names map to themselves.
- ✅ `ws` that isn't installed is Bun's own, as in Bun: `import`, `require`, `import.meta.resolve` and `Bun.resolveSync` give it (an installed `ws` wins). Bun's other stand-ins for packages it has built in (`undici`, `node-fetch` and the like) aren't there
- ✅ `http:`/`https:` imports are left to the browser
- `rolldown` is replaced by the playground's own `@rolldown/browser`, since the native binding can't load

An import that can't be resolved shows `cannot resolve "x"` in the console.

`tsconfig.json` `paths`, `index.*` files and JSON imports, in one project:

```json playground group=resolve title="tsconfig.json"
{ "compilerOptions": { "paths": { "@lib/*": ["./src/lib/*"] } } }
```

```ts playground group=resolve title="src/lib/greet/index.ts"
export const greet = (name: string) => `Hello, ${name}`;
```

```json playground group=resolve title="src/config.json"
{ "name": "resolver" }
```

```ts playground group=resolve title="index.ts"
import { greet } from "@lib/greet";
import config from "./src/config.json";

console.log(greet(config.name));
```

## CommonJS and `require`

- ✅ CommonJS by Bun's rule, whatever the extension (`.js`, `.ts`, `.tsx`, `.cjs`, even `.mts`): a file that uses `module` or `exports` (or top-level `this`) is CommonJS unless it has an `export` or top-level `await`; otherwise the package's `"type"` decides, and without one a file that uses `require`, `__dirname`, `__filename` or `"use strict"` and has no `import` statement is CommonJS. Bun's parser makes the call. The program you run is the exception, as in Bun: its extension stands in for the package's `"type"`, so a `.cjs` or `.cts` program runs as CommonJS and a `.mjs` or `.mts` one as an ES module where its code doesn't decide (a `.mjs` program may call `require`). CommonJS features next to an `import` statement fail with Bun's error.
- ✅ `require("x")` with a string literal. Modules run on first `require`, as in Node; cycles see partial exports.
- ✅ Named imports from CommonJS, found by a static scan (`exports.x =`, `module.exports = { … }`, re-exports). Exports computed at runtime aren't visible as named imports.
- ✅ `require(variable)`, and `createRequire(import.meta.url)` and `import.meta.require` with any specifier: project files and installed packages load synchronously when required (TypeScript and JSX transpiled with the nearest `tsconfig.json`'s JSX and decorator options, as imported files are; data files parsed). They share one module instance with literal requires and imports, so a file loaded both ways runs once. A `require` that can't be resolved throws `MODULE_NOT_FOUND` when it runs, as in Bun.
- ✅ `require.resolve`, `require.cache` (deleting an entry loads the file again), `require.main`
- ✅ CommonJS in TypeScript or JSX, required or imported, may use the automatic JSX runtime, legacy decorators and `using`: the imports the transpiler adds for them become requires (an ES module that `require()` loads gets them too). Bun's runtime fails on such a file (a SyntaxError); this is the playground's extra.
- ✅ `require` in an ES module, as Bun defines it there (`import.meta.require`), with `require.resolve`, `require.cache` and `require.main` like `createRequire`'s; a module that declares its own (`const require = createRequire(import.meta.url)`) keeps it. `__filename` and `__dirname` are the module's path and folder, as in Bun; `module` and `exports` are undefined, as in Bun's ES modules
- 🟡 `require()` of an ES module returns its namespace, loading it synchronously when it runs, as in Bun (one with top-level `await` throws Bun's error). One that has been imported gives that instance; one that is required first is transpiled and run in the worker, and a later `import` of it gets that instance's exports (their values at the time of the import, not live, and not the same namespace object). A string-literal `require()` of an ES module that an ES module also imports (a project file, or a file of the same package) is imported up front instead, so the module runs before the one that requires it rather than at the `require`. A computed `require()` of a module that another module imports but that hasn't run yet throws `ERR_REQUIRE_ESM`: Bun would run it at the `require`. In a page (a preview's `<script type="module">`), literal `require()`s of ES modules are imported up front.
- 🟡 An ES module that imports CommonJS also sees `__cjs` and `__cjsModule` in its namespace (`import * as ns`), the playground's own exports
- ❌ Native `.node` addons

```js playground group=cjs title="counter.cjs"
let count = 0;
exports.next = () => ++count;
module.exports.name = "counter";
```

```ts playground group=cjs title="index.ts"
import { next, name } from "./counter.cjs";

const again = import.meta.require("./counter.cjs");
next();
console.log(name, again.next()); // one module instance: counter 2
```

## `bun install`

Runs in the console (`bun install`, `bun add`, `bun remove`) and automatically when a project opens with missing dependencies.

- ✅ Packages from the npm registry, with Bun's semver
- ✅ `dependencies`, `devDependencies`, `optionalDependencies` and required peer dependencies
- ✅ `bun.lock` (text format): exact versions, nested `node_modules`, integrity checks
- ✅ Without a `bun.lock`, the install resolves versions and nests conflicting ones in `node_modules` as Bun does, and writes the `bun.lock` Bun would: native `bun install --frozen-lockfile` accepts it
- ✅ When `package.json` changes (by hand, `bun add` or `bun remove`), the next install updates `bun.lock`: the other dependencies keep their locked versions
- ✅ Packages that `bun.lock` no longer lists (after `bun remove`, or a dependency's own dependencies that changed) are removed from `node_modules`
- ✅ Optional packages limited to other platforms (native bindings) are skipped
- ✅ A package with native bindings that leaves its `-wasm32-wasi` binding out of `optionalDependencies` (oxc-parser) gets it installed anyway, when one is published. It stays out of `bun.lock`, as native Bun doesn't install it
- ✅ A package cache shared by all projects, kept across reloads: a downloaded tarball isn't downloaded again, and package metadata is reused for 5 minutes, as in Bun. Past that, it is still reused when the first dependency on that package in an install names an exact version (`"1.2.3"`) the cached metadata lists; other ranges of the package in the same install then resolve against it too. One it can't satisfy fetches the metadata again; one it can may get an older matching version than a fresh fetch would. `bun pm cache` shows its size, `bun pm cache rm` clears it.
- ✅ Tarball URLs, `file:` folders and tarballs (`file:vendor/pkg.tgz`, `./pkg.tgz`) and `npm:` aliases, written to `bun.lock` as Bun writes them
- ✅ `link:` dependencies: `bun link` in a package's folder registers it, and `"pkg": "link:pkg"` (or `bun link pkg`, which also adds it to `package.json`) installs it. Bun's registry of linked folders is global; here it belongs to the project (`node_modules/.bun-links.json`), and a linked folder is copied to `node_modules/<name>` with its edits copied along, as for a workspace. `bun unlink` forgets it
- 🟡 Git dependencies hosted on GitHub: `github:user/repo#ref`, the `user/repo` shorthand, `git+https://github.com/…`, `git://github.com/…` and `https://github.com/user/repo`, from the tarball GitHub makes of the commit (through the playground's git proxy, since GitHub sends no CORS headers for it), with the commit and integrity in `bun.lock` as Bun writes them. A git dependency on another host or over ssh needs a `git clone`, which doesn't work in the browser: it is reported and `bun.lock` isn't written. No `#semver:` ranges
- 🟡 Lifecycle scripts, as Bun runs them: the root's `preinstall` first, then `preinstall`, `install` and `postinstall` of each newly installed dependency that `trustedDependencies` lists (or, without that field, that is on Bun's default list), then the workspaces' and the root's `install`, `postinstall` and `prepare`. A dependency's untrusted scripts are skipped: `Blocked 2 postinstalls`, `bun pm untrusted` lists them and `bun pm trust <pkg>` (or `--all`) trusts them and runs them; `bun.lock` gets `trustedDependencies` as Bun writes it. `bun install --ignore-scripts` runs none. Each script is a line in Bun's shell in a worker of its own (cwd the package's folder, `npm_lifecycle_event` and the other `npm_*` variables, `node_modules/.bin` on `PATH`). A script that builds a native addon (`node-gyp rebuild`, `prebuild-install`) fails with an error that says so, and one that runs longer than 2 minutes is stopped; esbuild's and sharp's are skipped, as Bun skips them
- ✅ `patchedDependencies`: each patch is applied to its package as it installs, and `bun.lock` lists them as Bun does. `bun patch <pkg>` then `bun patch --commit node_modules/<pkg>` writes the patch native Bun writes (`patches/<pkg>@<version>.patch`) and adds it to `package.json`
- ✅ Workspaces: `"workspaces"` in the root `package.json` (an array or `{ "packages": [...] }`, with `*`, `**`, `{a,b}` and `!` patterns), `workspace:*`, `workspace:^`, `workspace:~` and exact `workspace:` versions, and a plain range that a workspace's version satisfies. Every workspace's own dependencies install, and `bun.lock` is the one native Bun writes (the workspaces, hoisted packages, `<workspace>/<package>` entries for a version a workspace needs of its own). The VFS has no symlinks, so each workspace is copied to `node_modules/<name>` where native Bun links it: edits to its files are copied along, a changed `package.json` needs a new install
- ✅ Catalogs: `"dep": "catalog:"` and `"catalog:name"` in the root and the workspaces, from `catalog` and `catalogs` in the root `package.json` (or in its `workspaces` object, which Bun prefers), written to `bun.lock` as Bun writes them; a changed catalog entry updates the lockfile
- 🟡 `overrides` (npm) and `resolutions` (yarn; Bun reads them only without `overrides`), as Bun reads them: a rule for a package name (also `**/name`) changes every dependency on it to the rule's version or range, `$name` (the root's or a workspace's range) and `catalog:` values included. Scoped rules work too: nested objects one level deep (`{ "parent": { "child": "1.0.0", ".": "2.0.0" } }`, `overrides` only), `parent/child` and `**/parent/child` (yarn), `parent>child` (pnpm), and `name@range` keys, which select the dependencies that declare an overlapping range. A parent can carry a range (`parent@^2`) that its installed version must satisfy. Of the rules that apply to a dependency, a ranged parent beats a plain parent, which beats none, and a rule whose key range matches beats one without. Keys and values Bun ignores with a warning (`-`, empty, `patch:`, deeper nesting, a dist-tag as a range) are ignored here, and an `overrides` that isn't an object fails the install. `bun.lock` gets the `overrides` section as Bun writes it, with `lockfileVersion` 3 once a rule is scoped. Whether two prerelease ranges overlap is decided by their bounds alone, without Bun's prerelease rules
- 🟡 The project's `.npmrc` (next to `package.json`; not the home folder's, nor the environment): `registry=` and `@scope:registry=` choose where packages are fetched from, and `//host/path/:_authToken=` and `:_auth=` give the credentials sent to URLs under that host and path (never to another, and nothing fetched with them is cached). A registry has to answer cross-origin requests (CORS, `Authorization` included) to work from a page. `bun.lock` records a package's tarball URL when it isn't under `registry.npmjs.org`, as Bun does. A line that uses `${VAR}` is skipped and reported
- ❌ Binary `bun.lockb`

Missing packages install before the first run:

```json playground group=install title="package.json"
{ "dependencies": { "picocolors": "^1.1.0", "zod": "^3.23.0" } }
```

```ts playground group=install title="index.ts"
import pc from "picocolors";
import { z } from "zod";

const User = z.object({ name: z.string(), age: z.number().int() });
console.log(pc.green("valid:"), User.safeParse({ name: "Ada", age: 36 }).success);
console.log(pc.red("invalid:"), User.safeParse({ name: "Ada", age: "old" }).success);
```

## Bundler

`Bun.build` and HTML imports use Bun's real bundler, compiled to WebAssembly (~7.5 MB, loaded on first use). See [`Bun.build`](/compatibility/bun/#the-bun-global) for the supported options.

- Single-threaded; each build starts fresh
- HTML imports in `Bun.serve` are built for the browser, without minification or source maps
- If a build fails, errors go to the console and the page is served unbundled

The first run downloads the bundler:

```ts playground group=build title="src/math.ts"
export const square = (n: number) => n * n;
export const unused = () => "tree-shaken away";
```

```ts playground group=build title="index.ts"
await Bun.write("src/entry.ts", 'import { square } from "./math";\nconsole.log(square(7));\n');

const result = await Bun.build({ entrypoints: ["./src/entry.ts"], outdir: "./dist", minify: true });
for (const output of result.outputs) console.log(output.path, output.size, "bytes");
console.log(await Bun.file("./dist/entry.js").text());
```
