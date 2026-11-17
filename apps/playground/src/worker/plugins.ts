// `Bun.plugin`: runtime plugins (onResolve, onLoad, build.module) for the program's imports and requires.
//
// The page serves the worker's modules, so it is told the plugins' filters (synchronously, before the program goes on)
// and routes the imports they match to `__plugin/<importer>/<specifier>` (pluginRoutes.ts); for each it asks the
// worker here over a BroadcastChannel, which runs the hooks (async ones too) and answers with source to transpile or
// exports it keeps. `require()` runs the hooks synchronously, as Bun's does, and keeps its own instances.
import { dirname, norm } from "@runbun/vfs";
import { pluginUrl, routesThroughPlugins, splitNamespace, type PluginAnswer, type PluginFilters } from "../pluginRoutes";
import { ResolveMessage } from "./resolve";
import { XHR } from "./xhr";

type Target = { ns: string; path: string; module?: string };
type Hook = { filter: RegExp; ns: string; fn: (args: { path: string; importer?: string }) => unknown };
type Loaded =
  | { kind: "object"; exports: object }
  | { kind: "data"; value: unknown }
  | { kind: "source"; contents: string; loader: string; path: string; ns: string }
  | { kind: "file"; path: string };

const LOADERS = ["js", "jsx", "object", "ts", "tsx", "toml", "yaml", "json", "xml", "md"];

export type PluginHost = {
  /** Where the page serves modules (`/__vfs/@<client>/`). */
  vfsRoot(): string;
  /** Bun's resolver: the VFS path (no leading `/`) `spec` resolves to from `dir` (no leading `/`), or null. */
  resolve(spec: string, dir: string, kind: "import" | "require"): string | null;
  cwd(): string;
  parseData(text: string, format: "toml" | "yaml"): unknown;
  /** Runs ES module source as `file` (its extension the loader's) and returns its namespace (node/module.ts). */
  evalEsm(file: string, src: string): object;
  /** `require()` of a resolved file, as without plugins. */
  requireFile(path: string): unknown;
};

let host: PluginHost | undefined;
const resolvers: Hook[] = [];
const loaders: Hook[] = [];
const modules = new Map<string, () => unknown>();
let token: string | undefined;
/** What the program imported through the plugins, by `<namespace>:<path>` (or `module:<specifier>`). */
const imported = new Map<string, object>();
/** What it required (or imported in an ES module the worker runs itself), by kind and the same keys. */
const required = new Map<string, unknown>();

export function setPluginHost(h: PluginHost) {
  host = h;
  const g = globalThis as Record<string, unknown>;
  g.__pluginNamespace = (key: string) => imported.get(key);
  g.__pluginLoaded = (key: string, ns: object) => void imported.set(key, ns);
}

const asyncRequire = (path: string) => new TypeError(`require() async module "${path}" is unsupported. use "await import()" instead.`);
const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as { then?: unknown }).then === "function";

function filters(): PluginFilters {
  const f = (h: Hook) => ({ source: h.filter.source, flags: h.filter.flags, ns: h.ns });
  return { token: (token ??= listen()), resolve: resolvers.map(f), load: loaders.map(f), modules: [...modules.keys()] };
}

/** Tells the page the filters now, before the program imports anything else (see moduleServer.ts syncEsmRequest). */
function publish() {
  if (!host) return;
  const xhr = new XHR();
  xhr.open("GET", `${host.vfsRoot()}__esmsync/plugins/${encodeURIComponent(encodeURIComponent(JSON.stringify(filters())))}`, false);
  try {
    xhr.send();
  } catch {}
}

function listen(): string {
  const id = crypto.randomUUID();
  const ch = new BroadcastChannel(`runbun-plugins-${id}`);
  ch.onmessage = async (e: MessageEvent<{ id: number; importer: string; spec: string }>) => {
    const m = e.data;
    if (typeof m?.id !== "number" || !("spec" in m)) return;
    ch.postMessage({ reply: m.id, answer: await serve(m.importer, m.spec) });
  };
  return id;
}

/** The directory imports of `importer` resolve from: its own for a path, else the working directory. */
const dirOf = (importer: string) => (importer.startsWith("/") ? (dirname(norm(importer)) || "") : norm(host!.cwd()));

/** The hooks' answer for `spec` imported from `importer`: where it is (namespace and path). */
function resolveSpec(spec: string, importer: string, kind: "import" | "require", sync: boolean): Target | Promise<Target> {
  if (modules.has(spec)) return { ns: "module", path: spec, module: spec };
  const [ns, path] = splitNamespace(spec);
  let normal: string | null = null;
  if (ns === "file") {
    normal = host!.resolve(spec, dirOf(importer), kind);
    if (normal === null) throw new ResolveMessage(spec, importer);
  }
  const hooks = resolvers.filter((h) => h.ns === ns && h.filter.test(path));
  const args = { path, importer };
  const settle = (r: unknown): { ns: string; path: string } | undefined => {
    if (r === null || typeof r !== "object" || (r as { path?: unknown }).path === undefined) return undefined;
    const p = (r as { path: unknown; namespace?: unknown }).path;
    if (typeof p !== "string") throw new Error('Expected "path" to be a string in onResolve plugin');
    const rns = String((r as { namespace?: unknown }).namespace || "file");
    if (rns === "file" && !p.startsWith("/")) {
      const t = host!.resolve(p, dirOf(importer), kind);
      if (t === null) throw new ResolveMessage(p, importer);
      return { ns: rns, path: `/${t}` };
    }
    return { ns: rns, path: rns === "file" ? `/${norm(p)}` : p };
  };
  const fallback = () => {
    if (normal !== null) return { ns: "file", path: `/${normal}` };
    throw new ResolveMessage(spec, importer);
  };
  // Sync while the hooks are; the first that returns a path wins.
  const run = (i: number): { ns: string; path: string } | Promise<{ ns: string; path: string }> => {
    for (; i < hooks.length; i++) {
      const r = hooks[i].fn(args);
      if (isThenable(r)) {
        if (sync) throw asyncRequire(spec);
        const next = i + 1;
        return Promise.resolve(r).then((v) => settle(v) ?? run(next));
      }
      const hit = settle(r);
      if (hit) return hit;
    }
    return fallback();
  };
  return run(0);
}

/** The module at `ns`/`path`: what its onLoad hook (or `build.module` callback) gives, or the file itself. */
function load(target: { ns: string; path: string; module?: string }, importer: string, sync: boolean): Loaded | Promise<Loaded> {
  const { ns, path } = target;
  let r: unknown;
  if (target.module !== undefined) r = modules.get(target.module)!();
  else {
    const hook = loaders.find((h) => h.ns === ns && h.filter.test(path));
    if (!hook) {
      if (ns === "file") return { kind: "file", path };
      throw new ResolveMessage(`${ns}:${path}`, importer);
    }
    r = hook.fn({ path });
  }
  if (isThenable(r)) {
    if (sync) throw asyncRequire(path);
    return Promise.resolve(r).then((v) => loaded(v, target));
  }
  return loaded(r, target);
}

function loaded(r: unknown, { ns, path }: { ns: string; path: string }): Loaded {
  if (r === null || typeof r !== "object") throw new TypeError("onLoad() expects an object returned");
  const o = r as { loader?: unknown; contents?: unknown; exports?: unknown };
  const ext = /\.([a-z]+)$/.exec(path)?.[1];
  const loader = o.loader === undefined ? (ext && LOADERS.includes(ext) && ext !== "object" ? ext : "js") : String(o.loader);
  if (!LOADERS.includes(loader)) throw new Error('Expected loader to be one of "js", "jsx", "object", "ts", "tsx", "toml", "yaml", "json", "xml", or "md"');
  if (loader === "object") {
    if (o.exports === null || typeof o.exports !== "object") throw new TypeError('"object" loader must return an "exports" object');
    return { kind: "object", exports: o.exports };
  }
  const contents = typeof o.contents === "string" ? o.contents : o.contents instanceof Uint8Array || o.contents instanceof ArrayBuffer ? new TextDecoder().decode(o.contents) : String(o.contents ?? "");
  if (loader === "json" || loader === "toml" || loader === "yaml") return { kind: "data", value: loader === "json" ? JSON.parse(contents) : host!.parseData(contents, loader) };
  if (loader === "xml" || loader === "md") throw new Error(`The "${loader}" loader isn't supported by runtime plugins in the playground`);
  return { kind: "source", contents, loader, path, ns };
}

const keyOf = (t: { ns: string; path: string; module?: string }) => (t.module !== undefined ? `module:${t.module}` : `${t.ns}:${t.path}`);
/** A data module's namespace, as an imported JSON file's: the value as `default`, an object's keys by name. */
const dataNamespace = (v: unknown) => Object.assign(Object.create(null) as object, v !== null && typeof v === "object" && !Array.isArray(v) ? v : {}, { default: v });
/** The VFS file (no leading `/`) a module's source is transpiled as: its extension says the loader. */
function sourceFile(l: Extract<Loaded, { kind: "source" }>): string {
  const base = l.ns === "file" ? l.path.slice(1) : `${l.ns}:${l.path.replace(/^\/+/, "")}`;
  return base.endsWith(`.${l.loader}`) ? base : `${base}.${l.loader}`;
}

/** The page's question: the module for `spec` imported from `importer`. */
async function serve(importer: string, spec: string): Promise<PluginAnswer> {
  try {
    // `=<target>`: resolved by the worker already (pluginImportUrl).
    const target: Target = spec.startsWith("=") ? (JSON.parse(spec.slice(1)) as Target) : await resolveSpec(spec, importer, "import", false);
    const key = keyOf(target);
    const hit = imported.get(key);
    if (hit) return { kind: "names", key, names: Object.keys(hit) };
    const l = await load(target, importer, false);
    if (l.kind === "file") return { kind: "file", path: l.path };
    if (l.kind === "object" || l.kind === "data") {
      const ns = l.kind === "object" ? l.exports : dataNamespace(l.value);
      imported.set(key, ns);
      return { kind: "names", key, names: Object.keys(ns) };
    }
    const file = sourceFile(l);
    return { kind: "source", key, contents: l.contents, file, dir: l.ns === "file" ? dirname(l.path.slice(1)) : norm(host!.cwd()), importer: target.module ?? (l.ns === "file" ? l.path : `${l.ns}:${l.path}`) };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return { kind: "error", name: err.name, message: err.message };
  }
}

/**
 * `require(spec)` (or a static import of an ES module the worker runs itself) from `from` (a module path, or a
 * directory ending in `/`) through the plugins: `{ value }`, or undefined when they don't take it.
 */
export function pluginRequire(spec: string, from: string, kind: "require" | "import"): { value: unknown } | undefined {
  if (!host || !(resolvers.length || loaders.length || modules.size)) return undefined;
  const importer = from;
  const dir = importer.endsWith("/") ? norm(importer) : dirOf(importer);
  const normal = splitNamespace(spec)[0] === "file" ? host.resolve(spec, dir, kind === "import" ? "import" : "require") : null;
  if (!routesThroughPlugins(filters(), spec, normal === null ? null : `/${normal}`)) return undefined;
  const target = resolveSpec(spec, importer, kind, true) as { ns: string; path: string; module?: string };
  const key = keyOf(target);
  // A data module is its value to require() and a namespace to an import, so each has its own.
  const cacheKey = `${kind} ${key}`;
  if (required.has(cacheKey)) return { value: required.get(cacheKey) };
  const l = load(target, importer, true) as Loaded;
  let value: unknown;
  if (l.kind === "file") value = host.requireFile(l.path.slice(1));
  // As a namespace has them: sorted.
  else if (l.kind === "object") value = Object.fromEntries(Object.entries(l.exports).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  else if (l.kind === "data") value = kind === "import" ? dataNamespace(l.value) : l.value;
  else value = host.evalEsm(`/${sourceFile(l)}`, l.contents);
  required.set(cacheKey, value);
  return { value };
}

/** The URL a computed `import(spec)` from the module at `from` (a `file:` URL) loads, if the plugins take it. */
export function pluginImportUrl(from: string, spec: string): Promise<string> | undefined {
  if (!host) return undefined;
  const importer = from.startsWith("file:") ? decodeURIComponent(new URL(from).pathname) : from;
  const namespaced = splitNamespace(spec)[0] !== "file";
  if (!namespaced) {
    if (!(resolvers.length || loaders.length || modules.size)) return undefined;
    const normal = host.resolve(spec, dirOf(importer), "import");
    if (!routesThroughPlugins(filters(), spec, normal === null ? null : `/${normal}`)) return undefined;
  } else if (!modules.has(spec) && host.resolve(spec, dirOf(importer), "import") !== null) return undefined;
  // Resolved here, on every import as in Bun; the module is then served (and kept) by where it resolved to.
  const h = host;
  return (async () => {
    const target = await resolveSpec(spec, importer, "import", false);
    if (target.ns === "file" && target.module === undefined && !loaders.some((l) => l.ns === "file" && l.filter.test(target.path))) return `${h.vfsRoot()}${target.path.slice(1)}`;
    return `${h.vfsRoot()}${pluginUrl(importer, `=${JSON.stringify(target)}`)}`;
  })();
}

type Builder = {
  onResolve(o: { filter: RegExp; namespace?: string }, fn: Hook["fn"]): Builder;
  onLoad(o: { filter: RegExp; namespace?: string }, fn: Hook["fn"]): Builder;
  module(spec: string, fn: () => unknown): Builder;
  target: string;
};

/** `Bun.plugin(options)`: runs `setup` with the builder; a Promise if `setup` returns one. */
export function plugin(options: { name?: string; setup?: (build: Builder) => unknown; target?: string }): Promise<void> | undefined {
  if (options === null || typeof options !== "object") throw new TypeError("plugin needs an object as first argument");
  if (typeof options.setup !== "function") throw new TypeError("plugin needs a setup() function");
  let inSetup = true;
  const changed = () => inSetup || publish();
  const hook = (name: string, list: Hook[]) =>
    function (this: Builder, o: { filter: RegExp; namespace?: string }, fn: Hook["fn"]) {
      if (o === null || typeof o !== "object" || !(o.filter instanceof RegExp)) throw new Error(`${name}() expects first argument to be an object with a filter RegExp`);
      if (typeof fn !== "function") throw new Error(`${name}() expects second argument to be a function`);
      list.push({ filter: o.filter, ns: typeof o.namespace === "string" && o.namespace ? o.namespace : "file", fn });
      changed();
      return build;
    };
  const build: Builder = {
    onResolve: hook("onResolve", resolvers),
    onLoad: hook("onLoad", loaders),
    module(spec: string, fn: () => unknown) {
      if (typeof fn !== "function") throw new Error("module() expects second argument to be a function");
      modules.set(String(spec), fn);
      changed();
      return build;
    },
    target: "bun",
  };
  let r: unknown;
  try {
    r = options.setup(build);
  } finally {
    inSetup = false;
    publish();
  }
  return isThenable(r) ? Promise.resolve(r).then(() => undefined) : undefined;
}

/** `Bun.plugin.clearAll()`: no hooks or modules any more (what was loaded stays loaded). */
plugin.clearAll = () => {
  resolvers.length = 0;
  loaders.length = 0;
  modules.clear();
  publish();
};
