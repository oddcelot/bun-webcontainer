---
title: Toolchain
description: Transpiler, type checking, bun fmt, module resolution, CommonJS, bun install and the bundler in the playground.
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
- ❌ `tsconfig.json` `jsx` and `jsxImportSource` are not read by the transpiler (`paths` and `baseUrl` are, by the resolver); use the `@jsxImportSource` pragma for another JSX runtime

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
- ✅ Uses the nearest `tsconfig.json`, including `extends` (relative, from packages, or a list); without one, the options `bun init` writes plus `types: ["bun"]`
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
- ✅ JSON imports
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

- ✅ `.cjs` files, and `.js` files without ESM syntax in packages that aren't `"type": "module"`
- ✅ `require("x")` with a string literal. Modules run on first `require`, as in Node; cycles see partial exports.
- ✅ Named imports from CommonJS, found by a static scan (`exports.x =`, `module.exports = { … }`, re-exports). Exports computed at runtime aren't visible as named imports.
- ✅ `import.meta.require` with string literals
- 🟡 `createRequire(import.meta.url)` serves built-ins only; its `require("./x.cjs")` throws
- ❌ `require(variable)` throws. So does a `require` that can't be resolved, when it runs.
- ❌ `require.cache`, `require.main`, native `.node` addons

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
