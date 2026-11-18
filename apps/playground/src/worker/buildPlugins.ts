// `Bun.build({ plugins })`: Bun's BundlerPlugin.ts (runSetupFunction, runOnResolvePlugins, runOnLoadPlugins,
// runOnEndCallbacks) for the wasm bundler. The bundler asks through the `bun_plugin.*` imports
// (crates/bundle-wasm/src/plugins.rs): which paths a filter matches, then the onResolve / onLoad chain for each. One
// request runs at a time, inside the bundle: an async hook suspends the bundler (JSPI) until it settles, so without
// `WebAssembly.Suspending` only hooks that answer synchronously work. See crates/bundle-wasm/NOTES.md.

type Hook = [filter: RegExp, callback: (args: object) => unknown];
type MaybePromise<T> = T | Promise<T>;
type Callback = (...args: never[]) => unknown;

/** `bun_ast::Loader` in discriminant order (bun/src/ast/loader.rs): the ids the bundler sends and takes. */
const LOADERS = [
  "jsx", "js", "ts", "tsx", "css", "file", "json", "jsonc", "toml", "wasm", "napi", "base64", "dataurl", "text", "bunsh",
  "sqlite", "sqlite_embedded", "html", "yaml", "json5", "md", "xml",
];

/** JSPI: async hooks suspend the bundler. Chrome 137+; without it hooks must answer synchronously. */
export const jspi = typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function";

const enc = new TextEncoder();
const dec = new TextDecoder();
const isPromise = (v: unknown): v is Promise<unknown> => v instanceof Promise;
const isObject = (v: unknown): v is Record<string, unknown> => (typeof v === "object" && v !== null) || typeof v === "function";
const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) || "/" : ".");

/** Bun's `notImplementedIssueFn` as Bun.build's builder has it. */
const notImplemented = (issue: number, feature: string) => () => {
  throw new TypeError(`${feature} is not implemented yet. See https://github.com/oven-sh/bun/issues/${issue}`);
};
const invalidArgs = (message: string) => Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });

/** The answer bytes (layout: plugins.rs). */
const noMatch = new Uint8Array([0]);
const failed = (e: unknown) => {
  let text: string;
  try {
    text = e instanceof Error ? e.message : String(e);
  } catch {
    text = "A bundler plugin threw a value that could not be converted to a string";
  }
  const m = enc.encode(text);
  const out = new Uint8Array(1 + m.length);
  out[0] = 2;
  out.set(m, 1);
  return out;
};

export class BuildPlugins {
  onResolve = new Map<string, Hook[]>();
  onLoad = new Map<string, Hook[]>();
  onEnd: ((result: unknown) => unknown)[] = [];

  /**
   * Runs each plugin's `setup` with `config` (the object passed to `Bun.build`, which setup may change), in order,
   * awaiting async ones, then the `onStart` callbacks' promises. Validation errors as Bun's `Config::from_js`.
   */
  static async setup(plugins: unknown, config: Record<string, unknown>): Promise<BuildPlugins | undefined> {
    if (!Array.isArray(plugins) || plugins.length === 0) return undefined;
    const self = new BuildPlugins();
    let promises: Promise<unknown>[] | undefined;
    for (const plugin of plugins as unknown[]) {
      if (!isObject(plugin) || typeof plugin === "function") throw invalidArgs("Expected plugin to be an object");
      if (typeof plugin.name !== "string") throw invalidArgs("Expected plugin to have a name");
      if (plugin.name === "") throw invalidArgs("Expected plugin to have a non-empty name");
      if (typeof plugin.setup !== "function") throw invalidArgs("Expected plugin to have a setup() function");
      promises = await self.runSetup(plugin.setup as Callback, config, promises);
    }
    if (promises?.length) await Promise.all(promises);
    return self;
  }

  /** `runSetupFunction`: the builder `setup` gets; its hooks join the maps once setup returns (or settles). */
  private runSetup(setup: Callback, config: Record<string, unknown>, promises: Promise<unknown>[] | undefined) {
    const self = this;
    const onLoadPlugins = new Map<string, Hook[]>();
    const onResolvePlugins = new Map<string, Hook[]>();
    const validate = (filterObject: unknown, callback: unknown, map: Map<string, Hook[]>) => {
      if (!filterObject || !isObject(filterObject)) throw new TypeError('Expected an object with "filter" RegExp');
      if (!callback || typeof callback !== "function") throw new TypeError("lmao callback must be a function");
      let { filter, namespace = "file" } = filterObject as { filter?: unknown; namespace?: unknown };
      if (!filter) throw new TypeError('Expected an object with "filter" RegExp');
      if (!(filter instanceof RegExp)) throw new TypeError("filter must be a RegExp");
      if (namespace && typeof namespace !== "string") throw new TypeError("namespace must be a string");
      if (((namespace as string | undefined)?.length ?? 0) === 0) namespace = "file";
      if (!/^([/$a-zA-Z0-9_\\-]+)$/.test(namespace as string)) throw new TypeError("namespace can only contain $a-zA-Z0-9_\\-");
      const list = map.get(namespace as string);
      if (list) list.push([filter, callback as Hook[1]]);
      else map.set(namespace as string, [[filter, callback as Hook[1]]]);
    };
    const minify = config.minify as boolean | { identifiers?: boolean; whitespace?: boolean; syntax?: boolean } | undefined;
    const builder = {
      config,
      onDispose: notImplemented(2771, "On-dispose callbacks"),
      onEnd(this: unknown, callback: unknown) {
        if (typeof callback !== "function")
          throw Object.assign(new TypeError(`The "callback" argument must be of type function. Received ${callback === undefined ? "undefined" : typeof callback}`), { code: "ERR_INVALID_ARG_TYPE" });
        self.onEnd.push(callback as (r: unknown) => unknown);
        return this;
      },
      onLoad(this: unknown, filter: unknown, callback: unknown) {
        validate(filter, callback, onLoadPlugins);
        return this;
      },
      onResolve(this: unknown, filter: unknown, callback: unknown) {
        validate(filter, callback, onResolvePlugins);
        return this;
      },
      onBeforeParse() {
        throw new TypeError("onBeforeParse `napiModule` must be a Napi module which exports the `BUN_PLUGIN_NAME` symbol.");
      },
      onStart(this: unknown, callback: unknown) {
        if (typeof callback !== "function") throw new TypeError("callback must be a function");
        const ret = (callback as () => unknown)();
        if (isPromise(ret)) {
          ret.catch(() => {});
          (promises ??= []).push(ret);
        }
        return this;
      },
      resolve: notImplemented(2771, "build.resolve()"),
      module: () => {
        throw new TypeError("module() is not supported in Bun.build() yet. Only via Bun.plugin() at runtime");
      },
      addPreload: () => {
        throw new TypeError("addPreload() is not supported in Bun.build() yet.");
      },
      initialOptions: {
        ...config,
        bundle: true,
        entryPoints: config.entrypoints ?? config.entryPoints ?? [],
        minify: typeof minify === "boolean" ? minify : false,
        minifyIdentifiers: minify === true || (minify as { identifiers?: boolean } | undefined)?.identifiers,
        minifyWhitespace: minify === true || (minify as { whitespace?: boolean } | undefined)?.whitespace,
        minifySyntax: minify === true || (minify as { syntax?: boolean } | undefined)?.syntax,
        outbase: config.root,
        platform: config.target === "bun" ? "node" : config.target,
      },
      esbuild: {},
    };
    const merge = (into: Map<string, Hook[]>, from: Map<string, Hook[]>) => {
      for (const [ns, hooks] of from) into.set(ns, [...(into.get(ns) ?? []), ...hooks]);
    };
    const done = () => {
      merge(this.onLoad, onLoadPlugins);
      merge(this.onResolve, onResolvePlugins);
      return promises;
    };
    const result = (setup as (b: typeof builder) => unknown)(builder);
    return isPromise(result) ? result.then(done) : done();
  }

  /** Bun's `anyMatches`: is there a filter for `path` in `namespace` (empty: "file")? */
  matches(onLoad: boolean, namespace: string, path: string) {
    for (const [filter] of (onLoad ? this.onLoad : this.onResolve).get(namespace || "file") ?? []) {
      if (filter.global || filter.sticky) filter.lastIndex = 0;
      if (filter.test(path)) return true;
    }
    return false;
  }

  /** Calls the matching hooks in order until one answers: `answer` turns a result into the answer, or undefined to go on. */
  private chain(hooks: Hook[], path: string, args: object, answer: (result: Record<string, unknown>) => Uint8Array | undefined): MaybePromise<Uint8Array> {
    const step = (i: number): MaybePromise<Uint8Array> => {
      for (; i < hooks.length; i++) {
        const [filter, callback] = hooks[i];
        if (filter.global || filter.sticky) filter.lastIndex = 0;
        if (!filter.test(path)) continue;
        const result = callback(args);
        const next = (r: unknown) => (r && isObject(r) ? answer(r) : undefined);
        if (isPromise(result)) {
          const rest = i + 1;
          return result.then((r) => next(r) ?? step(rest));
        }
        const a = next(result);
        if (a) return a;
      }
      return noMatch;
    };
    return step(0);
  }

  /** `runOnResolvePlugins`; the answer as plugins.rs reads it. */
  resolve(specifier: string, namespace: string, importer: string, kind: string): MaybePromise<Uint8Array> {
    const hooks = this.onResolve.get(namespace);
    if (!hooks) return noMatch;
    const args = { path: specifier, importer, namespace, resolveDir: namespace === "file" ? dirname(importer) : undefined, kind };
    return this.chain(hooks, specifier, args, (result) => {
      let { path, namespace: userNamespace = namespace, external } = result as { path?: unknown; namespace?: unknown; external?: unknown };
      if (path !== undefined && typeof path !== "string") throw new TypeError("onResolve plugins 'path' field must be a string if provided");
      if (result.namespace !== undefined && typeof result.namespace !== "string")
        throw new TypeError("onResolve plugins 'namespace' field must be a string if provided");
      if (!path) return undefined;
      if (!userNamespace) userNamespace = namespace;
      if (typeof external !== "boolean" && external !== undefined && external !== null)
        throw new TypeError('onResolve plugins "external" field must be boolean or unspecified');
      if (!external) {
        if (userNamespace === "file" && (path[0] !== "/" || path.includes("..")))
          throw new TypeError('onResolve plugin "path" must be absolute when the namespace is "file"');
        if (userNamespace === "dataurl" && !path.startsWith("data:"))
          throw new TypeError('onResolve plugin "path" must start with "data:" when the namespace is "dataurl"');
        if (userNamespace && userNamespace !== "file" && !this.onLoad.has(userNamespace as string))
          throw new TypeError(`Expected onLoad plugin for namespace ${userNamespace} to exist`);
      }
      const p = enc.encode(path);
      const ns = enc.encode(userNamespace as string);
      const out = new Uint8Array(6 + p.length + ns.length);
      out[0] = 1;
      out[1] = external ? 1 : 0;
      new DataView(out.buffer).setUint32(2, p.length, true);
      out.set(p, 6);
      out.set(ns, 6 + p.length);
      return out;
    });
  }

  /** `runOnLoadPlugins`; the answer as plugins.rs reads it. */
  load(path: string, namespace: string, defaultLoaderId: number, serverSide: boolean): MaybePromise<Uint8Array> {
    const hooks = this.onLoad.get(namespace);
    if (!hooks) return noMatch;
    const defaultLoader = LOADERS[defaultLoaderId];
    const defer = () => {
      throw new TypeError("onLoad's defer() is not supported in the browser: the bundler runs one plugin request at a time");
    };
    const args = { path, namespace, loader: defaultLoader, defer, side: serverSide ? "server" : "client" };
    return this.chain(hooks, path, args, (result) => {
      let { contents, loader = defaultLoader } = result as { contents?: unknown; loader?: unknown };
      if (loader === "object") {
        if (!("exports" in result)) throw new TypeError('onLoad plugin returning loader: "object" must have "exports" property');
        try {
          contents = JSON.stringify(result.exports);
          loader = "json";
        } catch (e) {
          throw new TypeError("When using Bun.build, onLoad plugin must return a JSON-serializable object: " + e);
        }
      }
      if (typeof contents !== "string" && !(ArrayBuffer.isView(contents) && !(contents instanceof DataView)))
        throw new TypeError('onLoad plugins must return an object with "contents" as a string or Uint8Array');
      if (typeof loader !== "string") throw new TypeError('onLoad plugins must return an object with "loader" as a string');
      const id = LOADERS.indexOf(loader);
      if (id < 0) throw new TypeError(`Loader ${loader} is not supported.`);
      const bytes =
        typeof contents === "string" ? enc.encode(contents) : new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
      const out = new Uint8Array(2 + bytes.length);
      out[0] = 1;
      out[1] = id;
      out.set(bytes, 2);
      return out;
    });
  }

  /**
   * The `bun_plugin` imports for one bundle over `memory`. With JSPI, `resolve` and `load` suspend the bundler while
   * an async hook runs (the caller must call `bundle_c` through `WebAssembly.promising`); without it an async hook
   * fails its request.
   */
  imports(memory: () => WebAssembly.Memory): WebAssembly.ModuleImports {
    let pending: Uint8Array = noMatch;
    const str = (p: bigint, n: bigint) => dec.decode(new Uint8Array(memory().buffer, Number(p), Number(n)));
    const settle = (run: () => MaybePromise<Uint8Array>): MaybePromise<bigint> => {
      const done = (a: Uint8Array) => {
        pending = a;
        return BigInt(a.length);
      };
      let a: MaybePromise<Uint8Array>;
      try {
        a = run();
      } catch (e) {
        return done(failed(e));
      }
      if (!isPromise(a)) return done(a);
      if (!jspi) {
        a.catch(() => {});
        return done(failed(new TypeError("Async bundler plugin hooks need WebAssembly JSPI (Chrome 137+): this browser can only run hooks that return synchronously")));
      }
      return a.then(done, (e) => done(failed(e)));
    };
    const suspending = (f: (...a: never[]) => unknown) =>
      jspi ? new (WebAssembly as unknown as { Suspending: new (f: unknown) => unknown }).Suspending(f) : f;
    return {
      any_matches: (onLoad: number, np: bigint, nl: bigint, pp: bigint, pl: bigint) => (this.matches(onLoad !== 0, str(np, nl), str(pp, pl)) ? 1 : 0),
      resolve: suspending((np: bigint, nl: bigint, pp: bigint, pl: bigint, ip: bigint, il: bigint, kp: bigint, kl: bigint) =>
        settle(() => this.resolve(str(pp, pl), str(np, nl), str(ip, il), str(kp, kl))),
      ) as WebAssembly.ImportValue,
      load: suspending((np: bigint, nl: bigint, pp: bigint, pl: bigint, loader: number, server: number) =>
        settle(() => this.load(str(pp, pl), str(np, nl), loader, server !== 0)),
      ) as WebAssembly.ImportValue,
      take: (dst: bigint) => void new Uint8Array(memory().buffer, Number(dst), pending.length).set(pending),
    };
  }

  /** `runOnEndCallbacks`: each sees the result; a throw or rejection becomes the build's rejection. */
  async end(result: unknown) {
    const promises: Promise<unknown>[] = [];
    for (const callback of this.onEnd) {
      try {
        const r = callback(result);
        if (isPromise(r)) promises.push(r);
      } catch (e) {
        promises.push(Promise.reject(e));
      }
    }
    if (promises.length) await Promise.all(promises);
  }
}
