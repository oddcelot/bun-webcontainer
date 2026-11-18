import { dirname, norm, type VFS } from "@runbun/vfs";
import bunWrapSource from "../../bunWrap.js?raw";
import { hasModuleSyntax, JS_LIKE, moduleKindOf, packageType, requireRuntimeImports, stripDirname } from "../../cjs";
import { inRanges, isMethod, literalRanges } from "../../literals";
import { dataFormat, parseDataFile } from "../../resolver";
import { transpileSync, transpileSyncEsm } from "../../transpiler";
import { FUNCTION_HEADER_LINES, registerSource } from "../sourceMaps";
import { tsconfigFor } from "../../tsconfig";
import { XHR } from "../xhr";

/** The step debugger's global in a debug run (worker/debugger.ts; read here, not imported: the page loads this file too). */
const debug = () => (globalThis as { __dbg?: { active?: boolean; file(id: number, path: string, table: unknown): void } }).__dbg;
/** In a debug run, the project's own files (not installed packages) get the step debugger's probes. */
const instrumented = (path: string) => !!debug()?.active && !/(^|\/)node_modules\//.test(path);
/** A file instrumented here: its probe table, as a served module registers its own. */
function registerProbes(path: string, table: string) {
  const t = JSON.parse(table) as { file: number };
  debug()?.file(t.file, path, t);
}

/** Bun's resolver over the worker's VFS (see setRequire); unset on the page, which only reads export names. */
let resolveFile: ((spec: string, dir: string) => string | null) | undefined;
/** The same with `import` conditions, for the imports of ES modules the worker runs itself. */
let resolveImport: ((spec: string, dir: string) => string | null) | undefined;
/** Where the page serves modules (moduleServer.ts `vfsRoot`), to tell it which ES modules the worker ran itself. */
let vfsRoot: (() => string) | undefined;
let vfs: VFS | undefined;

/** A CommonJS module instance, as `require.cache` holds them (keyed by its path, leading `/`). */
type CjsModule = {
  id: string;
  filename: string;
  path: string;
  exports: unknown;
  loaded: boolean;
  children: CjsModule[];
  paths: string[];
  require: Require;
};
type Require = ((id: string) => unknown) & { resolve?: unknown; cache?: unknown; main?: unknown };

/** Markdown files, which Bun loads as an ES module of their HTML. */
const MARKDOWN = /\.(md|markdown)$/;
/** `require.cache`: every CommonJS module the worker runs, whether a literal require (wrapCommonJS) or a computed one loaded it. */
const cache: Record<string, CjsModule> = Object.create(null);

/**
 * The namespace of each ES module the worker has run, by path (served modules register themselves once evaluated, see
 * moduleServer.ts serveModule): what `require()` of one returns, as in Bun. One that is still evaluating (top-level
 * await, a cycle) isn't here yet.
 */
const esModules: Record<string, object> = Object.create(null);

/** `mock.module`: what a module's path (or `__node/<name>`) stands for now; the page serves a module re-exporting it (moduleServer.ts). */
const mocks = new Map<string, object>();

/**
 * Served ES modules that have started but not finished evaluating (each marks itself first, see moduleServer.ts
 * serveModule): a `require()` of one can't get its namespace yet (a cycle, top-level await).
 */
const importing = new Set<string>();

/**
 * Asks the page, synchronously (the service worker passes the request on), about an ES module the worker runs itself:
 * `claim` before running it, so that a later `import` of it gets this instance (refused if the page has served the
 * module already: it is being imported); `done` with its export names after, `fail` if it threw.
 */
function tellPage(what: "claim" | "done" | "fail" | "mock", file: string, names?: string[]): boolean {
  if (!vfsRoot) return true;
  const xhr = new XHR();
  // The names as one path segment: the service worker decodes the path once.
  const arg = names ? `/${encodeURIComponent(encodeURIComponent(JSON.stringify(names)))}` : "";
  xhr.open("GET", `${vfsRoot()}__esmsync/${what}${arg}${file}`, false);
  try {
    xhr.send();
  } catch {
    return true;
  }
  return xhr.status === 200;
}

const requireEsmError = (file: string, why: string) =>
  Object.assign(new Error(`require() of ES module ${file} ${why}. Use import() instead.`), { code: "ERR_REQUIRE_ESM" });

/** What `import * as ns` of a CommonJS module gives in Bun: its exports by name, and `default` (`module.exports`, or `exports.default` with `__esModule`). */
const cjsNamespaces = new WeakMap<object, object>();
function cjsNamespace(exports: unknown): object {
  const key = (exports !== null && (typeof exports === "object" || typeof exports === "function") ? exports : null) as object | null;
  const hit = key && cjsNamespaces.get(key);
  if (hit) return hit;
  const ns = Object.create(null) as Record<string, unknown>;
  if (key) for (const k of Object.keys(key)) if (k !== "default" && k !== "__esModule") Object.defineProperty(ns, k, { get: () => (key as Record<string, unknown>)[k], enumerable: true });
  const esModule = key && (key as { __esModule?: unknown }).__esModule && "default" in key;
  Object.defineProperty(ns, "default", { value: esModule ? (key as { default: unknown }).default : exports, enumerable: true });
  if (key) cjsNamespaces.set(key, ns);
  return ns;
}

/** A Node built-in or `bun:` module as a namespace: its properties, and `default` the module itself (as builtinModule serves it). */
const builtinNamespaces = new Map<string, object>();
function builtinNamespace(id: string, m: object): object {
  let ns = builtinNamespaces.get(id);
  if (!ns) builtinNamespaces.set(id, (ns = Object.assign(Object.create(null) as object, m, { default: m })));
  return ns;
}

/** The VFS directory a `createRequire` argument names: a `file:` URL or path of a module, or a directory ending in `/`. */
function requireDir(from: string | URL): string {
  const s = String(from);
  const path = s.startsWith("file:") ? decodeURIComponent(new URL(s).pathname) : s;
  return path.endsWith("/") ? norm(path) : dirname(norm(path));
}

/** Bun's `bun:wrap` (the transpiler's helpers) for CommonJS the worker runs, which requires it (see requireRuntimeImports). */
let bunWrap: object | undefined;
function evaluateBunWrap(): object {
  const names = [...bunWrapSource.matchAll(/^export var ([\w$]+)/gm)].map((m) => m[1]);
  return new Function(`${bunWrapSource.replace(/^export var /gm, "var ")}\nreturn { ${names.join(", ")} };`)() as object;
}

/** Bun's error for a require that resolves to nothing. */
const notFound = (id: string, from: string) =>
  Object.assign(new Error(`Cannot find module '${id}'\nRequire stack:\n- ${from}`), { name: "ResolveMessage", code: "MODULE_NOT_FOUND", requireStack: [from] });

const nodeModulePaths = (dir: string) => {
  const out: string[] = [];
  for (let d = "/" + norm(dir); ; d = d.slice(0, d.lastIndexOf("/")) || "/") {
    if (!d.endsWith("/node_modules")) out.push(`${d === "/" ? "" : d}/node_modules`);
    if (d === "/") return out;
  }
};

/** `node:module` needs the registry (for createRequire, builtinModules), so it is built by index.ts. */
export function createModule(
  registry: Record<string, object>,
  builtinName: (spec: string) => string | undefined,
  builtinModules: () => string[],
  /** Whether a specifier names one of the npm packages Bun has its own of (`undici`), which `builtinName` maps too. */
  bunPackage: (spec: string) => boolean = () => false,
) {
  const name = (id: string) => builtinName(id) ?? id;
  const isBuiltin = (id: string) => builtinName(String(id)) !== undefined;

  /** The CommonJS module at `file`: from the cache, else made, cached and run (`run` fills in its exports). */
  function load(file: string, run: (m: CjsModule) => void, req: Require): CjsModule {
    const hit = cache[file];
    if (hit) return hit;
    decorate(req, file);
    const dir = dirname(file) || "/";
    const m: CjsModule = { id: file, filename: file, path: dir, exports: {}, loaded: false, children: [], paths: nodeModulePaths(dir), require: req };
    cache[file] = m;
    try {
      run(m);
    } catch (e) {
      delete cache[file];
      throw e;
    }
    m.loaded = true;
    return m;
  }

  /** What `require(id)` returns from `from` (a module path or directory ending in `/`), loading it synchronously if needed. */
  function requireFrom(id: string, from: string): unknown {
    id = String(id);
    if (isBuiltin(id)) return registry[name(id)];
    if (id === "bun:wrap") return (bunWrap ??= evaluateBunWrap());
    const plugged = pluginHook?.(id, from, "require");
    if (plugged) return plugged.value;
    const path = resolveFile?.(id, requireDir(from));
    if (!path || !vfs) throw notFound(id, from);
    const file = "/" + path;
    if (mocks.has(path)) return mocks.get(path);
    return cache[file] ? cache[file].exports : (esModules[file] ?? loadFile(path));
  }

  /**
   * `mock.module(spec, ...)` from the module at `from`: later imports (the page serves a stand-in) and requires get
   * `exports`. Not one that is imported already: an ES module's bindings can't be swapped.
   */
  function mockModule(spec: string, from: string, exports: object) {
    spec = String(spec);
    const builtin = isBuiltin(spec);
    const path = builtin ? `__node/${name(spec)}` : resolveImport?.(spec, requireDir(from));
    if (!path || !vfs) throw Object.assign(new Error(`Cannot find module '${spec}' from '${from}'`), { name: "ResolveMessage", code: "ERR_MODULE_NOT_FOUND" });
    const names = Object.keys(exports).filter((k) => k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k));
    if (typeof exports === "object" && exports !== null && "default" in exports) names.unshift("default");
    if (cache["/" + path] || esModules["/" + path] || !tellPage("mock", "/" + path, names)) {
      throw new Error(`mock.module("${spec}"): the module is imported already. The playground can only mock a module before its first import: call mock.module first and load it with import() afterwards.`);
    }
    mocks.set(path, exports);
  }

  /** `import ... from spec` in an ES module the worker runs itself (see loadEsm): the namespace a static import gives. */
  function importSync(spec: string, from: string): object {
    spec = String(spec);
    // The transpiler's helpers for decorators and `using` (see requireRuntimeImports), as required CommonJS gets them.
    if (spec === "bun:wrap") return (bunWrap ??= evaluateBunWrap());
    if (isBuiltin(spec)) return builtinNamespace(name(spec), registry[name(spec)]);
    const plugged = pluginHook?.(spec, from, "import");
    if (plugged) return plugged.value as object;
    const path = resolveImport?.(spec, requireDir(from));
    if (!path || !vfs) throw Object.assign(new Error(`Cannot find module '${spec}' from '${from}'`), { name: "ResolveMessage", code: "ERR_MODULE_NOT_FOUND" });
    const file = "/" + path;
    if (mocks.has(path)) return Object.assign(Object.create(null) as object, mocks.get(path));
    if (esModules[file]) return esModules[file];
    const format = dataFormat(path);
    const value = cache[file] ? cache[file].exports : loadFile(path);
    if (esModules[file] === value) return value as object;
    // A data file's namespace: the document as `default`, an object's keys by name (as moduleServer.ts dataModule).
    if (format) return Object.assign(Object.create(null) as object, value !== null && typeof value === "object" && !Array.isArray(value) ? value : { __esModule: true }, { default: value });
    return cjsNamespace(value);
  }

  /**
   * `require()` of an ES module nothing has imported yet: transpiled to the body of a function (transpileSyncEsm, its
   * imports loaded the same way), run, and registered, so that a later `import` of it gets this namespace too (the page
   * serves a module that re-exports it, see moduleServer.ts). One with top-level await throws Bun's error.
   */
  function loadEsm(path: string, src: string, plugin = false): object {
    const file = "/" + path;
    // A runtime plugin's module (worker/plugins.ts) isn't a file the page serves: no claim, and not registered by path.
    const claim = (what: "claim" | "done" | "fail", names?: string[]) => plugin || tellPage(what, file, names);
    if (importing.has(file)) throw requireEsmError(file, "can't load while the module is still being imported (a cycle or top-level await)");
    let code: string;
    let mappings: string | undefined;
    let probes: string | undefined;
    try {
      [code, mappings, probes] = transpileSyncEsm(src, file, tsconfigFor(vfs!, path), true, instrumented(path)).split("\0");
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("require() async module")) throw new TypeError(e.message);
      throw e;
    }
    if (!claim("claim")) throw requireEsmError(file, "can't load while the module is being imported (another module imports it and hasn't run yet)");
    const ns = Object.create(null) as object;
    Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
    if (!plugin) esModules[file] = ns;
    const g = globalThis as unknown as { Bun?: { main?: string }; process?: { env?: unknown }; __dynamicImport(from: string, spec: unknown, o?: unknown): Promise<unknown>; __importMetaResolve(from: string, spec: string): string };
    const dir = dirname(file) || "/";
    const importMeta = {
      url: `file://${file}`,
      dir,
      dirname: dir,
      file: file.slice(file.lastIndexOf("/") + 1),
      filename: file,
      path: file,
      env: g.process?.env,
      main: g.Bun?.main === file,
      resolve: (s: string) => g.__importMetaResolve(file, s),
      require: makeRequire(file),
    };
    const hmr: { exports?: object } & Record<string, unknown> = {
      importMeta,
      require: importMeta.require,
      importSync: (s: string) => importSync(s, file),
      dynamicImport: (s: unknown, o?: unknown) => g.__dynamicImport(`file://${file}`, s, o),
    };
    const url = encodeURI(`file://${file}`);
    registerSource(url, FUNCTION_HEADER_LINES, mappings, false);
    if (probes) registerProbes(path, probes);
    try {
      new Function("hmr", `${code}\n//# sourceURL=${url}`)(hmr);
    } catch (e) {
      if (!plugin) delete esModules[file];
      claim("fail");
      throw e;
    }
    // The exports as a namespace has them: sorted, live (getters), not extensible.
    const descs = Object.getOwnPropertyDescriptors(hmr.exports ?? {});
    for (const k of Object.keys(descs).sort()) {
      const d = descs[k];
      Object.defineProperty(ns, k, d.get ? { get: d.get, enumerable: true } : { value: d.value, enumerable: true, writable: true });
    }
    Object.preventExtensions(ns);
    claim("done", Object.keys(descs));
    return ns;
  }

  /**
   * What `require()` of the file at VFS `path` returns: CommonJS run (data files parsed, TypeScript and JSX transpiled
   * first), an ES module's namespace (see loadEsm).
   */
  function loadFile(path: string): unknown {
    const file = "/" + path;
    const req = makeRequire(file);
    const src = vfs!.readText(path);
    if (src === undefined) throw notFound(path, file);
    const format = dataFormat(path);
    if (format) return load(file, (m) => void (m.exports = parseDataFile(src, format)), req).exports;
    if (path.endsWith(".node")) throw Object.assign(new Error(`Cannot load native addon ${file}: .node files are not supported in the playground`), { code: "ERR_DLOPEN_FAILED" });
    // With the nearest tsconfig's JSX and decorator options, as served modules have them; its JSX runtime and
    // `bun:wrap` imports become requires (see requireRuntimeImports).
    // With its source map: the frames of `compile`'s function then read in the file's lines, as do those of plain JS.
    let mappings: string | undefined;
    let stripped = 0;
    const debug = instrumented(path);
    const transpile = () => {
      const [js, map, probes] = transpileSync(src, file, tsconfigFor(vfs!, path), true, debug).split("\0");
      if (probes) registerProbes(path, probes);
      const body = stripDirname(js);
      stripped = body === js ? 0 : 1;
      mappings = map;
      return requireRuntimeImports(body);
    };
    // What Bun runs as an ES module (see moduleKindOf, which throws Bun's error for CommonJS features next to an
    // import) loads as one (loadEsm); a file of another extension only if it has module syntax or its package's type.
    // Markdown is an ES module of its HTML, as Bun requires it.
    const esm = JS_LIKE.test(path) ? moduleKindOf(vfs!, path, src) === "esm" : MARKDOWN.test(path) || packageType(vfs!, path) === "module" || hasModuleSyntax(src);
    if (esm) return loadEsm(path, src);
    // In a debug run the project's plain JavaScript is transpiled too, for its probes.
    let code = debug || /\.[cm]?(ts|tsx|jsx)$/.test(path) ? transpile() : src;
    const url = encodeURI(`file://${file}`);
    const compile = () => {
      registerSource(url, FUNCTION_HEADER_LINES - stripped, mappings, true);
      return new Function("exports", "require", "module", "__filename", "__dirname", `${dynamicImports(code.replace(/^#!.*/, ""), file)}\n//# sourceURL=${url}`);
    };
    let body: Function;
    try {
      body = compile();
    } catch (e) {
      // Plain .js is run as written (the transpiler loads only when a program needs it), unless it doesn't parse: Bun
      // parses .js as JSX.
      if (!(e instanceof SyntaxError) || !path.endsWith(".js") || code !== src) throw e;
      code = transpile();
      body = compile();
    }
    return load(file, (m) => body.call(m.exports, m.exports, req, m, file, dirname(file) || "/"), req).exports;
  }

  /** `require.resolve`, `require.cache` & co. on a require bound to `from`. */
  function decorate(req: Require, from: string) {
    if (req.cache) return req;
    const resolve = (id: string) => {
      // Bun's own packages by their names (`ws/lib/websocket` is `ws`).
      if (isBuiltin(id)) return bunPackage(id) ? name(id) : id;
      const path = resolveFile?.(id, requireDir(from));
      if (path) return "/" + path;
      throw notFound(id, from);
    };
    resolve.paths = (id: string) => (isBuiltin(id) ? null : nodeModulePaths(requireDir(from)));
    Object.defineProperty(req, "main", { get: () => cache[(globalThis as { Bun?: { main?: string } }).Bun?.main ?? ""], enumerable: true, configurable: true });
    return Object.assign(req, { resolve, cache, extensions: Module._extensions });
  }

  function makeRequire(from: string): Require {
    return decorate((id: string) => requireFrom(id, from), from);
  }

  function createRequire(from: string | URL) {
    const s = String(from);
    const path = s.startsWith("file:") ? decodeURIComponent(new URL(s).pathname) : s;
    if (!path.startsWith("/")) throw Object.assign(new TypeError(`The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received ${JSON.stringify(s)}`), { code: "ERR_INVALID_ARG_VALUE" });
    return makeRequire(path);
  }

  const Module = Object.assign(function Module() {}, {
    createRequire,
    builtinModules: builtinModules(),
    // Of Bun's own packages, only those it lists in builtinModules (`undici`, `ws`).
    isBuiltin: (id: string) => isBuiltin(id) && (!bunPackage(String(id)) || builtinModules().includes(String(id))),
    register() {},
    registerHooks: () => ({ deregister() {} }),
    syncBuiltinESMExports() {},
    findSourceMap: () => undefined,
    enableCompileCache: () => ({ status: 0 }),
    getCompileCacheDir: () => undefined,
    constants: { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } },
    globalPaths: [] as string[],
    _cache: cache,
    _extensions: Object.create(null) as Record<string, unknown>,
    wrap: (s: string) => `(function (exports, require, module, __filename, __dirname) { ${s}\n});`,
  });
  Object.assign(Module, { Module, SourceMap: class SourceMap {}, runMain() {}, flushCompileCache() {}, _initPaths() {}, _nodeModulePaths: nodeModulePaths, ...Object.fromEntries(["_load", "_resolveFilename", "findPackageJSON", "stripTypeScriptTypes"].map((k) => [k, () => { throw new Error(`node:module.${k} is not supported in the playground`); }])) });
  // For wrapped CommonJS (cjs.ts wrapCommonJS) and served JSON: one cache, and computed requires.
  hooks.load = load;
  hooks.require = requireFrom;
  hooks.mock = mockModule;
  hooks.decorate = decorate;
  hooks.evalEsm = (file, src) => loadEsm(file.slice(1), src, true);
  hooks.requireFile = (path) => (cache["/" + path] ? cache["/" + path].exports : (esModules["/" + path] ?? loadFile(path)));
  return Module;
}

const hooks: {
  load?: (file: string, run: (m: CjsModule) => void, req: Require) => CjsModule;
  require?: (id: string, from: string) => unknown;
  mock?: (spec: string, from: string, exports: object) => void;
  decorate?: (req: Require, from: string) => Require;
  evalEsm?: (file: string, src: string) => object;
  requireFile?: (path: string) => unknown;
} = {};

/** Runtime plugins (worker/plugins.ts) for `require()` and the static imports of ES modules the worker runs itself. */
let pluginHook: ((spec: string, from: string, kind: "require" | "import") => { value: unknown } | undefined) | undefined;
export function setPluginHook(fn: typeof pluginHook) {
  pluginHook = fn;
}
/** What worker/plugins.ts needs from the module system: running a module's source, requiring a file without plugins. */
export const pluginModuleHost = () => ({ evalEsm: hooks.evalEsm!, requireFile: hooks.requireFile! });

/** `import(x)` in CommonJS the worker runs: through the worker's `__dynamicImport`, from the module's `file:` URL. */
function dynamicImports(code: string, file: string): string {
  if (!/\bimport\s*\(/.test(code)) return code;
  const literal = literalRanges(code);
  return code.replace(/(?<![\w$.])import\s*\(/g, (m, offset: number) =>
    inRanges(literal, offset) || isMethod(code, offset + m.length) ? m : `globalThis.__dynamicImport(${JSON.stringify(`file://${file}`)}, `,
  );
}

/**
 * The worker calls this once Bun's resolver has loaded: `require` then loads installed packages and project files
 * synchronously from `v`, and wrapped CommonJS shares the module cache (see wrapCommonJS).
 */
export function setRequire(v: VFS, fn: (spec: string, dir: string) => string | null, importFn: (spec: string, dir: string) => string | null, root: () => string) {
  vfs = v;
  resolveFile = fn;
  resolveImport = importFn;
  vfsRoot = root;
  const g = globalThis as Record<string, unknown>;
  g.__cjsLoad = hooks.load;
  g.__cjsRequire = hooks.require;
  // `require.resolve` & co. on the `require` of an ES module (moduleServer.ts hoistMetaRequire).
  g.__decorateRequire = (req: Require, from: string) => hooks.decorate?.(req, from) ?? req;
  g.__esmLoaded = (file: string, ns: object) => {
    esModules[file] = ns;
    importing.delete(file);
  };
  g.__esmImporting = (file: string) => void importing.add(file);
  // For `mock.module` (worker/node/test.ts) and the module the page serves in place of the mocked one (moduleServer.ts mockModule).
  g.__mockModule = (spec: string, from: string, exports: object) => hooks.mock!(spec, from, exports);
  g.__bunMock = (path: string) => mocks.get(path);
  // For the module the page serves in place of one the worker ran itself (moduleServer.ts syncEsmModule).
  g.__esmNamespace = (file: string) => esModules[file];
}
