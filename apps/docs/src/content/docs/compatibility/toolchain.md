---
title: Toolchain
description: Transpiler, type checking, bun fmt, module resolution, CommonJS, bun install and the bundler in the playground.
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
- ✅ Hover info: rest the pointer on a name for its type and documentation (JSDoc, with examples)
- ✅ Completions: members after `.`, names in scope, keywords, and import paths, each with its type and documentation. Auto-imports offer what the project's other files, its installed packages and Bun's and Node's built-in modules (`bun:sqlite`, `node:fs`) export, and add the import
- ✅ Parameter hints in calls: the signature, its overloads, and the current parameter's documentation
- ❌ No go-to-definition yet
- ❌ No `tsc` command in the console

## Formatter (`bun fmt`)

Bun's own formatter, compiled to WebAssembly. It formats like Prettier, and its output matches `bun fmt` byte for byte:
each file goes through `bun fmt --stdin-filepath`, Bun's own code, with the project's files. It loads the first time you
format (~2.3 MB compressed). Use **Format** in the tab bar or <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> for the open
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
- ✅ CSS imported from code that goes through an HTML import (bundled), or through Vite
- ✅ CSS imported from server code (`import "./x.css"`, also `.module.css`) is `{}`, as in Bun's runtime. In a page served without bundling, it is linked as a stylesheet and CSS module class names map to themselves.
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

- ✅ CommonJS by Bun's rule, whatever the extension (`.js`, `.ts`, `.tsx`, `.cjs`, even `.mts`): a file that uses `module` or `exports` (or top-level `this`) is CommonJS unless it has an `export` or top-level `await`; otherwise the package's `"type"` decides, and without one a file that uses `require`, `__dirname`, `__filename` or `"use strict"` and has no `import` statement is CommonJS. Bun's parser makes the call. CommonJS features next to an `import` statement fail with Bun's error.
- ✅ `require("x")` with a string literal. Modules run on first `require`, as in Node; cycles see partial exports.
- ✅ Named imports from CommonJS, found by a static scan (`exports.x =`, `module.exports = { … }`, re-exports). Exports computed at runtime aren't visible as named imports.
- ✅ `require(variable)`, and `createRequire(import.meta.url)` and `import.meta.require` with any specifier: project files and installed packages load synchronously when required (TypeScript and JSX transpiled with the nearest `tsconfig.json`'s JSX and decorator options, as imported files are; data files parsed). They share one module instance with literal requires and imports, so a file loaded both ways runs once. A `require` that can't be resolved throws `MODULE_NOT_FOUND` when it runs, as in Bun.
- ✅ `require.resolve`, `require.cache` (deleting an entry loads the file again), `require.main`
- ✅ CommonJS in TypeScript or JSX that `require()` loads may use the automatic JSX runtime, legacy decorators and `using`: the imports the transpiler adds for them become requires. Bun's runtime fails on such a file (a SyntaxError); this is the playground's extra.
- ✅ `require` in an ES module, as Bun defines it there (`import.meta.require`); a module that declares its own (`const require = createRequire(import.meta.url)`) keeps it. `__filename` and `__dirname` are the module's path and folder, as in Bun; `module` and `exports` are undefined, as in Bun's ES modules
- 🟡 `require()` of an ES module returns its namespace, loading it synchronously when it runs, as in Bun (one with top-level `await` throws Bun's error). One that has been imported gives that instance; one that is required first is transpiled and run in the worker, and a later `import` of it gets that instance's exports (their values at the time of the import, not live, and not the same namespace object). A module that another module imports but that hasn't run yet can't be required (`ERR_REQUIRE_ESM`): Bun would run it at the `require`. In a page (a preview's `<script type="module">`), literal `require()`s of ES modules are imported up front instead.
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
- ✅ `bun.lock` (text format): exact versions, nested `node_modules`, integrity checks. A stale lockfile logs a warning.
- ✅ Optional packages limited to other platforms (native bindings) are skipped
- 🟡 Without a lockfile, the install is flat: the first version seen wins
- ❌ No `bun.lock` is written. `bun add` refuses to run when a `bun.lock` exists.
- ❌ No lifecycle scripts (`postinstall`, …)
- ❌ No git, tarball, `file:`, `workspace:` or `npm:` dependencies
- ❌ Only `registry.npmjs.org`; `.npmrc` isn't read
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
