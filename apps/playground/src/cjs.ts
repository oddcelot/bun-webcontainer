// CommonJS → ESM for modules served from /__vfs/. `require("x")` with a literal specifier that resolves becomes a
// static import, so dependencies are loaded up front (and run when required); anything else (a computed specifier)
// the worker loads synchronously when it runs (worker/node/module.ts), sharing one module cache with these.

import { dirname, type VFS } from "@runbun/vfs";
import { jsxKey, moduleKind } from "./transpiler";
import { tsconfigFor } from "./tsconfig";

const ESM_SYNTAX = /(^|[\n;])\s*(import(\s+[\w{*]|\s*[{*'"])|export\s*[{*]|export\s+\w)/;
const REQUIRE = /\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

/** Whole-line comments (`// x`, ` * x`), so `require()` in doc comments isn't hoisted into an import (and a cycle). */
const COMMENT_LINE = /^[ \t]*(?:\/\/|\/\*|\*).*$/gm;

/** `"type"` of the nearest package.json above `path`. */
export function packageType(vfs: { readText(path: string): string | undefined }, path: string): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const text = vfs.readText(dir ? `${dir}/package.json` : "package.json");
    if (text !== undefined) {
      try {
        return (JSON.parse(text) as { type?: string }).type;
      } catch {
        return undefined;
      }
    }
    if (!dir) return undefined;
  }
}

/** Whether `source` has `import`/`export` statements (a rough scan, as isCommonJS uses). */
export const hasModuleSyntax = (source: string) => ESM_SYNTAX.test(source);

/** Files Bun parses as JavaScript (and so may run as CommonJS). */
export const JS_LIKE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** By path: the verdict for a source (FNV-1a hash and length, not the text, which installed packages would double). */
const kinds = new Map<string, { hash: string; kind: "cjs" | "esm" | Error }>();
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${h >>> 0}:${s.length}`;
};

/**
 * Whether Bun runs the file at VFS `path` as CommonJS, as its parser decides (transpiler `moduleKind`): an export or
 * top-level await makes an ES module, a free `module` or `exports` CommonJS, else the package's `"type"` decides, and
 * with none a free `require`, `__dirname`, `__filename` or `"use strict"` means CommonJS unless there's an import
 * statement. The extension plays no part (`.mjs` with `module.exports` is CommonJS too), as in Bun. Throws Bun's error
 * for CommonJS features next to an import statement, or a syntax error. Cached by path and source.
 */
export function moduleKindOf(vfs: VFS, path: string, source: string): "cjs" | "esm" {
  if (!JS_LIKE.test(path)) return "esm";
  const tsconfig = tsconfigFor(vfs, path);
  const type = packageType(vfs, path);
  const hash = `${type}\0${jsxKey(tsconfig)}\0${fnv(source)}`;
  let hit = kinds.get(path);
  if (!hit || hit.hash !== hash) {
    let kind: "cjs" | "esm" | Error;
    try {
      kind = moduleKind(source, path, tsconfig, type);
    } catch (e) {
      kind = e instanceof Error ? e : new Error(String(e));
    }
    kinds.set(path, (hit = { hash, kind }));
  }
  if (hit.kind instanceof Error) throw hit.kind;
  return hit.kind;
}

/** `moduleKindOf` as a boolean; a file Bun can't run counts as an ES module (its error shows when it is served). */
export function isCommonJS(vfs: VFS, path: string, source: string): boolean {
  try {
    return moduleKindOf(vfs, path, source) === "cjs";
  } catch {
    return false;
  }
}

/**
 * TypeScript or JSX transpiled for a CommonJS wrapper: the transpiler declares `var __dirname = "…"` (and
 * `__filename`) for code that uses them, from the path it was given; dropped, so the wrapper's values show through.
 */
export const stripDirname = (code: string) => code.replace(/^var (?:__dirname|__filename) = "[^"\n]*"(?:, __filename = "[^"\n]*")?;\n/, "");

/** Names a CommonJS module assigns on `exports`, as far as a static scan can tell (like cjs-module-lexer). */
export function exportNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) names.add(m[1]);
  for (const m of source.matchAll(/Object\.defineProperty\(\s*(?:module\.)?exports\s*,\s*["']([A-Za-z_$][\w$]*)["']/g)) names.add(m[1]);
  const literal = source.match(/module\.exports\s*=\s*\{([^{}]*)\}/);
  if (literal) for (const m of literal[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=[:,]|$)/g)) names.add(m[1]);
  names.delete("default");
  names.delete("__esModule");
  return [...names];
}

/**
 * Specifiers of modules a CommonJS module re-exports wholesale, as cjs-module-lexer finds them: Babel's
 * `Object.keys(_x).forEach(...)` over `var _x = require("y")`, TypeScript's `__exportStar(require("y"), exports)`
 * and `module.exports = require("y")`.
 */
export function reexports(source: string): string[] {
  const vars = new Map<string, string>();
  for (const m of source.matchAll(/\b(?:var|let|const)\s+([\w$]+)\s*=\s*require\(\s*(["'])([^"'\n]+)\2\s*\)/g)) vars.set(m[1], m[3]);
  const out = new Set<string>();
  for (const m of source.matchAll(/\bObject\.keys\(\s*([\w$]+)\s*\)\.forEach\(/g)) if (vars.has(m[1])) out.add(vars.get(m[1])!);
  for (const m of source.matchAll(/\b__exportStar\(\s*require\(\s*(["'])([^"'\n]+)\1\s*\)/g)) out.add(m[2]);
  for (const m of source.matchAll(/\bmodule\.exports\s*=\s*require\(\s*(["'])([^"'\n]+)\1\s*\)/g)) out.add(m[2]);
  return [...out];
}

/**
 * The module that holds a CommonJS file's body, served at `/__vfs/__cjs/<path>`: the body runs when first required,
 * as in Node, so in a require cycle the importer gets the exports filled in so far. Nothing runs when the module is
 * evaluated: that order (dependencies first) isn't Node's. `depUrl(spec)` is the URL a literal require loads, null
 * if it can't load (an optional dependency), which then throws when called.
 */
export function wrapCommonJS(path: string, source: string, depUrl: (spec: string) => string | null): string {
  const deps = [...new Set([...source.replace(COMMENT_LINE, "").matchAll(REQUIRE)].map((m) => m[2]))].flatMap((s) => {
    const url = depUrl(s);
    return url ? [[s, url]] : [];
  });
  const imports = deps.map(([, url], i) => `import * as __req${i} from ${JSON.stringify(url)};`).join("\n");
  // A data file is its value (its default export); in the worker none is here (depUrl gives null: see dataModule).
  const table = deps.map(([s, url], i) => `${JSON.stringify(s)}: ${/\.(json|jsonc|json5|toml|ya?ml)$/.test(url) ? `{ __cjs: __req${i}.default }` : `__req${i}`}`).join(", ");
  const dir = path.split("/").slice(0, -1).join("/");
  const file = JSON.stringify("/" + path);
  // Function declarations: a require in a cycle can call __cjsModule() before this module is evaluated.
  // Wrapped CommonJS exports __cjsModule(), built-ins __cjs; anything else is an ES namespace.
  // In the worker, globalThis.__cjsLoad keeps the instance in require.cache, so a require(variable) of this file
  // (which the worker evaluates itself) gets the same one; it also gives this require resolve, cache and main.
  // Other requires go to the worker's globalThis.__cjsRequire; in a page, where neither exists, they throw.
  return `${imports}
function require(id) {
  const required = { ${table} };
  if (!(id in required)) {
    if (globalThis.__cjsRequire) return globalThis.__cjsRequire(id, ${file});
    throw Object.assign(new Error("Cannot find module " + JSON.stringify(id) + " from ${path} (only literal require() calls of installed modules are supported)"), { code: "MODULE_NOT_FOUND" });
  }
  const ns = required[id];
  return "__cjsModule" in ns ? ns.__cjsModule().exports : "__cjs" in ns ? ns.__cjs : ns;
}
function __run(module) {
  (function (exports, require, module, __filename, __dirname) {
${source}
  }).call(module.exports, module.exports, require, module, ${file}, ${JSON.stringify("/" + dir)});
}
var module;
export function __cjsModule() {
  if (globalThis.__cjsLoad) return globalThis.__cjsLoad(${file}, __run, require);
  if (!module) __run((module = { exports: {} }));
  return module;
}
`;
}

/**
 * What ES modules import for a CommonJS file: runs its body (`bodyUrl`, see wrapCommonJS) and exports the result,
 * `names` (exportNames, and those of re-exported modules) as named exports.
 */
export function commonJSFacade(names: string[], bodyUrl: string): string {
  return `import * as __body from ${JSON.stringify(bodyUrl)};
const module = __body.__cjsModule();
export function __cjsModule() {
  return __body.__cjsModule();
}
export const __cjs = module.exports;
export default module.exports && module.exports.__esModule && "default" in module.exports ? module.exports.default : module.exports;
${names.length ? `const { ${names.map((n, i) => `${n}: __e${i}`).join(", ")} } = module.exports;
export { ${names.map((n, i) => `__e${i} as ${n}`).join(", ")} };` : ""}
`;
}
