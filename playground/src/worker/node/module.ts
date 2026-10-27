/** `node:module` needs the registry (for createRequire, builtinModules), so it is built by index.ts. */
export function createModule(registry: Record<string, object>) {
  const name = (id: string) => id.replace(/^node:/, "");
  const isBuiltin = (id: string) => name(id) in registry;

  function createRequire(_from: string | URL) {
    const req = (id: string) => {
      if (isBuiltin(id)) return registry[name(id)];
      throw Object.assign(new Error(`require(${JSON.stringify(id)}) of non-builtin is not supported in the playground`), { code: "ERR_REQUIRE_NOT_SUPPORTED" });
    };
    req.resolve = (id: string) => {
      if (isBuiltin(id)) return id;
      throw Object.assign(new Error(`require.resolve(${JSON.stringify(id)}) of non-builtin is not supported in the playground`), { code: "MODULE_NOT_FOUND" });
    };
    req.cache = {} as Record<string, unknown>;
    req.extensions = {} as Record<string, unknown>;
    req.main = undefined;
    return req;
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
    _cache: {},
    _extensions: {},
    wrap: (s: string) => `(function (exports, require, module, __filename, __dirname) { ${s}\n});`,
  });
  Object.assign(Module, { Module, SourceMap: class SourceMap {}, runMain() {}, flushCompileCache() {}, _initPaths() {}, _nodeModulePaths: (dir: string) => [`${dir}/node_modules`], ...Object.fromEntries(["_load", "_resolveFilename", "findPackageJSON", "stripTypeScriptTypes"].map((k) => [k, () => { throw new Error(`node:module.${k} is not supported in the playground`); }])) });
  return Module;
}
