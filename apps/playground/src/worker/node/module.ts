import { dirname, norm, type VFS } from "@runbun/vfs";
import { hasModuleSyntax, packageType } from "../../cjs";
import { inRanges, isMethod, literalRanges } from "../../literals";
import { runtimeTranspile } from "../../transpiler";

/** Bun's resolver over the worker's VFS (see setRequire); unset on the page, which only reads export names. */
let resolveFile: ((spec: string, dir: string) => string | null) | undefined;
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

/** `require.cache`: every CommonJS module the worker runs, whether a literal require (wrapCommonJS) or a computed one loaded it. */
const cache: Record<string, CjsModule> = Object.create(null);

/**
 * The namespace of each ES module the worker has run, by path (served modules register themselves once evaluated, see
 * moduleServer.ts serveModule): what `require()` of one returns, as in Bun. One that is still evaluating (top-level
 * await, a cycle) isn't here yet.
 */
const esModules: Record<string, object> = Object.create(null);

/** The VFS directory a `createRequire` argument names: a `file:` URL or path of a module, or a directory ending in `/`. */
function requireDir(from: string | URL): string {
  const s = String(from);
  const path = s.startsWith("file:") ? decodeURIComponent(new URL(s).pathname) : s;
  return path.endsWith("/") ? norm(path) : dirname(norm(path));
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
export function createModule(registry: Record<string, object>) {
  const name = (id: string) => id.replace(/^node:/, "");
  const isBuiltin = (id: string) => name(id) in registry;

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
    const path = resolveFile?.(id, requireDir(from));
    if (!path || !vfs) throw notFound(id, from);
    const file = "/" + path;
    return cache[file] ? cache[file].exports : (esModules[file] ?? loadFile(path).exports);
  }

  /** Runs the file at VFS `path` as CommonJS (JSON, TOML and YAML parsed, TypeScript and JSX transpiled first). */
  function loadFile(path: string): CjsModule {
    const file = "/" + path;
    const req = makeRequire(file);
    const src = vfs!.readText(path);
    if (src === undefined) throw notFound(path, file);
    if (path.endsWith(".json")) return load(file, (m) => void (m.exports = JSON.parse(src)), req);
    const data = /\.(toml|ya?ml)$/.exec(path);
    if (data) return load(file, (m) => void (m.exports = (globalThis as unknown as { Bun: Record<string, { parse(s: string): unknown }> }).Bun[data[1] === "toml" ? "TOML" : "YAML"].parse(src)), req);
    if (path.endsWith(".node")) throw Object.assign(new Error(`Cannot load native addon ${file}: .node files are not supported in the playground`), { code: "ERR_DLOPEN_FAILED" });
    const ext = /\.([cm]?)(ts|tsx|jsx)$/.exec(path);
    // The runtime transpiler declares `var __dirname = "";` (and __filename) for code it runs as a nameless input:
    // drop them, so the wrapper's values show through.
    const code = ext ? runtimeTranspile("transform", src, ext[2] === "ts" ? "ts" : (ext[2] as "tsx" | "jsx")).replace(/^(?:var (?:__dirname|__filename) = "[^"\n]*";\n)+/, "") : src;
    const esm = /\.m[jt]s$/.test(path) || (!/\.c[jt]s$/.test(path) && (packageType(vfs!, path) === "module" || hasModuleSyntax(code)));
    if (esm)
      throw Object.assign(new Error(`require() of ES module ${file} works in the playground only once the module has been imported (it can't load ES modules synchronously). Use import() or a static import first.`), {
        code: "ERR_REQUIRE_ESM",
      });
    const body = new Function("exports", "require", "module", "__filename", "__dirname", `${dynamicImports(code.replace(/^#!.*/, ""), file)}\n//# sourceURL=${encodeURI(`file://${file}`)}`);
    return load(file, (m) => body.call(m.exports, m.exports, req, m, file, dirname(file) || "/"), req);
  }

  /** `require.resolve`, `require.cache` & co. on a require bound to `from`. */
  function decorate(req: Require, from: string) {
    if (req.cache) return req;
    const resolve = (id: string) => {
      if (isBuiltin(id)) return id;
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
    builtinModules: Object.keys(registry),
    isBuiltin,
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
  return Module;
}

const hooks: { load?: (file: string, run: (m: CjsModule) => void, req: Require) => CjsModule; require?: (id: string, from: string) => unknown } = {};

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
export function setRequire(v: VFS, fn: (spec: string, dir: string) => string | null) {
  vfs = v;
  resolveFile = fn;
  const g = globalThis as Record<string, unknown>;
  g.__cjsLoad = hooks.load;
  g.__cjsRequire = hooks.require;
  g.__esmLoaded = (file: string, ns: object) => void (esModules[file] = ns);
}
