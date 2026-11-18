// Bun.build plugins, as one project both native Bun and the playground run (scripts/build-plugins.ts compares what
// they print): onResolve / onLoad (virtual modules, aliasing, externals, namespaces, custom loaders, async hooks),
// onStart, onEnd, build.config, setup validation and the errors hooks throw.
import type { BunPlugin } from "bun";

const root = import.meta.dir;
const src = `${root === "/" ? "" : root}/src`;
/** Paths under the project as `./…`, so native Bun (a temp folder) and the playground print the same. */
const prefix = new RegExp(`(^|[\\s"'(])${(root === "/" ? "/(?=[^/\\s])" : root.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "/")}`, "g");
const rel = (v: unknown): unknown =>
  typeof v === "string"
    ? v.replace(prefix, "$1./")
    : Array.isArray(v)
      ? v.map(rel)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rel(x)]))
        : v;
const show = (v: unknown) => JSON.stringify(rel(v));
const log = (label: string, ...v: unknown[]) => console.log(`${label}: ${v.map((x) => (typeof x === "string" ? (rel(x) as string) : show(x))).join(" ")}`);

const outputs = async (r: Bun.BuildOutput) => Promise.all(r.outputs.map(async (o) => ({ path: o.path, kind: o.kind, loader: o.loader, text: await o.text() })));
const errorInfo = (e: unknown) => {
  const err = e as { name?: string; message?: string; errors?: { name?: string; message?: string; level?: string; position?: { file?: string; line?: number; column?: number } | null }[] };
  return {
    name: err?.name,
    message: err?.message,
    errors: err?.errors?.map((x) => ({ name: x.name, message: x.message, level: x.level, file: x.position?.file, line: x.position?.line })),
  };
};

/** Runs one build and prints its outputs (or how it failed). */
async function run(label: string, entry: string, plugins: BunPlugin[], extra: Partial<Bun.BuildConfig> = {}) {
  try {
    const r = await Bun.build({ entrypoints: [`${src}/${entry}`], plugins, ...extra });
    log(`${label}.success`, r.success);
    for (const o of await outputs(r)) {
      // (Not `loader`: native Bun reports the entry's for every output, the playground each output's own.)
      log(`${label}.output`, { path: o.path, kind: o.kind });
      for (const line of o.text.split("\n")) if (line.trim()) log(`${label}.text`, line);
    }
    for (const l of r.logs) log(`${label}.log`, { level: l.level, message: l.message });
  } catch (e) {
    log(`${label}.threw`, errorInfo(e));
  }
}

console.log("__start__");

// Virtual modules, aliasing, a plugin text loader, a yaml loader, all with the args the hooks get.
const seen: unknown[] = [];
await run("main", "entry.ts", [
  {
    name: "virtual",
    setup(build) {
      build.onResolve({ filter: /^virtual:/ }, (args) => {
        seen.push(["resolve virtual", args]);
        return { path: args.path.slice("virtual:".length), namespace: "virtual" };
      });
      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
        seen.push(["load virtual", args.path, args.namespace, args.loader, args.side]);
        return { contents: `export default ${JSON.stringify("hi from " + args.path)};`, loader: "js" };
      });
    },
  },
  {
    name: "alias",
    setup(build) {
      build.onResolve({ filter: /^@alias\// }, async (args) => {
        await Bun.sleep(1);
        seen.push(["resolve alias", args.path, args.importer, args.kind, args.namespace, args.resolveDir]);
        return { path: `${src}/${args.path.slice("@alias/".length)}.ts` };
      });
    },
  },
  {
    name: "loaders",
    setup(build) {
      build.onLoad({ filter: /\.txt$/ }, async (args) => {
        seen.push(["load txt", args.path, args.namespace, args.loader]);
        const text = await Bun.file(args.path).text();
        return { contents: `export default ${JSON.stringify(text.trim().toUpperCase())};`, loader: "js" };
      });
      build.onLoad({ filter: /\.yaml$/ }, async (args) => ({ contents: await Bun.file(args.path).text(), loader: "yaml" }));
    },
  },
]);
// Sorted: native Bun runs the hooks in parallel, the playground one at a time.
for (const s of seen.map((x) => show(x)).sort()) console.log(`main.seen: ${s}`);

// Entry point hooks: the args an entry point's onResolve gets, and a filter that also matches the entry.
const entryArgs: unknown[] = [];
await run("entry", "plain.ts", [
  {
    name: "entry",
    setup(build) {
      build.onResolve({ filter: /plain/ }, (args) => {
        entryArgs.push(args);
        return undefined;
      });
      build.onLoad({ filter: /plain\.ts$/ }, (args) => {
        entryArgs.push(["load", args.path, args.loader, args.side]);
        return undefined;
      });
    },
  },
]);
for (const a of entryArgs) log("entry.args", a);

// Externals: marked by a plugin, kept as imports.
await run("external", "external.ts", [
  { name: "ext", setup: (b) => void b.onResolve({ filter: /^ext-/ }, (args) => ({ path: args.path, external: true })) },
]);

// Namespaces: a namespace's onLoad, `loader: "object"`, Uint8Array contents.
await run("object", "ns.ts", [
  {
    name: "data",
    setup(build) {
      build.onResolve({ filter: /^data:thing$/ }, () => ({ path: "thing", namespace: "data" }));
      build.onLoad({ filter: /.*/, namespace: "data" }, () => ({ exports: { a: 1, b: [true, null] }, loader: "object" }));
    },
  },
]);
await run("bytes", "ns.ts", [
  {
    name: "bytes",
    setup(build) {
      build.onResolve({ filter: /^data:thing$/ }, () => ({ path: "thing", namespace: "bytes" }));
      build.onLoad({ filter: /.*/, namespace: "bytes" }, () => ({ contents: new TextEncoder().encode("export default 'from bytes'"), loader: "ts" }));
    },
  },
]);

// onLoad replacing files on disk; the first hook that answers wins, a hook returning nothing passes.
await run("replace", "replace.ts", [
  { name: "skip", setup: (b) => void b.onLoad({ filter: /replaced\.ts$/ }, () => undefined) },
  {
    name: "replace",
    setup(build) {
      build.onLoad({ filter: /replaced\.ts$/ }, () => ({ contents: "export const original = 'replaced';" }));
      build.onLoad({ filter: /replaced\.ts$/ }, () => ({ contents: "export const original = 'never';" }));
    },
  },
]);

// target: bun / node / browser: the side onLoad reports.
for (const target of ["browser", "bun", "node"] as const) {
  const sides: unknown[] = [];
  await run(`target-${target}`, "plain.ts", [{ name: "side", setup: (b) => void b.onLoad({ filter: /plain\.ts$/ }, (a) => (sides.push(a.side), undefined)) }], { target });
  log(`target-${target}.side`, sides);
}

// Errors thrown in hooks, sync and async, and invalid answers.
const throwing = (label: string, hook: "resolve" | "load", fn: (args: { path: string }) => unknown, extra?: Partial<Bun.BuildConfig>) =>
  run(label, "replace.ts", [
    {
      name: label,
      setup(build) {
        if (hook === "resolve") build.onResolve({ filter: /replaced/ }, fn as never);
        else build.onLoad({ filter: /replaced\.ts$/ }, fn as never);
      },
    },
  ], extra);
await throwing("resolve-throws", "resolve", () => {
  throw new Error("resolve boom");
});
await throwing("load-rejects", "load", async () => {
  await Bun.sleep(1);
  throw new TypeError("load boom");
});
await throwing("load-throws-string", "load", () => {
  throw "a string";
});
await throwing("throw-false", "load", () => {
  throw new Error("quiet");
}, { throw: false });
await throwing("relative-path", "resolve", () => ({ path: "relative.ts" }));
await throwing("bad-path", "resolve", () => ({ path: 42 }));
await throwing("bad-external", "resolve", () => ({ path: "/x", external: "yes" }));
await throwing("no-onload-ns", "resolve", () => ({ path: "x", namespace: "nowhere" }));
await throwing("bad-loader", "load", () => ({ contents: "x", loader: "nope" }));
await throwing("bad-contents", "load", () => ({ contents: 42 }));
await throwing("object-no-exports", "load", () => ({ loader: "object" }));

// `.defer()`: native Bun waits for the other modules; the playground runs one request at a time and refuses it.
try {
  const r = await Bun.build({
    entrypoints: [`${src}/replace.ts`],
    plugins: [
      {
        name: "defer",
        setup: (b) =>
          void b.onLoad({ filter: /replaced\.ts$/ }, async (args) => {
            await args.defer();
            return { contents: "export const original = 'after defer';" };
          }),
      },
    ],
  });
  log("defer", r.success, (await r.outputs[0].text()).includes("after defer"));
} catch (e) {
  log("defer", (e as AggregateError).errors?.[0]?.message ?? String(e));
}

// onStart (sync and async, awaited before the build), async setup, onEnd seeing the result and failures.
const order: string[] = [];
await run("lifecycle", "plain.ts", [
  {
    name: "one",
    async setup(build) {
      order.push("setup one");
      await Bun.sleep(1);
      build.onStart(() => void order.push("start one"));
      build.onStart(async () => {
        await Bun.sleep(5);
        order.push("start one async done");
      });
      build.onEnd((r) => void order.push(`end one ${r.success} ${r.outputs.length} ${r.outputs.map((o) => o.kind).join(",")}`));
      order.push("setup one done");
    },
  },
  {
    name: "two",
    setup(build) {
      order.push("setup two");
      build.onEnd(async (r) => {
        await Bun.sleep(1);
        order.push(`end two ${r.logs.length}`);
      });
    },
  },
]);
log("lifecycle.order", order);
order.length = 0;
await throwing("end-on-failure", "resolve", () => {
  throw new Error("fails");
});
await run("end-sees-failure", "replace.ts", [
  {
    name: "f",
    setup(build) {
      build.onResolve({ filter: /replaced/ }, () => ({ path: `${src}/missing.ts` }));
      build.onEnd((r) => void order.push(`end ${r.success} ${r.outputs.length} ${r.logs.length}`));
    },
  },
]);
log("end-sees-failure.order", order);
await run("end-throws", "plain.ts", [{ name: "f", setup: (b) => void b.onEnd(() => Promise.reject(new Error("onEnd boom"))) }]);
await run("end-throws-sync", "plain.ts", [
  {
    name: "f",
    setup: (b) =>
      void b.onEnd(() => {
        throw new Error("onEnd sync boom");
      }),
  },
]);

// build.config, initialOptions, and a setup that changes the config the build then reads.
await run("config", "plain.ts", [
  {
    name: "config",
    setup(build) {
      const c = build.config as Bun.BuildConfig & { define?: Record<string, string> };
      log("config.seen", { entrypoints: c.entrypoints, target: c.target, minify: c.minify, same: c === (build as unknown as { config: unknown }).config });
      const io = (build as unknown as { initialOptions: Record<string, unknown> }).initialOptions;
      log("config.initialOptions", { bundle: io.bundle, entryPoints: io.entryPoints, minify: io.minify, minifyWhitespace: io.minifyWhitespace, platform: io.platform });
      c.minify = true;
    },
  },
], { target: "bun", minify: false });

// Setup validation and the builder's unsupported parts.
const invalid = async (label: string, plugins: unknown[]) => {
  try {
    await Bun.build({ entrypoints: [`${src}/plain.ts`], plugins: plugins as BunPlugin[] });
    log(label, "built");
  } catch (e) {
    const err = e as { name?: string; message?: string; code?: string };
    log(label, { name: err.name, message: err.message, code: err.code });
  }
};
await invalid("invalid-not-object", [42]);
await invalid("invalid-no-name", [{ setup() {} }]);
await invalid("invalid-empty-name", [{ name: "", setup() {} }]);
await invalid("invalid-no-setup", [{ name: "x" }]);
await invalid("invalid-filter", [{ name: "x", setup: (b: Bun.PluginBuilder) => b.onLoad({ filter: "x" as never }, () => undefined) }]);
await invalid("invalid-namespace", [{ name: "x", setup: (b: Bun.PluginBuilder) => b.onLoad({ filter: /x/, namespace: "a b" }, () => undefined) }]);
await invalid("setup-throws", [
  {
    name: "x",
    setup() {
      throw new Error("setup boom");
    },
  },
]);
await invalid("setup-rejects", [
  {
    name: "x",
    async setup() {
      throw new Error("async setup boom");
    },
  },
]);
await invalid("build-resolve", [{ name: "x", setup: (b: Bun.PluginBuilder & { resolve: () => void }) => b.resolve() }]);
await invalid("build-module", [{ name: "x", setup: (b: Bun.PluginBuilder) => b.module("x", () => ({ exports: {}, loader: "object" })) }]);

console.log("__end__");
