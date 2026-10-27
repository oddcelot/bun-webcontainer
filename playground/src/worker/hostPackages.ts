// Host packages: the playground supplies these itself instead of the user's node_modules copy.
// The specifiers are exactly the ones Vite 8 imports from rolldown (native bindings can't run in a browser).
// Note: the wasm binding allocates a 1 GiB shared memory, so this module must only be imported by the worker.
const loaders: Record<string, () => Promise<object>> = {
  rolldown: () => import("@rolldown/browser"),
  "rolldown/experimental": () => import("@rolldown/browser/experimental"),
  "rolldown/filter": () => import("@rolldown/browser/filter"),
  "rolldown/parseAst": () => import("@rolldown/browser/parseAst"),
  "rolldown/plugins": () => import("@rolldown/browser/plugins"),
  "rolldown/utils": () => import("@rolldown/browser/utils"),
};

export const hostSpecifiers = Object.keys(loaders);

const cache = new Map<string, Promise<object>>();
(globalThis as Record<string, unknown>).__hostPackage = (spec: string) => {
  let p = cache.get(spec);
  if (!p) cache.set(spec, (p = loaders[spec]()));
  return p;
};
