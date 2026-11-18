import { BASE } from "./base";
import { commonJSFacade, exportNames as commonJSExportNames, isCommonJS, JS_LIKE, keepUseStrict, moduleKindOf, reexports, requireRuntimeImports, stripDirname, wrapCommonJS, wrappedBodyLine } from "./cjs";
import { firstLineLength, insertColumns, shiftFirstColumn } from "./sourceMap";
import bunWrap from "./bunWrap.js?raw";
import { loadTranspiler, type Resolver } from "./transpiler";
import { restoreContextMapped } from "./asyncAwait";
import { transpileCached } from "./transpileCache";
import { instrumenting } from "./debugSession";
import { fileId, isCovered, isTestName, type CoverageOptions } from "./coverage/options";
import { tsconfigFor } from "./tsconfig";
import { inRanges, isMethod, literalRanges } from "./literals";
import { DATA_FILE, dataFormat, loadResolver, parseDataFile, resolve, type DataFormat, type ResolveKind } from "./resolver";
import { dirname, isLazy, LazyMiss, norm, withLoaded, type VFS } from "@runbun/vfs";
import hostNames, { version as hostVersion } from "virtual:host-package-names";
import { builtinName, BUN_PACKAGE_ALIASES, exportNames, NODE_PREFIXED } from "./worker/node";
import { pluginUrl, routesThroughPlugins, splitNamespace, type PluginAnswer, type PluginFilters } from "./pluginRoutes";

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
    const p = builtinName(s) !== undefined ? null : resolveWith(vfs, s, dir, "require");
    return p ? JSON.stringify("/" + p) : m;
  });
  // In the worker, data files load when required instead (see dataModule).
  const hoist = (s: string) => {
    const t = resolveWith(vfs, s, dir, "require");
    return !!t && !(TARGET === "bun" && DATA_FILE.test(t));
  };
  const specs = [...new Set([...code.matchAll(/(?<![\w$.])(?:__)?require\(\s*(["'])([^"'\n]+)\1\s*\)/g)].map((m) => m[2]))].filter((s) => builtinName(s) === undefined && (!s.startsWith(".") || DATA_FILE.test(s)) && hoist(s));
  if (!specs.length) return code;
  const imports = specs.map((s, i) => `import * as __h${i} from ${JSON.stringify(url(s))};`).join("");
  const table = specs.map((s, i) => `${JSON.stringify(s)}: __h${i}`).join(", ");
  // On the module's first line, so its lines stay the transpiler's (its source map's).
  return `${imports}const __hoisted = { ${table} }; const __withHoisted = (r) => Object.assign((id) => (id in __hoisted ? ("__cjs" in __hoisted[id] ? __hoisted[id].__cjs : /\\.(json|jsonc|json5|toml|ya?ml)$/.test(id) ? __hoisted[id].default : __hoisted[id]) : r(id)), r);${code.replace(CREATE_REQUIRE, "__withHoisted($&)")}`;
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
 * Literal specifiers that resolve become static imports; Node built-ins and the packages Bun has its own of come from the
 * registry; in the worker, anything else loads when called (see worker/node/module.ts).
 *
 * A free `require`'s literal specifiers load when required, as in Bun (ES modules too: the worker runs them
 * synchronously). In a page, which can't, ES modules among them are imported up front, and in the worker those that
 * an ES module imports too (see importedByEsm). (Calls on a `require` the module binds itself in some inner scope
 * match too there: such a module is then loaded with this one.)
 */
function hoistMetaRequire(vfs: VFS, code: string, path: string, dir: string, url: (spec: string) => string, free: boolean): string {
  if (!code.includes("import.meta.require")) return code;
  const lits = [...new Set([...code.matchAll(/\bimport\.meta\.require\(\s*"([^"\n]+)"\s*\)/g)].map((m) => m[1]))];
  // The worker loads them when required instead, as Bun does (worker/node/module.ts loadEsm), unless an ES module
  // imports them too (see importedByEsm).
  if (free) {
    const literal = literalRanges(code);
    for (const m of code.matchAll(/(?<![\w$.])require\(\s*(["'])([^"'\n]+)\1\s*\)/g)) {
      const t = inRanges(literal, m.index) ? null : resolveWith(vfs, m[2], dir, "require");
      const src = t && !DATA_FILE.test(t) && !/\.(css|node)$/.test(t) ? vfs.readText(t) : undefined;
      if (src !== undefined && !isCommonJS(vfs, t!, src) && (TARGET !== "bun" || importedByEsm(vfs, t!))) lits.push(m[2]);
    }
  }
  // In the worker, data files load when required (see dataModule): an import here would make them return their namespace.
  const specs = [...new Set(lits)].filter((s) => {
    if (builtinName(s) !== undefined) return false;
    const t = resolveWith(vfs, s, dir, "require");
    return !!t && !(TARGET === "bun" && DATA_FILE.test(t));
  });
  const imports = specs.map((s, i) => `import * as __mr${i} from ${JSON.stringify(url(s))};`).join("");
  const table = specs.map((s, i) => `${JSON.stringify(s)}: __mr${i}`).join(", ");
  // On the module's first line, so the line numbers in its stack traces stay as they are.
  return `${imports}const __metaRequire = ((t, b) => (r => globalThis.__decorateRequire?.(r, ${JSON.stringify("/" + path)}) ?? r)((id) => {
  const n = String(id).replace(/^node:/, "");
  if (n in b && (n !== id || !${JSON.stringify(NODE_PREFIXED)}.includes(n))) return b[n];
  if (id in t) return "__cjs" in t[id] ? t[id].__cjs : t[id];
  if (Object.hasOwn(${JSON.stringify(BUN_PACKAGE_ALIASES)}, id)) return b[${JSON.stringify(BUN_PACKAGE_ALIASES)}[id]];
  if (globalThis.__cjsRequire) return globalThis.__cjsRequire(id, ${JSON.stringify("/" + path)});
  throw new Error("Can't require " + JSON.stringify(id) + ". Only installed packages and built-ins work, with a literal name.");
}))({ ${table} }, globalThis.__nodeBuiltins);`.replace(/\n\s*/g, " ") + code.replace(/\bimport\.meta\.require\b/g, "__metaRequire");
}

/** `import`/`export ... from` statements' specifiers (not `import type`), as a rough scan. */
const STATIC_IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(?!type\b)(?:[\w$*{},\s]*?\bfrom\s*)?["']([^"'\n]+)["']/g;
const importSpecs = new Map<string, { src: string; specs: string[] }>();

/**
 * Whether an ES module statically imports the ES module at VFS `target`: a project file, or (for a package's file) one
 * of the same package. A literal `require()` of such a module is imported up front in the worker, as before it ran ES
 * modules synchronously: the imported instance may be fetched but not run yet when the `require` runs, and the
 * worker can't run that one early, nor run the file itself without running it twice (worker/node/module.ts loadEsm).
 * Bun runs it at the `require`; here it runs before the requiring module. Errs towards importing up front.
 */
function importedByEsm(vfs: VFS, target: string): boolean {
  const pkg = /^(?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+\//.exec(target)?.[0];
  const candidates = [...vfs.files.keys()].filter(
    (path) => path !== target && JS_LIKE.test(path) && !(pkg ? !path.startsWith(pkg) || path.includes("/node_modules/", pkg.length - 1) : path.includes("node_modules/")),
  );
  // Large files kept out of memory: all loaded in one go where reads can't block, not one retry each (withLoaded).
  const lazy = vfs.loadSync ? [] : candidates.filter((p) => isLazy(vfs.read(p)));
  if (lazy.length) throw new LazyMiss(...lazy);
  for (const path of candidates) {
    const src = vfs.readText(path);
    if (!src) continue;
    let hit = importSpecs.get(path);
    if (hit?.src !== src) importSpecs.set(path, (hit = { src, specs: [...new Set([...src.matchAll(STATIC_IMPORT)].map((m) => m[1]))] }));
    if (hit.specs.some((spec) => resolveTarget(vfs, spec, dirname(path)) === target)) return true;
  }
  return false;
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

/** A `bun test --coverage` run's options while it runs (runner.ts): its project files are served counting what runs. */
let coverage: Pick<CoverageOptions, "skipTestFiles"> | undefined;
export function setCoverage(opts: Pick<CoverageOptions, "skipTestFiles"> | undefined) {
  coverage = opts;
}
/**
 * Whether the worker gets the file at `path` with counters (not in a debug run, which has probes of its own). A runtime
 * plugin's module counts by the name it has (its file's path, or a virtual module's `ns:name`), as in Bun.
 */
function covering(path: string, target: ModuleTarget, debug: boolean, plugin?: PluginSource): boolean {
  if (target !== "bun" || debug || !coverage) return false;
  if (plugin && !plugin.importer.startsWith("/")) return !(coverage.skipTestFiles && isTestName(plugin.importer));
  return isCovered(plugin ? plugin.importer.slice(1) : path, coverage);
}

/**
 * The counters in transpiled `code` (coverage/instrument.ts, loaded now), its mappings moved for them, and the
 * statement that registers the file in the worker (worker/coverage.ts) by `url` (`/<path>`, or a virtual module's
 * name); undefined for code the instrumenter can't parse.
 */
async function coverModule(code: string, mappings: string, url: string, script: boolean, source?: string) {
  const { instrument } = await import("./coverage/instrument");
  const id = fileId(url);
  const done = instrument(code, mappings, id, script, source);
  if (!done) return undefined;
  return { code: done.code, mappings: insertColumns(mappings, done.inserts), register: `globalThis.__bwcCovFile?.(${id},${JSON.stringify(url)},${JSON.stringify(done.meta)});` };
}

/** Where `spec` imported from `dir` is served, relative to `/__vfs/`; null if it doesn't resolve. CSS imported from code is `__css/<path>` (see cssModule). */
function resolveTarget(vfs: VFS, spec: string, dir: string, kind: ResolveKind = "import"): string | null {
  const t = resolveSpecifier(vfs, spec, dir, kind);
  return t?.endsWith(".css") ? `__css/${t}` : t;
}

function resolveSpecifier(vfs: VFS, spec: string, dir: string, kind: ResolveKind): string | null {
  const builtin = builtinName(spec);
  if (spec === "bun:wrap") return "__bun/wrap";
  if (spec in hostNames) {
    checkHostVersion(vfs);
    return `__host/${spec}`;
  }
  if (spec.startsWith("node:") || builtin !== undefined) return builtin !== undefined ? `__node/${builtin}` : null;
  // A `file:` URL names a path, as in the config Vite bundles and imports (`import … from "file:///node_modules/vite/…"`).
  if (spec.startsWith("file:")) spec = decodeURIComponent(new URL(spec).pathname);
  return resolveWith(vfs, spec, dir, kind);
}

/** The transpiler's resolver: where each specifier in a module of `dir` is served. */
function resolver(vfs: VFS, dir: string, importer?: string): Resolver {
  const url = specifierUrl(vfs, dir);
  // In the worker, what its runtime plugins take is theirs to serve (servePlugin).
  if (importer !== undefined) return (spec) => (pluginRouted(vfs, spec, dir) ? `${VFS_ROOT}${pluginUrl(importer, spec)}` : url(spec));
  return (spec) => url(spec);
}

/** The worker's runtime plugins' filters (`Bun.plugin`, worker/plugins.ts), once it has some. */
let plugins: PluginFilters | undefined;

/** Whether an import of `spec` from `dir` goes through the worker's plugins (pluginRoutes.ts). */
function pluginRouted(vfs: VFS, spec: string, dir: string): boolean {
  if (builtinName(spec) !== undefined || spec in hostNames || /^(https?:|data:|blob:)/.test(spec)) return false;
  const namespaced = splitNamespace(spec)[0] !== "file";
  if (!plugins && !namespaced) return false;
  const t = (() => {
    try {
      return resolveWith(vfs, spec.startsWith("file:") ? decodeURIComponent(new URL(spec).pathname) : spec, dir);
    } catch {
      return null;
    }
  })();
  // A namespaced specifier (`virtual:x`) that doesn't resolve is for the plugins, even ones the program registers later.
  if (namespaced && t === null) return true;
  return routesThroughPlugins(plugins, spec, t === null ? null : `/${t}`);
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
  // bun:sqlite's wasm (node:sqlite's too) loads asynchronously, before anything is exported
  const pre = name === "bun:sqlite" || name === "sqlite" ? "await globalThis.__loadBunSqlite();\n" : "";
  // A built-in with `__esModule` (bun:sqlite) has its default export as `default`, as an ES module would.
  return `${pre}const m = globalThis.__nodeBuiltins[${JSON.stringify(name)}];
export default m.__esModule ? m.default : m;
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
    if (dep !== undefined && isCommonJS(vfs, t!, dep)) for (const n of commonJSNames(vfs, t!, dep, seen)) names.add(n);
  }
  return [...names];
}

/**
 * A source map comment for a served module (worker/sourceMaps.ts reads it). `extra` are the playground's own fields:
 * `x_bwcLineOffset` lines of wrapper before the file's, and `x_bwcInner` the mappings of a transpile before that.
 */
const inlineSourceMap = (path: string, mappings: string, extra?: { x_bwcLineOffset: number; x_bwcInner?: string }) =>
  `\n//# sourceMappingURL=data:application/json;base64,${btoa(JSON.stringify({ version: 3, sources: [path.slice(path.lastIndexOf("/") + 1)], names: [], mappings, ...extra }))}`;

/** The body of a CommonJS file (see wrapCommonJS); requires of other CommonJS files load their bodies too. */
async function serveCommonJS(vfs: VFS, path: string, onError: (msg: string) => void, target: ModuleTarget): Promise<ModuleResponse> {
  const src = vfs.readText(path);
  if (src === undefined) {
    onError(`module not found: ${path}`);
    return { status: 404, body: `Not found: ${path}` };
  }
  TARGET = target;
  const dir = dirname(path);
  // TypeScript and JSX first, without the `__dirname` and `__filename` the transpiler declares (the wrapper has them),
  // its JSX runtime and `bun:wrap` imports as requires (see requireRuntimeImports). In the worker with a source map,
  // `stripped` lines fewer than it (requireRuntimeImports keeps them).
  const bun = target === "bun";
  let body = src;
  let inner: string | undefined;
  let stripped = 0;
  let probes: string | undefined;
  // In a debug run the project's own files get the step debugger's probes here, in the file's own lines (plain
  // JavaScript too, which is otherwise served as written).
  const debug = bun && instrumenting() && !/(^|\/)node_modules\//.test(path);
  // In a coverage run, its counters (plain JavaScript is transpiled for them too).
  const cover = covering(path, target, debug);
  let register = "";
  if (debug || cover || /\.(?:[cm]?tsx?|jsx)$/.test(path)) {
    try {
      let [js, mappings, table] = (await transpileCached(src, path, tsconfigFor(vfs, path), () => null, false, bun, debug, cover)).split("\0");
      const counted = cover && mappings !== undefined ? await coverModule(js, mappings, `/${path}`, true, src) : undefined;
      if (counted) ({ code: js, mappings, register } = counted);
      probes = table;
      body = stripDirname(js);
      if (body !== js) stripped = 1;
      // Its "use strict" back, on a line of its own: strict mode follows the file, as in Bun.
      let added: number;
      [body, added] = keepUseStrict(src, requireRuntimeImports(body));
      stripped -= added;
      inner = mappings;
    } catch (e) {
      if (e instanceof LazyMiss) throw e; // loaded and served again (withLoaded)
      const msg = `${path}: ${e instanceof Error ? e.message : String(e)}`;
      onError(msg);
      return { status: 500, body: msg };
    }
  }
  const code = wrapCommonJS(path, body, (spec) => {
    // A runtime plugin's module loads when required, through the worker's plugins (worker/plugins.ts).
    if (target === "bun" && pluginRouted(vfs, spec, dir)) return null;
    const t = resolveTarget(vfs, spec, dir, "require");
    if (t === null || t.startsWith("__")) return t && `${VFS_ROOT}${t}`;
    // In the worker, data files load when required, as their value (see dataModule).
    if (target === "bun" && DATA_FILE.test(t)) return null;
    const dep = vfs.readText(t);
    const cjs = dep !== undefined && isCommonJS(vfs, t, dep);
    // In the worker an ES module loads when required, as in Bun (worker/node/module.ts loadEsm), not up front, unless
    // an ES module imports it too (see importedByEsm).
    if (target === "bun" && !cjs && JS_LIKE.test(t) && !importedByEsm(vfs, t)) return null;
    return `${VFS_ROOT}${cjs ? "__cjs/" : ""}${t}`;
  });
  // The body is plain source: its `import("x")` calls still need their specifiers resolved.
  try {
    const [plain, mappings] = (await transpileCached(rewriteMeta(code, path, bun), `${path}.js`, tsconfigFor(vfs, path), resolver(vfs, dir, bun ? "/" + path : undefined), false, bun)).split("\0");
    const restored = bun ? restoreContextMapped(plain) : undefined;
    const js = restored?.code ?? plain;
    // In the worker, its source map leads to the wrapper's lines, which are the file's (or the first transpile's, which
    // `inner` maps back) after a header (worker/sourceMaps.ts).
    if (mappings === undefined) return { status: 200, body: js };
    // Its probe table, on the wrapper's first line (before the file's), registered when the module loads.
    // Its counters' registration likewise, in a coverage run.
    const head = (probes ? `__dbg.file(${JSON.parse(probes).file},${JSON.stringify(path)},${probes});` : "") + register;
    return { status: 200, body: head + js + inlineSourceMap(path, restored ? insertColumns(mappings, restored.inserts) : mappings, { x_bwcLineOffset: wrappedBodyLine(code) - stripped, x_bwcInner: inner }) };
  } catch (e) {
    if (e instanceof LazyMiss) throw e; // loaded and served again (withLoaded)
    const msg = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    onError(msg);
    return { status: 500, body: msg };
  }
}

/**
 * ES modules the worker ran itself (a `require()` of one nothing had imported, worker/node/module.ts loadEsm), by path:
 * their export names once it has. A later `import` of one gets a module that re-exports that instance (syncEsmModule).
 */
const syncEsm = new Map<string, { names: Promise<string[] | null>; settle: (names: string[] | null) => void }>();
/** ES modules served to the worker: one of them may be imported but not yet run, so the worker can't run it itself. */
const servedEsm = new Set<string>();
/** Modules `mock.module` replaced in the worker (worker/node/module.ts mockModule), by path: their export names. */
const mocks = new Map<string, string[]>();

/** For a new worker (Run): nothing served or run yet. */
export function resetSyncEsm() {
  syncEsm.clear();
  servedEsm.clear();
  mocks.clear();
  plugins = pluginToken = undefined;
}

/** The worker's synchronous requests about the ES modules it runs itself: `claim/<path>`, `done/<names>/<path>`, `fail/<path>`. */
function syncEsmRequest(req: string): ModuleResponse {
  const [, what, rest] = /^(claim|done|fail|mock|plugins)\/(.*)$/.exec(req) ?? [];
  // `mock/<names>/<path>`: refused once the module has been served (it is, or is being, imported).
  if (what === "mock") {
    const slash = rest.indexOf("/");
    const path = norm(rest.slice(slash + 1));
    if (servedEsm.has(path)) return { status: 409, body: "" };
    mocks.set(path, JSON.parse(decodeURIComponent(rest.slice(0, slash))) as string[]);
    return { status: 200, body: "" };
  }
  // `plugins/<filters>`: the worker's runtime plugins now (worker/plugins.ts), before it imports anything else.
  if (what === "plugins") {
    const f = JSON.parse(decodeURIComponent(rest)) as PluginFilters;
    plugins = f.resolve.length || f.load.length || f.modules.length ? f : undefined;
    pluginToken = f.token;
    return { status: 200, body: "" };
  }
  if (what === "claim") {
    const path = norm(rest);
    if (servedEsm.has(path) || syncEsm.has(path)) return { status: 409, body: "" };
    let settle!: (names: string[] | null) => void;
    const names = new Promise<string[] | null>((r) => (settle = r));
    syncEsm.set(path, { names, settle });
    return { status: 200, body: "" };
  }
  if (what === "done" || what === "fail") {
    const slash = what === "done" ? rest.indexOf("/") : -1;
    const path = norm(rest.slice(slash + 1));
    const entry = syncEsm.get(path);
    entry?.settle(what === "done" ? (JSON.parse(decodeURIComponent(rest.slice(0, slash))) as string[]) : null);
    if (what === "fail") syncEsm.delete(path);
    return { status: 200, body: "" };
  }
  return { status: 404, body: "" };
}

/** In place of a module `mock.module` replaced: the exports of what the worker holds for it (`globalThis.__bunMock`). */
function mockedModule(path: string, names: string[]): string {
  const q = JSON.stringify;
  const named = names.filter((n) => n !== "default");
  return `const __m = globalThis.__bunMock(${q(path)});
${names.includes("default") ? "export default __m.default;\n" : ""}${named.length ? `export const { ${named.join(", ")} } = __m;` : ""}`;
}

/** In place of an ES module the worker ran itself: that instance's exports (their values when imported, not live). */
function syncEsmModule(path: string, names: string[]): string {
  const q = JSON.stringify;
  const named = names.filter((n) => n !== "default");
  return `const __ns = globalThis.__esmNamespace(${q("/" + path)});
${names.includes("default") ? "export default __ns.default;\n" : ""}${named.length ? `const { ${named.map((n, i) => `${q(n)}: __s${i}`).join(", ")} } = __ns;
export { ${named.map((n, i) => `__s${i} as ${q(n)}`).join(", ")} };` : ""}`;
}

/** The worker whose plugins the page asks (its BroadcastChannel's name), as it last told the page. */
let pluginToken: string | undefined;
/** Source a runtime plugin loaded, served as an ES module at `url` (see serveModuleOnce). */
type PluginSource = { key: string; url: string; contents: string; dir: string; importer: string };

/** Asks the worker's plugins for the module of `spec` imported from `importer` (worker/plugins.ts serve). */
function askPlugins(importer: string, spec: string): Promise<PluginAnswer> {
  if (!pluginToken) return Promise.resolve({ kind: "error", name: "ResolveMessage", message: `Cannot find package '${spec}' imported from ${importer}` });
  const ch = new BroadcastChannel(`runbun-plugins-${pluginToken}`);
  const id = Math.random();
  return new Promise<PluginAnswer>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "error", name: "Error", message: `The program's plugins didn't answer for "${spec}"` }), 30_000);
    ch.onmessage = (e: MessageEvent<{ reply?: number; answer: PluginAnswer }>) => {
      if (e.data?.reply !== id) return;
      clearTimeout(timer);
      resolve(e.data.answer);
    };
    ch.postMessage({ id, importer, spec });
  }).finally(() => ch.close());
}

/**
 * `__plugin/<importer>/<specifier>`: what the worker's runtime plugins make of an import (pluginRoutes.ts). Exports the
 * worker holds come from it; source is served as an ES module; a file no onLoad hook takes, as itself.
 */
async function servePlugin(vfs: VFS, rawPath: string, onError: (msg: string) => void): Promise<ModuleResponse> {
  const [importer, spec] = rawPath.slice(9).split("/").map(decodeURIComponent);
  const answer = await askPlugins(importer, spec);
  const q = JSON.stringify;
  if (answer.kind === "error") return { status: 200, body: `throw Object.assign(new Error(${q(answer.message)}), { name: ${q(answer.name)} });` };
  if (answer.kind === "file") {
    const url = q(`${VFS_ROOT}${answer.path.slice(1)}`);
    return { status: 200, body: `import * as __n from ${url};\nexport * from ${url};\nexport default __n.default;` };
  }
  if (answer.kind === "names") {
    const named = answer.names.filter((n) => n !== "default");
    return {
      status: 200,
      body: `const __ns = globalThis.__pluginNamespace(${q(answer.key)});
${answer.names.includes("default") ? "export default __ns.default;\n" : ""}${named.length ? `const { ${named.map((n, i) => `${q(n)}: __s${i}`).join(", ")} } = __ns;
export { ${named.map((n, i) => `__s${i} as ${q(n)}`).join(", ")} };` : ""}`,
    };
  }
  const { key, contents, dir, importer: self, file } = answer;
  return serveModuleOnce(vfs, file, onError, "bun", { key, url: `${VFS_ROOT}${pluginUrl(importer, spec)}`, contents, dir, importer: self });
}

/**
 * The URL prefix (under `/__vfs/`) the worker loads a `.cjs`, `.cts`, `.mjs` or `.mts` program by, so it is served by
 * its extension's module type (moduleKindOf `entry`). Other programs load by their own URL, the one imports use.
 */
export const ENTRY_PREFIX = "__entry/";

/**
 * A module for the service worker. Serving can read files it only finds on the way (requires it follows, re-exports),
 * some of them large installed files kept out of memory: each is loaded and the module served again (withLoaded).
 */
export function serveModule(vfs: VFS, rawPath: string, onError: (msg: string) => void, target: ModuleTarget = "browser"): Promise<ModuleResponse> {
  return withLoaded(vfs, () => serveModuleOnce(vfs, rawPath, onError, target));
}

async function serveModuleOnce(vfs: VFS, rawPath: string, onError: (msg: string) => void, target: ModuleTarget, plugin?: PluginSource): Promise<ModuleResponse> {
  if (target === "bun" && rawPath.startsWith("__esmsync/")) return syncEsmRequest(rawPath.slice(10));
  if (target === "bun" && rawPath.startsWith("__plugin/")) return servePlugin(vfs, rawPath, onError);
  let path = norm(rawPath);
  // `__entry/<path>`: the program the worker runs, whose extension can make it CommonJS or an ES module (moduleKindOf).
  const entry = path.startsWith(ENTRY_PREFIX);
  if (entry) path = path.slice(ENTRY_PREFIX.length);
  await loadResolver(vfs);
  const mocked = target === "bun" && !plugin ? mocks.get(path) : undefined;
  if (mocked) {
    servedEsm.add(path);
    return { status: 200, body: mockedModule(path, mocked) };
  }
  if (path.startsWith("__node/")) {
    if (target === "bun") servedEsm.add(path);
    return { status: 200, body: builtinModule(path.slice(7)) };
  }
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
  const src = plugin ? plugin.contents : vfs.readText(path);
  if (src === undefined) {
    onError(`module not found: ${path}`);
    return { status: 404, body: `Not found: ${path}` };
  }
  try {
    if (path.endsWith(".html")) return { status: 200, body: `export default ${JSON.stringify({ __htmlImport: path })};` };
    if (path.endsWith(".css")) return { status: 200, body: src };
    const format = dataFormat(path);
    if (format) return { status: 200, body: dataModule(path, src, format, target) };
    // Whatever its extension, a file Bun runs as CommonJS is served as such (see moduleKindOf).
    if (JS_LIKE.test(path) && !plugin) {
      await loadTranspiler();
      TARGET = target;
      if (moduleKindOf(vfs, path, src, entry) === "cjs") return { status: 200, body: commonJSFacade(commonJSNames(vfs, path, src), `${VFS_ROOT}__cjs/${path}`) };
    }
    // An ES module: Bun's parser finds the specifiers, as `bun build --no-bundle` does (JSX per tsconfig too).
    // In the worker, with a source map: its error printer maps stack frames back to the file's lines (worker/sourceMaps.ts).
    // In a debug run, the project's own files call the step debugger before each statement (worker/debugger.ts).
    const debug = target === "bun" && !plugin && instrumenting() && !/(^|\/)node_modules\//.test(path);
    // In a coverage run, the project's files count what runs (coverage/instrument.ts).
    const cover = covering(path, target, debug, plugin);
    let [plain, mappings, table] = (await transpileCached(src, path, tsconfigFor(vfs, path), resolver(vfs, plugin?.dir ?? dirname(path), target === "bun" ? (plugin?.importer ?? "/" + path) : undefined), target === "bun", target === "bun", debug, cover)).split("\0");
    const counted = cover && mappings !== undefined ? await coverModule(plain, mappings, plugin?.importer ?? `/${path}`, false) : undefined;
    if (counted) ({ code: plain, mappings } = counted);
    // In the worker, each `await` keeps the AsyncLocalStorage context (asyncAwait.ts).
    const restored = target === "bun" ? restoreContextMapped(plain) : { code: plain, inserts: new Map<number, [number, number][]>() };
    const transpiled = restored.code;
    let code = transpiled;
    if (target === "bun") {
      const sync = plugin ? undefined : syncEsm.get(path);
      const names = sync && (await sync.names);
      if (names) return { status: 200, body: syncEsmModule(path, names) };
      if (!plugin) servedEsm.add(path);
    }
    TARGET = target;
    // The hoisted imports are final URLs already (the transpiler leaves those alone).
    const dir = plugin?.dir ?? dirname(path);
    const url = specifierUrl(vfs, dir);
    const final = (spec: string) => url(spec) ?? spec;
    // Bun's `require` in an ES module, `import.meta.require` (the transpiler declares it where the module uses a free one).
    code = esmDirname(code, path);
    const free = code.startsWith(META_REQUIRE);
    if (free) code = `var require = import.meta.require;${code.slice(META_REQUIRE.length)}`;
    let body = rewriteMeta(hoistMetaRequire(vfs, hoistRequires(vfs, patchChokidar(code), dir, final), path, dir, final, free), path, target === "bun");
    // In the worker, the module's namespace once it has run, for a require() of it (worker/node/module.ts): imported
    // from its own URL, so it's this instance.
    if (plugin) {
      // A runtime plugin's module: its namespace by its key, for later imports of it from elsewhere (servePlugin).
      body += `\nimport * as __bwcSelf from ${JSON.stringify(plugin.url)};\nglobalThis.__pluginLoaded?.(${JSON.stringify(plugin.key)}, __bwcSelf);`;
      // In a coverage run, its counters' registration first (see below).
      if (counted) body = `import ${JSON.stringify(`data:text/javascript,${encodeURIComponent(counted.register)}`)};${body}`;
      if (mappings !== undefined) body += inlineSourceMap(path, shiftFirstColumn(insertColumns(mappings, restored.inserts), firstLineLength(body) - firstLineLength(transpiled)));
    } else if (target === "bun") {
      body += `\nimport * as __bwcSelf from ${JSON.stringify(`${VFS_ROOT}${entry ? ENTRY_PREFIX : ""}${path}`)};\nglobalThis.__esmLoaded?.(${JSON.stringify("/" + path)}, __bwcSelf);`;
      // Its probe table, before any of its statements runs.
      if (table) body = `__dbg.file(${JSON.parse(table).file},${JSON.stringify(path)},${table});${body}`;
      // Its first import marks it as being imported (before its dependencies run), on the first line.
      body = `import ${JSON.stringify(`data:text/javascript,${encodeURIComponent(`globalThis.__esmImporting?.(${JSON.stringify("/" + path)})`)}`)};${body}`;
      // In a coverage run, an import before that registers its counters, so they are there before anything of it runs.
      if (counted) body = `import ${JSON.stringify(`data:text/javascript,${encodeURIComponent(counted.register)}`)};${body}`;
      // What was put before or changed at the start of the transpiler's first line moves that line's columns.
      if (mappings !== undefined) body += inlineSourceMap(path, shiftFirstColumn(insertColumns(mappings, restored.inserts), firstLineLength(body) - firstLineLength(transpiled)));
    }
    return { status: 200, body };
  } catch (e) {
    if (e instanceof LazyMiss) throw e; // loaded and served again (withLoaded)
    const msg = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    onError(msg);
    return { status: 500, body: msg };
  }
}
