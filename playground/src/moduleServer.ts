import { BASE } from "./base";
import { commonJSFacade, exportNames as commonJSExportNames, isCommonJS, reexports, wrapCommonJS } from "./cjs";
import bunWrap from "./bunWrap.js?raw";
import { transpile, type Resolver, type TsconfigFlags } from "./transpiler";
import { dirname, norm, type VFS } from "./vfs";
import hostNames, { version as hostVersion } from "virtual:host-package-names";
import { builtins, exportNames } from "./worker/node";

export type ModuleResponse = { status: number; body: string };

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];
/** Export conditions as Bun resolves them: its runtime for the worker, its dev server's for a page. */
const TARGET_CONDITIONS = {
  bun: new Set(["bun", "node", "import", "development", "default"]),
  browser: new Set(["browser", "module", "import", "development", "default"]),
};
export type ModuleTarget = keyof typeof TARGET_CONDITIONS;
/** For the resolution in progress; set by serveModule right before its synchronous rewrite. */
let CONDITIONS = TARGET_CONDITIONS.browser;

function resolveFile(vfs: VFS, p: string): string | null {
  if (vfs.files.has(p)) return p;
  for (const e of EXTS) if (vfs.files.has(p + e)) return p + e;
  for (const e of EXTS) if (vfs.files.has(`${p}/index${e}`)) return `${p}/index${e}`;
  return null;
}

function pickTarget(t: unknown): string | null {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    for (const x of t) {
      const r = pickTarget(x);
      if (r) return r;
    }
    return null;
  }
  if (t && typeof t === "object") {
    for (const [k, v] of Object.entries(t)) {
      if (!CONDITIONS.has(k)) continue;
      const r = pickTarget(v);
      if (r) return r;
    }
  }
  return null;
}

/** An `exports`/`imports` map entry for `key`: exact, else the longest `prefix*suffix` pattern. */
function lookup(map: Record<string, unknown>, key: string): string | null {
  if (key in map) return pickTarget(map[key]);
  let best: string | undefined;
  for (const k of Object.keys(map)) {
    const i = k.indexOf("*");
    if (i < 0 || !key.startsWith(k.slice(0, i)) || !key.endsWith(k.slice(i + 1)) || key.length < k.length - 1) continue;
    if (best === undefined || i > best.indexOf("*")) best = k;
  }
  if (best === undefined) return null;
  const i = best.indexOf("*");
  const t = pickTarget(map[best]);
  return t && t.replaceAll("*", key.slice(i, key.length - (best.length - i - 1)));
}

function pickExport(exports: unknown, sub: string): string | null {
  const isMap = exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith("."));
  if (!isMap) return sub === "." ? pickTarget(exports) : null;
  return lookup(exports as Record<string, unknown>, sub);
}

/** `"type"` of the nearest package.json above `path`. */
function packageType(vfs: VFS, path: string): string | undefined {
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

/** `compilerOptions` of the nearest tsconfig.json above `path` (comments and trailing commas allowed; no `extends`). */
export function tsconfigFor(vfs: VFS, path: string): TsconfigFlags {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const text = vfs.readText(dir ? `${dir}/tsconfig.json` : "tsconfig.json");
    if (text !== undefined) {
      try {
        const json = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "$1").replace(/,(\s*[}\]])/g, "$1");
        return (JSON.parse(json) as { compilerOptions?: TsconfigFlags }).compilerOptions ?? {};
      } catch {
        return {};
      }
    }
    if (!dir) return {};
  }
}

/** Nearest `node_modules/<name>` walking up from `fromDir`, like Node's lookup. */
function findPackage(vfs: VFS, name: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const base = norm(`${dir}/node_modules/${name}`);
    if (vfs.files.has(`${base}/package.json`)) return base;
    if (!dir) return null;
    dir = dirname(dir);
    if (dir.endsWith("/node_modules")) dir = dirname(dir);
  }
}

/** `#name` specifiers: the nearest package.json's `imports` field. */
function resolveImports(vfs: VFS, spec: string, fromDir: string): string | null {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const text = vfs.readText(dir ? `${dir}/package.json` : "package.json");
    if (text !== undefined) {
      const imports = (JSON.parse(text) as { imports?: Record<string, unknown> }).imports;
      if (!imports) return null;
      const t = lookup(imports, spec);
      if (!t) return null;
      return t.startsWith(".") ? resolveFile(vfs, norm(`${dir}/${t}`)) : resolveBare(vfs, t, dir);
    }
    if (!dir) return null;
  }
}

function resolveBare(vfs: VFS, spec: string, fromDir: string): string | null {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const sub = "." + spec.slice(name.length);
  const base = findPackage(vfs, name, fromDir);
  if (base === null) return null;
  const text = vfs.readText(`${base}/package.json`)!;
  const pkg = JSON.parse(text) as { exports?: unknown; module?: string; main?: string; browser?: unknown };
  // napi-rs wasm bindings: the Node entry needs node:wasi and worker_threads, the browser one runs anywhere here.
  if (name.endsWith("-wasm32-wasi") && sub === "." && typeof pkg.browser === "string") return resolveFile(vfs, norm(`${base}/${pkg.browser}`));
  if (pkg.exports !== undefined) {
    const t = pickExport(pkg.exports, sub);
    return t ? resolveFile(vfs, norm(`${base}/${t}`)) : null;
  }
  if (sub !== ".") return resolveFile(vfs, norm(`${base}/${sub}`));
  const entry = pkg.module ?? pkg.main ?? "index.js";
  return resolveFile(vfs, norm(`${base}/${entry}`));
}

let warned = false;
/** Warn once if the user's installed rolldown differs from the host's @rolldown/browser. */
function checkHostVersion(vfs: VFS) {
  if (warned) return;
  warned = true;
  const text = vfs.readText("node_modules/rolldown/package.json");
  const v = text && (JSON.parse(text) as { version?: string }).version;
  if (v && v !== hostVersion) console.warn(`rolldown ${v} is installed, but the playground supplies @rolldown/browser ${hostVersion}`);
}

const CREATE_REQUIRE = /\bcreateRequire\(import\.meta\.url\)/g;

/**
 * Bundles like Vite's call `__require("x")` on a `createRequire(import.meta.url)`; napi-rs loaders and others `require("x")`.
 * Literal specifiers that resolve become static imports, and the created require serves them (as wrapped CommonJS
 * does); others fall through. Relative ones only for JSON: hoisting runs a module even if its require() never does.
 * Literal `require.resolve` calls are resolved here too.
 */
function hoistRequires(vfs: VFS, code: string, dir: string, url: (spec: string) => string): string {
  if (!code.includes("createRequire(import.meta.url)")) return code;
  // Literal `require.resolve("x")` becomes the path it resolves to.
  code = code.replace(/(?<![\w$.])(?:__)?require\.resolve\(\s*(["'])([^"'\n]+)\1\s*\)/g, (m, _q: string, s: string) => {
    const p = s.startsWith(".") ? resolveFile(vfs, norm(`${dir}/${s}`)) : s.replace(/^node:/, "") in builtins ? null : resolveBare(vfs, s, dir);
    return p ? JSON.stringify("/" + p) : m;
  });
  const specs = [...new Set([...code.matchAll(/(?<![\w$.])(?:__)?require\(\s*(["'])([^"'\n]+)\1\s*\)/g)].map((m) => m[2]))].filter((s) => !(s.replace(/^node:/, "") in builtins) && (s.startsWith(".") ? s.endsWith(".json") && resolveFile(vfs, norm(`${dir}/${s}`)) : resolveBare(vfs, s, dir)));
  if (!specs.length) return code;
  const imports = specs.map((s, i) => `import * as __h${i} from ${JSON.stringify(url(s))};`).join("");
  const table = specs.map((s, i) => `${JSON.stringify(s)}: __h${i}`).join(", ");
  return `${imports}const __hoisted = { ${table} };
const __withHoisted = (r) => Object.assign((id) => (id in __hoisted ? ("__cjs" in __hoisted[id] ? __hoisted[id].__cjs : id.endsWith(".json") ? __hoisted[id].default : __hoisted[id]) : r(id)), r);
${code.replace(CREATE_REQUIRE, "__withHoisted($&)")}`;
}

/**
 * Bun has a synchronous `import.meta.require` (Vite uses it for `ws`). Literal specifiers that resolve become static
 * imports; Node built-ins and `bun:<spec>` fallbacks come from the registry; anything else throws when called.
 */
function hoistMetaRequire(vfs: VFS, code: string, dir: string, url: (spec: string) => string): string {
  if (!code.includes("import.meta.require")) return code;
  const lits = [...new Set([...code.matchAll(/\bimport\.meta\.require\(\s*"([^"\n]+)"\s*\)/g)].map((m) => m[1]))];
  const specs = lits.filter((s) => !(s.replace(/^node:/, "") in builtins) && (s.startsWith(".") ? resolveFile(vfs, norm(`${dir}/${s}`)) : resolveBare(vfs, s, dir)));
  const imports = specs.map((s, i) => `import * as __mr${i} from ${JSON.stringify(url(s))};`).join("");
  const table = specs.map((s, i) => `${JSON.stringify(s)}: __mr${i}`).join(", ");
  return `${imports}const __metaRequire = ((t, b) => (id) => {
  const n = String(id).replace(/^node:/, "");
  if (n in b) return b[n];
  if (id in t) return "__cjs" in t[id] ? t[id].__cjs : t[id];
  if ("bun:" + id in b) return b["bun:" + id];
  throw new Error("import.meta.require: cannot require " + JSON.stringify(id) + " (only literal specifiers of installed packages or built-ins are supported)");
})({ ${table} }, globalThis.__nodeBuiltins);
${code.replace(/\bimport\.meta\.require\b/g, "__metaRequire")}`;
}

/** Where `spec` imported from `dir` is served, relative to `/__vfs/`; null if it doesn't resolve. */
function resolveTarget(vfs: VFS, spec: string, dir: string): string | null {
  const builtin = spec.replace(/^node:/, "");
  if (spec === "bun:wrap") return "__bun/wrap";
  if (spec in hostNames) {
    checkHostVersion(vfs);
    return `__host/${spec}`;
  }
  if (spec.startsWith("node:") || builtin in builtins) return builtin in builtins ? `__node/${builtin}` : null;
  if (spec.startsWith(".")) return resolveFile(vfs, norm(`${dir}/${spec}`));
  if (spec.startsWith("/")) return resolveFile(vfs, norm(spec));
  if (spec.startsWith("#")) return resolveImports(vfs, spec, dir);
  return resolveBare(vfs, spec, dir);
}

/** The transpiler's resolver: where each specifier in a module of `dir` is served. */
function resolver(vfs: VFS, dir: string): Resolver {
  const url = specifierUrl(vfs, dir);
  return (spec) => url(spec);
}

/** The URL a module imported as `spec` from `dir` is served at; remote and already-final specifiers stay as written. */
function specifierUrl(vfs: VFS, dir: string): (spec: string) => string | null {
  return (spec) => {
    if (/^(https?:|data:|blob:)/.test(spec) || spec.startsWith(`${BASE}__vfs/`)) return null;
    return `${BASE}__vfs/${resolveTarget(vfs, spec, dir) ?? `__unresolved__/${encodeURIComponent(spec)}`}`;
  };
}

const REGEX_AFTER = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

/** Sorted `[start, end)` ranges of strings, template text, comments and regex literals: everything that isn't code. */
function literalRanges(code: string): [number, number][] {
  const ranges: [number, number][] = [];
  const n = code.length;
  const stack: number[] = []; // brace depths at which an open template literal resumes
  let depth = 0;
  let i = 0;
  let prev = ""; // last significant code character
  const template = () => {
    const from = i;
    for (; i < n; i++) {
      if (code[i] === "\\") i++;
      else if (code[i] === "`") return void ranges.push([from, ++i]);
      else if (code[i] === "$" && code[i + 1] === "{") {
        stack.push(depth++);
        return void ranges.push([from, (i += 2)]);
      }
    }
    ranges.push([from, n]);
  };
  while (i < n) {
    const c = code[i];
    const from = i;
    if (c === "/" && code[i + 1] === "/") i = code.indexOf("\n", i) < 0 ? n : code.indexOf("\n", i);
    else if (c === "/" && code[i + 1] === "*") i = code.indexOf("*/", i + 2) < 0 ? n : code.indexOf("*/", i + 2) + 2;
    else if (c === '"' || c === "'") {
      for (i++; i < n && code[i] !== c; i += code[i] === "\\" ? 2 : 1);
      i++;
      prev = c;
    } else if (c === "`") {
      i++;
      template();
      ranges.at(-1)![0] = from;
      prev = "`";
      continue;
    } else if (c === "/" && (!prev || !/[\w$)\]}"'`]/.test(prev) || REGEX_AFTER.test(code.slice(Math.max(0, i - 12), i).trimEnd()))) {
      for (i++; i < n && code[i] !== "/" && code[i] !== "\n"; i += code[i] === "\\" ? 2 : 1) if (code[i] === "[") for (i++; i < n && code[i] !== "]" && code[i] !== "\n"; i += code[i] === "\\" ? 2 : 1);
      i++;
      prev = "/";
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (stack.length && stack[stack.length - 1] === depth) {
          stack.pop();
          template();
          prev = "`";
          continue;
        }
      }
      if (!/\s/.test(c)) prev = c;
      i++;
      continue;
    }
    ranges.push([from, Math.min(i, n)]);
  }
  return ranges;
}

/** Whether `pos` lies in one of the sorted `ranges`. */
function inRanges(ranges: [number, number][], pos: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pos < ranges[mid][0]) hi = mid - 1;
    else if (pos >= ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * chokidar (bundled in Vite) tracks a watched root "/" as a child of itself (`basename("/")` is ""), then sees that
 * child missing on the first directory read and reports every file unlinked. Skip the empty name there.
 */
function patchChokidar(code: string): string {
  return code.includes("_handleRead(") ? code.replace(/(\bitem\s*!==\s*directory\s*&&)(\s*!current\.has\(item\))/, "$1 item !== \"\" &&$2") : code;
}

/** Whether the parameter list that starts before `from` is followed by a body: `import(url) {` is a method named import. */
function isMethod(code: string, from: number): boolean {
  let depth = 1;
  let i = from;
  for (; i < code.length && depth; i++) depth += code[i] === "(" ? 1 : code[i] === ")" ? -1 : 0;
  return /^\s*\{/.test(code.slice(i, i + 32));
}

const META_RE = /(?<![\w$.])import\.meta\.(url|dirname|filename)\b|(?<![\w$.])import\s*\(\s*(?!["'\s])/g;

/**
 * `import.meta.url` & co. point at a `file:` URL of the module's VFS path, as Node and Bun have them. With
 * `dynamicImports`, `import(expr)` with a computed specifier goes through the worker's `__dynamicImport`, which loads
 * `file:` URLs and paths from the VFS (literal ones are resolved from the transpiler's import records). Only code is touched, not strings,
 * templates, comments or regex literals.
 */
function rewriteMeta(code: string, path: string, dynamicImports: boolean): string {
  const value = { url: `file:///${path}`, dirname: "/" + dirname(path), filename: "/" + path };
  const literal = literalRanges(code);
  return code.replace(META_RE, (m, meta: keyof typeof value | undefined, offset: number) => {
    if (inRanges(literal, offset)) return m;
    if (meta) return JSON.stringify(value[meta]);
    return dynamicImports && !isMethod(code, offset + m.length) ? `globalThis.__dynamicImport(${JSON.stringify(value.url)}, ` : m;
  });
}

/** The module for a Node built-in: the worker registers the real object as `globalThis.__nodeBuiltins`. */
function builtinModule(name: string): string {
  const names = exportNames(name);
  // bun:sqlite's wasm loads asynchronously, before anything is exported
  const pre = name === "bun:sqlite" ? "await globalThis.__loadBunSqlite();\n" : "";
  return `${pre}const m = globalThis.__nodeBuiltins[${JSON.stringify(name)}];
export default m;
export const __cjs = m;
${names.length ? `export const { ${names.join(", ")} } = m;` : ""}`;
}

/** The host package whose installed entry file is `path`: Vite's module runner imports externals by file URL. */
function hostEntry(vfs: VFS, path: string): string | undefined {
  if (!path.startsWith("node_modules/rolldown/")) return undefined;
  CONDITIONS = TARGET_CONDITIONS.bun;
  return Object.keys(hostNames).find((spec) => resolveBare(vfs, spec, "") === path);
}

/** The module for a host package: the worker loads it on demand as `globalThis.__hostPackage(spec)`. */
function hostModule(spec: string): string {
  const names = hostNames[spec].filter((k) => k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k));
  return `const __m = await globalThis.__hostPackage(${JSON.stringify(spec)});
export default ${hostNames[spec].includes("default") ? "__m.default" : "__m"};
${names.length ? `export const { ${names.join(", ")} } = __m;` : ""}`;
}

/** Export names of a CommonJS file, with those of the CommonJS files it re-exports. */
function commonJSNames(vfs: VFS, path: string, src: string, seen = new Set<string>()): string[] {
  seen.add(path);
  const names = new Set(commonJSExportNames(src));
  for (const spec of reexports(src)) {
    const t = resolveTarget(vfs, spec, dirname(path));
    const dep = t && !t.startsWith("__") && !seen.has(t) ? vfs.readText(t) : undefined;
    if (dep !== undefined && isCommonJS(t!, dep, packageType(vfs, t!))) for (const n of commonJSNames(vfs, t!, dep, seen)) names.add(n);
  }
  return [...names];
}

/** The body of a CommonJS file (see wrapCommonJS); requires of other CommonJS files load their bodies too. */
async function serveCommonJS(vfs: VFS, path: string, onError: (msg: string) => void, target: ModuleTarget): Promise<ModuleResponse> {
  const src = vfs.readText(path);
  if (src === undefined) {
    onError(`module not found: ${path}`);
    return { status: 404, body: `Not found: ${path}` };
  }
  CONDITIONS = TARGET_CONDITIONS[target];
  const dir = dirname(path);
  const code = wrapCommonJS(path, src, (spec) => {
    const t = resolveTarget(vfs, spec, dir);
    if (t === null || t.startsWith("__")) return t && `${BASE}__vfs/${t}`;
    const dep = vfs.readText(t);
    return `${BASE}__vfs/${dep !== undefined && isCommonJS(t, dep, packageType(vfs, t)) ? "__cjs/" : ""}${t}`;
  });
  // The body is plain source: its `import("x")` calls still need their specifiers resolved.
  try {
    return { status: 200, body: await transpile(rewriteMeta(code, path, target === "bun"), `${path}.js`, {}, resolver(vfs, dir)) };
  } catch (e) {
    const msg = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    onError(msg);
    return { status: 500, body: msg };
  }
}

export async function serveModule(vfs: VFS, rawPath: string, onError: (msg: string) => void, target: ModuleTarget = "browser"): Promise<ModuleResponse> {
  const path = norm(rawPath);
  if (path.startsWith("__node/")) return { status: 200, body: builtinModule(path.slice(7)) };
  if (path.startsWith("__host/")) return { status: 200, body: hostModule(path.slice(7)) };
  if (path === "__bun/wrap") return { status: 200, body: bunWrap };
  if (path.startsWith("__unresolved__/")) {
    const msg = `cannot resolve "${decodeURIComponent(path.slice(15))}"`;
    onError(msg);
    return { status: 404, body: msg };
  }
  if (path.startsWith("__cjs/")) return serveCommonJS(vfs, path.slice(6), onError, target);
  const host = hostEntry(vfs, path);
  if (host) return { status: 200, body: hostModule(host) };
  const src = vfs.readText(path);
  if (src === undefined) {
    onError(`module not found: ${path}`);
    return { status: 404, body: `Not found: ${path}` };
  }
  try {
    let code: string;
    if (path.endsWith(".html")) return { status: 200, body: `export default ${JSON.stringify({ __htmlImport: path })};` };
    if (path.endsWith(".css")) return { status: 200, body: src };
    // __cjsModule() as wrapped CommonJS has it: a require() can run before this module is evaluated.
    if (path.endsWith(".json")) code = `var __m;\nexport function __cjsModule() {\n  return (__m ??= { exports: ${src} });\n}\nexport default __cjsModule().exports;`;
    else if (/\.(ts|tsx|jsx)$/.test(path)) {
      CONDITIONS = TARGET_CONDITIONS[target];
      code = await transpile(src, path, tsconfigFor(vfs, path), resolver(vfs, dirname(path)));
    }
    else if (isCommonJS(path, src, packageType(vfs, path))) {
      CONDITIONS = TARGET_CONDITIONS[target];
      return { status: 200, body: commonJSFacade(commonJSNames(vfs, path, src), `${BASE}__vfs/__cjs/${path}`) };
    }
    else {
      // Plain ES module: Bun's parser finds the specifiers, as `bun build --no-bundle` does.
      CONDITIONS = TARGET_CONDITIONS[target];
      code = await transpile(src, path, {}, resolver(vfs, dirname(path)));
    }
    CONDITIONS = TARGET_CONDITIONS[target];
    // The hoisted imports are final URLs already (the transpiler leaves those alone).
    const dir = dirname(path);
    const url = specifierUrl(vfs, dir);
    const final = (spec: string) => url(spec) ?? spec;
    return { status: 200, body: rewriteMeta(hoistMetaRequire(vfs, hoistRequires(vfs, patchChokidar(code), dir, final), dir, final), path, target === "bun") };
  } catch (e) {
    const msg = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    onError(msg);
    return { status: 500, body: msg };
  }
}
