// Bun.plugin: onResolve/onLoad with filters and namespaces, build.module, loaders, async hooks and setup, import and
// require, clearAll. Specifiers are computed (`imp`): Bun resolves literal ones when it loads the importing file,
// before a plugin registered in it could see them, but namespaced (`ns:x`) ones.
export async function plugins(log: (line: string) => void) {
  const root = import.meta.dir === "/" ? "" : import.meta.dir;
  const clean = (s: string) => s.replace(new RegExp(`${RegExp.escape(root)}/(?=data/|plugin)`, "g"), "<root>/");
  const imp = (s: string) => import(s);
  const req = (s: string) => require(s);
  const show = (m: unknown) => clean(JSON.stringify(m));
  const t = async (label: string, f: () => unknown) => {
    try {
      log(`${label}: ${show(await f())}`);
    } catch (e) {
      const err = e as Error;
      log(`${label}: threw ${err.name} ${clean(err.message)}`);
    }
  };
  const keys = (m: object) => Object.keys(m).sort().join();

  const returned = Bun.plugin({
    name: "test",
    setup(build) {
      log(`builder: ${keys(build)} ${build.target}`);
      build.onResolve({ filter: /.*/, namespace: "virtual" }, (args) => {
        log(`onResolve virtual: ${show(args)}`);
        return { path: args.path, namespace: "virt" };
      });
      build.onLoad({ filter: /.*/, namespace: "virt" }, (args) => {
        log(`onLoad virt: ${show(args)}`);
        return { contents: `import { join } from "node:path"; export const name: string = ${JSON.stringify(args.path)}; export default join("a", "b");`, loader: "ts" };
      });
      build.onLoad({ filter: /\.yaml2$/ }, async (args) => {
        log(`onLoad yaml2: ${show(args)}`);
        const text = await Bun.file(args.path).text();
        return { contents: `export default ${JSON.stringify(Object.fromEntries(text.trim().split("\n").map((l) => l.split(": "))))};`, loader: "js" };
      });
      build.onLoad({ filter: /\.txt2$/ }, () => ({ contents: "hello", loader: "text" }) as never);
      build.onLoad({ filter: /\.json2$/ }, () => ({ contents: `{ "a": [1, 2] }`, loader: "json" }));
      build.onLoad({ filter: /\.obj$/ }, () => ({ exports: { x: 1, default: "dflt" }, loader: "object" }));
      build.onLoad({ filter: /\.tsx2$/ }, () => ({ contents: "const n = <T,>(x: T): T => x; export default n(3);", loader: "tsx" }));
      build.onLoad({ filter: /\.fall$/ }, () => undefined as never);
      build.onResolve({ filter: /real\.ts$/ }, (args) => {
        log(`onResolve real: ${Object.keys(args).join()} ${clean(args.importer)}`);
        return { path: `${root}/data/other.ts` };
      });
      build.onLoad({ filter: /other\.ts$/ }, (args) => ({ contents: `export default ${JSON.stringify(args.path)};`, loader: "ts" }));
      build.onResolve({ filter: /.*/, namespace: "chain" }, () => undefined);
      build.onResolve({ filter: /.*/, namespace: "chain" }, (args) => ({ path: `chained-${args.path}`, namespace: "obj" }));
      build.onLoad({ filter: /.*/, namespace: "obj" }, (args) => ({ exports: { path: args.path }, loader: "object" }));
      build.onResolve({ filter: /.*/, namespace: "later" }, async (args) => ({ path: args.path, namespace: "obj" }));
      build.onResolve({ filter: /.*/, namespace: "bad" }, () => ({ path: 5 }) as never);
      build.onResolve({ filter: /.*/, namespace: "noload" }, () => ({ path: "z", namespace: "zz" }));
      build.onResolve({ filter: /.*/, namespace: "nested" }, () => ({ path: "n", namespace: "nest" }));
      build.onLoad({ filter: /.*/, namespace: "nest" }, () => ({ contents: "import a from './data/real.ts'; import { path as b } from 'chain:x'; export default [a, b];", loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "noobj" }, () => ({ loader: "object" }) as never);
      build.onResolve({ filter: /.*/, namespace: "noobj" }, () => ({ path: "q", namespace: "noobj" }));
      build.module("my-virtual", () => ({ exports: { a: 1, b: "two" }, loader: "object" }));
      build.module("my-src", () => ({ contents: "import x from 'virtual:from-module'; export const fromSrc = 42; export { x };", loader: "js" }));
      build.module("my-async", async () => ({ exports: { late: true }, loader: "object" }));
    },
  });
  log(`plugin returns: ${returned}`);

  await t("virtual", async () => {
    const v = await imp("virtual:hello");
    return [v.name, v.default, keys(v)];
  });
  await t("same instance", async () => (await imp("virtual:hello")) === (await imp("virtual:hello")));
  await t("literal namespaced import", async () => (await import("virtual:literal")).name);
  await t("yaml2", async () => (await imp("./data/a.yaml2")).default);
  await t("txt2", async () => (await imp("./data/a.txt2")).default);
  await t("json2", async () => (await imp("./data/a.json2")).default);
  await t("obj", async () => {
    const o = await imp("./data/a.obj");
    return [o.x, o.default, keys(o)];
  });
  await t("tsx2", async () => (await imp("./data/a.tsx2")).default);
  await t("fall", async () => imp("./data/a.fall"));
  await t("redirect", async () => (await imp("./data/real.ts")).default);
  await t("chain", async () => (await imp("chain:link")).path);
  await t("async onResolve", async () => (await imp("later:on")).path);
  await t("bad path", async () => imp("bad:x"));
  await t("no onLoad", async () => imp("noload:x"));
  await t("nested", async () => (await imp("nested:x")).default);
  await t("no exports", async () => imp("noobj:x"));
  await t("module object", async () => {
    const m = await imp("my-virtual");
    return [m.a, m.b, m.default, keys(m)];
  });
  await t("module source", async () => {
    const m = await imp("my-src");
    return [m.fromSrc, m.x];
  });
  await t("module async", async () => (await imp("my-async")).late);
  await t("static imports", async () => (await import("./plugin-static.ts")).default);

  await t("require module", () => req("my-virtual"));
  await t("require obj", () => req("./data/a.obj"));
  await t("require virtual", () => req("virtual:req"));
  await t("require async onLoad", () => req("./data/a.yaml2"));
  await t("require redirect", () => req("./data/real.ts"));
  await t("require chain", () => req("chain:r"));

  const late = Bun.plugin({
    name: "async setup",
    async setup(build) {
      await Bun.sleep(1);
      build.module("late-module", () => ({ exports: { ok: true }, loader: "object" }));
    },
  });
  log(`async setup returns: ${late instanceof Promise} ${await late}`);
  await t("late module", async () => (await imp("late-module")).ok);

  await t("no setup", () => Bun.plugin({} as never));
  await t("not an object", () => Bun.plugin(5 as never));
  await t("bad filter", () => Bun.plugin({ name: "x", setup: (b) => void b.onLoad({ filter: "x" } as never, () => ({ contents: "" })) }));
  await t("bad resolve filter", () => Bun.plugin({ name: "x", setup: (b) => void b.onResolve({ filter: "x" } as never, () => undefined) }));
  await t("bad callback", () => Bun.plugin({ name: "x", setup: (b) => void b.onLoad({ filter: /x/ }, 5 as never) }));
  await t("bad module", () => Bun.plugin({ name: "x", setup: (b) => void b.module("x", 5 as never) }));
  await t("setup throws", () => Bun.plugin({ name: "x", setup: () => { throw new Error("boom"); } }));
  await t("onStart", () => {
    let type = "";
    Bun.plugin({ name: "x", setup: (b) => void (type = typeof (b as unknown as { onStart?: unknown }).onStart) });
    return type;
  });

  await t("clearAll", () => [typeof Bun.plugin.clearAll, Bun.plugin.clearAll()]);
  await t("after clearAll", async () => imp("virtual:after"));
  await t("loaded stays", async () => (await imp("virtual:hello")).name);
}
