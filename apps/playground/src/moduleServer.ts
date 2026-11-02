import { BASE } from "./base";
import { commonJSFacade, exportNames as commonJSExportNames, isCommonJS, reexports, wrapCommonJS } from "./cjs";
import bunWrap from "./bunWrap.js?raw";
import type { Resolver, TsconfigFlags } from "./transpiler";
import { transpileCached } from "./transpileCache";
import { loadResolver, resolve, type ResolveKind } from "./resolver";
import { dirname, norm, type VFS } from "@runbun/vfs";
import hostNames, { version as hostVersion } from "virtual:host-package-names";
import { builtins, exportNames } from "./worker/node";

export type ModuleResponse = { status: number; body: string };

export type ModuleTarget = "bun" | "browser";
/** For the resolution in progress (the worker gets Bun's runtime conditions, a page its dev server's); set by serveModule right before its synchronous rewrite. */
let TARGET: ModuleTarget = "browser";

/** Bun's resolver (see resolver.ts): the VFS path `spec` imported from `dir` resolves to, or null. */
function resolveWith(vfs: VFS, spec: string, dir: string, kind: ResolveKind = "import"): string | null {
  // napi-rs wasm bindings: the Node entry needs node:wasi and worker_threads, the browser one runs anywhere here.
  const wasi = /^(?:@[^/]+\/)?[^/@][^/]*-wasm32-wasi$/.test(spec) ? findPackage(vfs, spec, dir) : null;
  const browser = wasi && (JSON.parse(vfs.readText(`${wasi}/package.json`)!) as { browser?: unknown }).browser;
  if (typeof browser === "string") return resolve(`./${browser.replace(/^\.\//, "")}`, wasi!, kind, TARGET);
  return resolve(spec, dir, kind, TARGET);
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
    const p = s.replace(/^node:/, "") in builtins ? null : resolveWith(vfs, s, dir, "require");
    return p ? JSON.stringify("/" + p) : m;
  });
  const specs = [...new Set([...code.matchAll(/(?<![\w$.])(?:__)?require\(\s*(["'])([^"'\n]+)\1\s*\)/g)].map((m) => m[2]))].filter((s) => !(s.replace(/^node:/, "") in builtins) && (!s.startsWith(".") || s.endsWith(".json")) && resolveWith(vfs, s, dir, "require"));
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
  const specs = lits.filter((s) => !(s.replace(/^node:/, "") in builtins) && resolveWith(vfs, s, dir, "require"));
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

/**
 * Where this page's modules are served: `/__vfs/@<client id>/`, so the service worker asks this page for them and not
 * another playground sharing it (a second tab, or embeds on one page). See `setVfsOwner`.
 */
let VFS_ROOT = `${BASE}__vfs/`;
export const vfsRoot = () => VFS_ROOT;
/** Called once the service worker has said which client this page is. */
export function setVfsOwner(clientId: string) {
  VFS_ROOT = `${BASE}__vfs/@${encodeURIComponent(clientId)}/`;
}

/** Where `spec` imported from `dir` is served, relative to `/__vfs/`; null if it doesn't resolve. CSS imported from code is `__css/<path>` (see cssModule). */
function resolveTarget(vfs: VFS, spec: string, dir: string, kind: ResolveKind = "import"): string | null {
  const t = resolveSpecifier(vfs, spec, dir, kind);
  return t?.endsWith(".css") ? `__css/${t}` : t;
}

function resolveSpecifier(vfs: VFS, spec: string, dir: string, kind: ResolveKind): string | null {
  const builtin = spec.replace(/^node:/, "");
  if (spec === "bun:wrap") return "__bun/wrap";
  if (spec in hostNames) {
    checkHostVersion(vfs);
    return `__host/${spec}`;
  }
  if (spec.startsWith("node:") || builtin in builtins) return builtin in builtins ? `__node/${builtin}` : null;
  return resolveWith(vfs, spec, dir, kind);
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
    return `${VFS_ROOT}${resolveTarget(vfs, spec, dir) ?? `__unresolved__/${encodeURIComponent(spec)}`}`;
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

const META_RE = /(?<![\w$.])import\.meta\.(url|dirname|filename|dir|file|path|env|main)\b|(?<![\w$.])import\s*\(\s*(?!["'\s])/g;

/**
 * `import.meta.url` & co. point at a `file:` URL of the module's VFS path, as Node and Bun have them. For the `bun`
 * target, Bun's own `dir`, `file`, `path`, `env` and `main` are filled in too, and `import(expr)` with a computed
 * specifier goes through the worker's `__dynamicImport`, which loads `file:` URLs and paths from the VFS (literal
 * ones are resolved from the transpiler's import records). Only code is touched, not strings, templates, comments
 * or regex literals.
 */
function rewriteMeta(code: string, path: string, bun: boolean): string {
  const value: Record<string, string> = { url: JSON.stringify(`file:///${path}`), dirname: JSON.stringify("/" + dirname(path)), filename: JSON.stringify("/" + path) };
  if (bun)
    Object.assign(value, {
      dir: value.dirname,
      path: value.filename,
      file: JSON.stringify(path.slice(path.lastIndexOf("/") + 1)),
      env: "globalThis.process.env",
      main: `(globalThis.Bun.main === ${value.filename})`,
    });
  const literal = literalRanges(code);
  return code.replace(META_RE, (m, meta: string | undefined, offset: number) => {
    if (inRanges(literal, offset)) return m;
    if (meta) return value[meta] ?? m;
    return bun && !isMethod(code, offset + m.length) ? `globalThis.__dynamicImport(${value.url}, ` : m;
  });
}

/**
 * A stylesheet imported from code. On the server it is `{}`, as in Bun's runtime. In a page (bundled HTML imports
 * handle their CSS themselves; this is the unbundled fallback) it links the stylesheet, and a CSS module's class
 * names map to themselves.
 */
function cssModule(path: string, target: ModuleTarget): string {
  if (target === "bun") return "const m = {};\nexport default m;\nexport const __esModule = true;\nexport const __cjs = m;";
  const href = JSON.stringify(`${VFS_ROOT}${path}`);
  const names = /\.module\.css$/.test(path) ? 'new Proxy({}, { get: (_, k) => (typeof k === "string" ? k : undefined) })' : "{}";
  return `if (!document.querySelector(\`link[href=\${CSS.escape(${href})}]\`)) document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: ${href} }));
const m = ${names};
export default m;
export const __cjs = m;`;
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
  TARGET = "bun";
  return Object.keys(hostNames).find((spec) => resolveWith(vfs, spec, "") === path);
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
  TARGET = target;
  const dir = dirname(path);
  const code = wrapCommonJS(path, src, (spec) => {
    const t = resolveTarget(vfs, spec, dir, "require");
    if (t === null || t.startsWith("__")) return t && `${VFS_ROOT}${t}`;
    const dep = vfs.readText(t);
    return `${VFS_ROOT}${dep !== undefined && isCommonJS(t, dep, packageType(vfs, t)) ? "__cjs/" : ""}${t}`;
  });
  // The body is plain source: its `import("x")` calls still need their specifiers resolved.
  try {
    return { status: 200, body: await transpileCached(rewriteMeta(code, path, target === "bun"), `${path}.js`, {}, resolver(vfs, dir)) };
  } catch (e) {
    const msg = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    onError(msg);
    return { status: 500, body: msg };
  }
}

export async function serveModule(vfs: VFS, rawPath: string, onError: (msg: string) => void, target: ModuleTarget = "browser"): Promise<ModuleResponse> {
  const path = norm(rawPath);
  await loadResolver(vfs);
  if (path.startsWith("__node/")) return { status: 200, body: builtinModule(path.slice(7)) };
  if (path.startsWith("__host/")) return { status: 200, body: hostModule(path.slice(7)) };
  if (path === "__bun/wrap") return { status: 200, body: bunWrap };
  if (path.startsWith("__unresolved__/")) {
    const msg = `cannot resolve "${decodeURIComponent(path.slice(15))}"`;
    onError(msg);
    return { status: 404, body: msg };
  }
  if (path.startsWith("__cjs/")) return serveCommonJS(vfs, path.slice(6), onError, target);
  if (path.startsWith("__css/")) {
    if (!vfs.files.has(path.slice(6))) {
      onError(`module not found: ${path.slice(6)}`);
      return { status: 404, body: `Not found: ${path.slice(6)}` };
    }
    return { status: 200, body: cssModule(path.slice(6), target) };
  }
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
      TARGET = target;
      code = await transpileCached(src, path, tsconfigFor(vfs, path), resolver(vfs, dirname(path)));
    }
    else if (isCommonJS(path, src, packageType(vfs, path))) {
      TARGET = target;
      return { status: 200, body: commonJSFacade(commonJSNames(vfs, path, src), `${VFS_ROOT}__cjs/${path}`) };
    }
    else {
      // Plain ES module: Bun's parser finds the specifiers, as `bun build --no-bundle` does.
      TARGET = target;
      code = await transpileCached(src, path, {}, resolver(vfs, dirname(path)));
    }
    TARGET = target;
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
