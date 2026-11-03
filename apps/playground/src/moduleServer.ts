import { BASE } from "./base";
import { commonJSFacade, exportNames as commonJSExportNames, isCommonJS, packageType, reexports, wrapCommonJS } from "./cjs";
import bunWrap from "./bunWrap.js?raw";
import type { Resolver } from "./transpiler";
import { transpileCached } from "./transpileCache";
import { tsconfigFor } from "./tsconfig";
import { inRanges, isMethod, literalRanges } from "./literals";
import { DATA_FILE, dataFormat, loadResolver, parseDataFile, resolve, type DataFormat, type ResolveKind } from "./resolver";
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
  // In the worker, data files load when required instead (see dataModule).
  const hoist = (s: string) => {
    const t = resolveWith(vfs, s, dir, "require");
    return !!t && !(TARGET === "bun" && DATA_FILE.test(t));
  };
  const specs = [...new Set([...code.matchAll(/(?<![\w$.])(?:__)?require\(\s*(["'])([^"'\n]+)\1\s*\)/g)].map((m) => m[2]))].filter((s) => !(s.replace(/^node:/, "") in builtins) && (!s.startsWith(".") || DATA_FILE.test(s)) && hoist(s));
  if (!specs.length) return code;
  const imports = specs.map((s, i) => `import * as __h${i} from ${JSON.stringify(url(s))};`).join("");
  const table = specs.map((s, i) => `${JSON.stringify(s)}: __h${i}`).join(", ");
  return `${imports}const __hoisted = { ${table} };
const __withHoisted = (r) => Object.assign((id) => (id in __hoisted ? ("__cjs" in __hoisted[id] ? __hoisted[id].__cjs : /\\.(json|jsonc|json5|toml|ya?ml)$/.test(id) ? __hoisted[id].default : __hoisted[id]) : r(id)), r);
${code.replace(CREATE_REQUIRE, "__withHoisted($&)")}`;
}

/** What the transpiler starts a module that uses a free `require` with (`transpile`'s `metaRequire`), as Bun does. */
const META_REQUIRE = "var {require}=import.meta;";

/**
 * The transpiler declares `__dirname` and `__filename` at the top of a module that uses them, from the path it was
 * given (the VFS path, without the leading `/`): Bun's values instead, `import.meta.dir` and `import.meta.path`.
 */
function esmDirname(code: string, path: string): string {
  const at = code.startsWith(META_REQUIRE) ? META_REQUIRE.length : 0;
  const q = JSON.stringify;
  const dir = dirname(path);
  const decls: [string, string][] = [
    [`var __dirname = ${q(dir)}, __filename = ${q(path)};`, `var __dirname = ${q("/" + dir)}, __filename = ${q("/" + path)};`],
    [`var __dirname = ${q(dir)};`, `var __dirname = ${q("/" + dir)};`],
    [`var __filename = ${q(path)};`, `var __filename = ${q("/" + path)};`],
  ];
  for (const [decl, value] of decls) if (code.startsWith(decl, at)) return code.slice(0, at) + value + code.slice(at + decl.length);
  return code;
}

/**
 * Bun has a synchronous `import.meta.require` (Vite uses it for `ws`), which is also `require` in an ES module.
 * Literal specifiers that resolve become static imports; Node built-ins and `bun:<spec>` fallbacks come from the
 * registry; in the worker, anything else loads when called (see worker/node/module.ts).
 *
 * A free `require`'s literal specifiers are imported up front only if they are ES modules, which the worker can't load
 * synchronously; CommonJS and data files load when required, as in Bun. (Calls on a `require` the module binds
 * itself in some inner scope match too: such a module is then loaded with this one, not when that require runs.)
 */
function hoistMetaRequire(vfs: VFS, code: string, path: string, dir: string, url: (spec: string) => string, free: boolean): string {
  if (!code.includes("import.meta.require")) return code;
  const lits = [...new Set([...code.matchAll(/\bimport\.meta\.require\(\s*"([^"\n]+)"\s*\)/g)].map((m) => m[1]))];
  if (free) {
    const literal = literalRanges(code);
    for (const m of code.matchAll(/(?<![\w$.])require\(\s*(["'])([^"'\n]+)\1\s*\)/g)) {
      const t = inRanges(literal, m.index) ? null : resolveWith(vfs, m[2], dir, "require");
      const src = t && !DATA_FILE.test(t) && !/\.(css|node)$/.test(t) ? vfs.readText(t) : undefined;
      if (src !== undefined && !isCommonJS(t!, src, packageType(vfs, t!))) lits.push(m[2]);
    }
  }
  // In the worker, data files load when required (see dataModule): an import here would make them return their namespace.
  const specs = [...new Set(lits)].filter((s) => {
    if (s.replace(/^node:/, "") in builtins) return false;
    const t = resolveWith(vfs, s, dir, "require");
    return !!t && !(TARGET === "bun" && DATA_FILE.test(t));
  });
  const imports = specs.map((s, i) => `import * as __mr${i} from ${JSON.stringify(url(s))};`).join("");
  const table = specs.map((s, i) => `${JSON.stringify(s)}: __mr${i}`).join(", ");
  // On the module's first line, so the line numbers in its stack traces stay as they are.
  return `${imports}const __metaRequire = ((t, b) => (id) => {
  const n = String(id).replace(/^node:/, "");
  if (n in b) return b[n];
  if (id in t) return "__cjs" in t[id] ? t[id].__cjs : t[id];
  if ("bun:" + id in b) return b["bun:" + id];
  if (globalThis.__cjsRequire) return globalThis.__cjsRequire(id, ${JSON.stringify("/" + path)});
  throw new Error("import.meta.require: cannot require " + JSON.stringify(id) + " (only literal specifiers of installed packages or built-ins are supported)");
})({ ${table} }, globalThis.__nodeBuiltins);`.replace(/\n\s*/g, " ") + code.replace(/\bimport\.meta\.require\b/g, "__metaRequire");
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

/**
 * chokidar (bundled in Vite) tracks a watched root "/" as a child of itself (`basename("/")` is ""), then sees that
 * child missing on the first directory read and reports every file unlinked. Skip the empty name there.
 */
function patchChokidar(code: string): string {
  return code.includes("_handleRead(") ? code.replace(/(\bitem\s*!==\s*directory\s*&&)(\s*!current\.has\(item\))/, "$1 item !== \"\" &&$2") : code;
}


const META_RE = /(?<![\w$.])import\.meta\.(url|dirname|filename|dir|file|path|env|main|resolve)\b|(?<![\w$.])import\s*\(\s*(?!["'\s])/g;

/**
 * `import.meta.url` & co. point at a `file:` URL of the module's VFS path, as Node and Bun have them. For the `bun`
 * target, Bun's own `dir`, `file`, `path`, `env` and `main` are filled in too, `resolve` answers as Bun's does (the
 * worker's `__importMetaResolve`), and `import(expr)` with a computed specifier goes through the worker's
 * `__dynamicImport`, which loads `file:` URLs and paths from the VFS (literal ones are resolved from the transpiler's
 * import records). Only code is touched, not strings, templates, comments or regex literals.
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
      // Bun's answer (a `file:` URL of the VFS path) instead of the browser's (the served URL).
      resolve: `globalThis.__importMetaResolve.bind(null, ${value.filename})`,
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

/**
 * A data file (JSON, JSONC, JSON5, TOML, YAML) as an ES module, as Bun has it: the document is the default export, and
 * an object's top-level keys (but `default`) named ones; anything else (an array, a string, null) comes with
 * `__esModule: true` instead. It is parsed here too, to find the keys and report a syntax error as the module's error.
 * In the worker it parses with Bun's parsers (`__parseDataFile`, so TOML dates are Temporal values) and registers its
 * namespace for a later `require()`, which then returns it, as in Bun; a file required first stays its value there
 * (worker/node/module.ts). Elsewhere it is the value as JSON.
 */
function dataModule(path: string, src: string, format: DataFormat, target: ModuleTarget): string {
  const value = parseDataFile(src, format);
  const object = value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = object ? Object.keys(value).filter((k) => k !== "default") : [];
  const q = JSON.stringify;
  const parse = target === "bun" ? `globalThis.__parseDataFile(${q(src)}, ${q(format)})` : `JSON.parse(${q(JSON.stringify(value) ?? "null")})`;
  return `const __d = ${parse};
export default __d;
${object ? `${keys.map((k, i) => `const __k${i} = __d[${q(k)}];`).join("\n")}
export { ${keys.map((k, i) => `__k${i} as ${q(k)}`).join(", ")} };` : "export const __esModule = true;"}
${target === "bun" ? `import * as __bwcSelf from ${q(`${VFS_ROOT}${path}`)};\nglobalThis.__esmLoaded?.(${q("/" + path)}, __bwcSelf);` : ""}`;
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
    // In the worker, data files load when required, as their value (see dataModule).
    if (target === "bun" && DATA_FILE.test(t)) return null;
    const dep = vfs.readText(t);
    return `${VFS_ROOT}${dep !== undefined && isCommonJS(t, dep, packageType(vfs, t)) ? "__cjs/" : ""}${t}`;
  });
  // The body is plain source: its `import("x")` calls still need their specifiers resolved.
  try {
    return { status: 200, body: await transpileCached(rewriteMeta(code, path, target === "bun"), `${path}.js`, tsconfigFor(vfs, path), resolver(vfs, dir)) };
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
    let esm = false;
    if (path.endsWith(".html")) return { status: 200, body: `export default ${JSON.stringify({ __htmlImport: path })};` };
    if (path.endsWith(".css")) return { status: 200, body: src };
    const format = dataFormat(path);
    if (format) return { status: 200, body: dataModule(path, src, format, target) };
    if (/\.(ts|tsx|jsx)$/.test(path)) {
      TARGET = target;
      code = await transpileCached(src, path, tsconfigFor(vfs, path), resolver(vfs, dirname(path)), target === "bun");
      esm = true;
    }
    else if (isCommonJS(path, src, packageType(vfs, path))) {
      TARGET = target;
      return { status: 200, body: commonJSFacade(commonJSNames(vfs, path, src), `${VFS_ROOT}__cjs/${path}`) };
    }
    else {
      // Plain ES module: Bun's parser finds the specifiers, as `bun build --no-bundle` does (JSX per tsconfig too).
      TARGET = target;
      code = await transpileCached(src, path, tsconfigFor(vfs, path), resolver(vfs, dirname(path)), target === "bun");
      esm = true;
    }
    TARGET = target;
    // The hoisted imports are final URLs already (the transpiler leaves those alone).
    const dir = dirname(path);
    const url = specifierUrl(vfs, dir);
    const final = (spec: string) => url(spec) ?? spec;
    // Bun's `require` in an ES module, `import.meta.require` (the transpiler declares it where the module uses a free one).
    if (esm) code = esmDirname(code, path);
    const free = code.startsWith(META_REQUIRE);
    if (free) code = `var require = import.meta.require;${code.slice(META_REQUIRE.length)}`;
    let body = rewriteMeta(hoistMetaRequire(vfs, hoistRequires(vfs, patchChokidar(code), dir, final), path, dir, final, free), path, target === "bun");
    // In the worker, the module's namespace once it has run, for a require() of it (worker/node/module.ts): imported
    // from its own URL, so it's this instance.
    if (esm && target === "bun") body += `\nimport * as __bwcSelf from ${JSON.stringify(`${VFS_ROOT}${path}`)};\nglobalThis.__esmLoaded?.(${JSON.stringify("/" + path)}, __bwcSelf);`;
    return { status: 200, body };
  } catch (e) {
    const msg = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    onError(msg);
    return { status: 500, body: msg };
  }
}
