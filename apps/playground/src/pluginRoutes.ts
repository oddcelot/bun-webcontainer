// Which imports go through the worker's runtime plugins (`Bun.plugin`, worker/plugins.ts). The worker tells the page
// its plugins' filters (moduleServer.ts serves `__plugin/<importer>/<specifier>` for those by asking it); both decide
// with this, from the same filters.

/** A plugin's hooks as data: its filters' sources and flags, and the namespaces they apply in. */
export type PluginFilters = {
  /** The worker's plugins, as it named them to the page (a "plugins-token" message): where the page asks for a module. */
  token: string;
  resolve: { source: string; flags: string; ns: string }[];
  load: { source: string; flags: string; ns: string }[];
  /** `build.module` specifiers. */
  modules: string[];
};

/** Prefixes that aren't plugin namespaces. */
const RESERVED = new Set(["node", "bun", "file", "http", "https", "data", "blob"]);

/** `ns:path` -> [ns, path]; anything else is in the `file` namespace, as Bun splits a specifier for onResolve. */
export function splitNamespace(spec: string): [ns: string, path: string] {
  const m = /^([A-Za-z][\w.+-]*):(.+)$/s.exec(spec);
  return m && !RESERVED.has(m[1]) ? [m[1], m[2]] : ["file", spec];
}

const regexps = new Map<string, RegExp>();
const test = (f: { source: string; flags: string }, s: string) => {
  const key = `${f.flags}/${f.source}`;
  let re = regexps.get(key);
  if (!re) regexps.set(key, (re = new RegExp(f.source, f.flags.replace(/[gy]/g, ""))));
  return re.test(s);
};

/**
 * Whether `spec` goes through the plugins: a `build.module` name, a namespaced specifier an onResolve hook takes, or a
 * specifier that resolves (to `resolved`, a VFS path with a leading `/`) and an onResolve or onLoad hook of the `file`
 * namespace matches. As in Bun, a file specifier that doesn't resolve never reaches the plugins.
 */
export function routesThroughPlugins(filters: PluginFilters | undefined, spec: string, resolved: string | null): boolean {
  if (!filters) return false;
  if (filters.modules.includes(spec)) return true;
  const [ns, path] = splitNamespace(spec);
  if (ns !== "file") return filters.resolve.some((f) => f.ns === ns && test(f, path));
  if (resolved === null) return false;
  return filters.resolve.some((f) => f.ns === "file" && test(f, spec)) || filters.load.some((f) => f.ns === "file" && test(f, resolved));
}

/** The URL (under the VFS root) the worker's plugins serve `spec` imported from `importer` at. */
export const pluginUrl = (importer: string, spec: string) => `__plugin/${encodeURIComponent(encodeURIComponent(importer))}/${encodeURIComponent(encodeURIComponent(spec))}`;

/** What the worker answers for a module of its plugins (moduleServer.ts makes the module from it). */
export type PluginAnswer =
  | { kind: "error"; name: string; message: string }
  /** No onLoad hook: the file as it is served without plugins. */
  | { kind: "file"; path: string }
  /** The exports the worker holds (`globalThis.__pluginNamespace(key)`). */
  | { kind: "names"; key: string; names: string[] }
  /** Source to transpile as `file` (its extension the loader's), resolving its imports from `dir` (no leading `/`). */
  | { kind: "source"; key: string; contents: string; file: string; dir: string; importer: string };
