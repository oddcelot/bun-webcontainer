// What node:vm programs print, as one file both native Bun and the playground run (scripts/vm.ts compares the two;
// scripts/vm/impl.ts runs it on src/worker/node/vm.ts directly, under Bun).
type VM = typeof import("node:vm");

export function run(vm: VM, log: (line: string) => void) {
  const t = (label: string, f: () => unknown) => {
    try {
      const v = f();
      log(`${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    } catch (e) {
      const err = e as Error & { code?: string };
      log(`${label}: threw ${err.name} ${err.message}${err.code ? " " + err.code : ""}`);
    }
  };
  const keys = (o: object) => Object.keys(o).join();

  t("exports", () => ["Script", "compileFunction", "constants", "createContext", "createScript", "isContext", "measureMemory", "runInContext", "runInNewContext", "runInThisContext"].filter((k) => k in vm).length);
  t("runInThisContext", () => vm.runInThisContext("1 + 2"));
  t("this var leak", () => {
    vm.runInThisContext("var leaked = 7; globalThis.g2 = 8; let lx = 1; function ff() { return 9 }");
    const g = globalThis as Record<string, unknown>;
    return [typeof g.leaked, g.g2, typeof g.lx, typeof g.ff].join();
  });
  t("this sees globalThis", () => vm.runInThisContext("typeof globalThis.leaked + typeof Array"));
  t("script runInThisContext", () => new vm.Script("leaked * 2").runInThisContext());
  t("new context sandbox", () => vm.runInNewContext("a + b * f(2)", { a: 1, b: 2, f: (x: number) => x * 10 }));
  t("sandbox mutated", () => {
    const sb: Record<string, unknown> = { n: 1 };
    vm.runInNewContext("n += 1; m = n * 10; globalThis.k = 3; this.j = 4", sb);
    return sb;
  });
  t("var and function land on context", () => {
    const c = vm.createContext({}) as Record<string, () => number>;
    vm.runInContext("var a = 1; function f() { return 2 } let l = 3; const k = 4; class C {} b = 5", c);
    return [keys(c), c.f(), "l" in c, "C" in c].join("|");
  });
  t("var without a value", () => keys(vm.runInNewContext("var u; this", {})));
  t("nested decls", () => {
    const c = vm.createContext({});
    vm.runInContext("if (true) { var inIf = 1; } for (var i = 0; i < 2; i++) {} (function () { var hidden = 1; function inner() {} })(); const o = { f() { var nope = 1 } }; var s = 'var inStr', r = /var x/; // var inComment\n var t = `${1}var tpl`", c);
    return keys(c);
  });
  t("function call before decl", () => vm.runInNewContext("f(); var x = typeof f; function f() { r = 'called' } x + r", {}));
  t("persist across runs", () => {
    const c = vm.createContext({}) as Record<string, unknown>;
    vm.runInContext("var count = 1; function inc() { return ++count }", c);
    return [vm.runInContext("inc(); inc()", c), "count" in c, vm.runInContext("count", c)].join();
  });
  t("script reuse", () => {
    const s = new vm.Script("n = (typeof n === 'number' ? n : 0) + 1");
    const c = vm.createContext({}) as Record<string, unknown>;
    s.runInContext(c);
    s.runInContext(c);
    return [c.n, s.runInNewContext({ n: 10 })].join();
  });
  t("missing global", () => vm.runInNewContext("missing"));
  t("typeof missing", () => vm.runInNewContext("typeof missing"));
  t("typeof (missing)", () => vm.runInNewContext("typeof (missing)"));
  t("worker globals hidden", () => vm.runInNewContext("[typeof process, typeof Bun, typeof setTimeout, typeof fetch, typeof URL, typeof require, typeof global, typeof module].join()"));
  t("this top level", () => {
    const c = vm.createContext({ a: 1 });
    const th = vm.runInContext("this", c);
    return [th === c, th.a, keys(th), vm.runInContext("this === globalThis", c)].join();
  });
  t("this.property", () => vm.runInNewContext("this.x = 1; x + this.y", { y: 2 }));
  t("typeof std", () => vm.runInNewContext("[typeof Array, typeof JSON, typeof Math, typeof Object, typeof Promise, typeof Symbol, typeof Map, typeof Date, typeof RegExp, typeof Uint8Array, typeof parseInt, typeof undefined, typeof NaN, typeof eval, typeof globalThis, typeof console].join()"));
  t("std work", () => vm.runInNewContext("JSON.stringify({ a: [1, 2].map((x) => x * Math.max(1, 2)) }) + new Date(0).getTime() + parseInt('7') + [3, 1, 2].sort()"));
  t("eval inside", () => vm.runInNewContext("eval('1 + a')", { a: 41 }));
  t("sandbox shadows std", () => vm.runInNewContext("typeof JSON + typeof Math", { JSON: 1, Math: "x" }));
  t("delete", () => {
    const c = vm.createContext({ a: 1 });
    return [vm.runInContext("delete a", c), keys(c)].join();
  });
  t("getter", () =>
    vm.runInNewContext("g", {
      get g() {
        return 5;
      },
    }));
  t("in", () => vm.runInNewContext("'a' in this && !('zz' in this)", { a: 1 }));
  t("closure sees later changes", () => {
    const c = vm.createContext({ v: 1 }) as Record<string, unknown>;
    const f = vm.runInContext("(function () { return v })", c);
    c.v = 2;
    return f();
  });
  t("isContext", () => [vm.isContext({}), vm.isContext(vm.createContext({})), vm.isContext(vm.createContext())].join());
  t("isContext bad", () => vm.isContext(1 as never));
  t("createContext returns the object", () => {
    const o = {};
    return vm.createContext(o) === o;
  });
  t("runInContext bad", () => vm.runInContext("1", {}).toString().length);
  t("compileFunction", () => {
    const f = vm.compileFunction("return a + b + c", ["a", "b"], { contextExtensions: [{ c: 10 }] });
    return [f(1, 2), f.name === "", f.length, String(f)].join("|");
  });
  t("compileFunction global", () => vm.compileFunction("return typeof Array + typeof JSON", [])());
  t("compileFunction parsingContext", () => {
    const c = vm.createContext({ x: 5 });
    return vm.compileFunction("return x + (typeof process)", [], { parsingContext: c })();
  });
  t("compileFunction syntax", () => vm.compileFunction("return (", []));
  t("SyntaxError", () => new vm.Script("foo bar"));
  t("SyntaxError stack filename", () => {
    try {
      new vm.Script("foo bar", { filename: "my.js" });
    } catch (e) {
      return (e as Error).stack!.split("\n")[0].includes("my.js");
    }
  });
  t("SyntaxError default filename", () => {
    try {
      vm.runInNewContext("foo bar");
    } catch (e) {
      return (e as Error).stack!.includes("evalmachine.<anonymous>");
    }
  });
  t("error stack filename", () => {
    try {
      vm.runInNewContext("\n\nnull.x", {}, { filename: "rt.js" });
    } catch (e) {
      const m = /rt\.js:(\d+)/.exec((e as Error).stack!);
      return [(e as Error).name, m?.[1]].join();
    }
  });
  t("error from this context stack", () => {
    try {
      vm.runInThisContext("\nthrow new RangeError('x')", { filename: "tc.js" });
    } catch (e) {
      return [(e as Error).name, /tc\.js:2/.test((e as Error).stack!)].join();
    }
  });
  t("thrown by sandbox code", () => vm.runInNewContext("throw 5"));
  t("createCachedData", () => Buffer.isBuffer(new vm.Script("1").createCachedData()));
  t("constants", () => [keys(vm.constants), typeof vm.constants.DONT_CONTEXTIFY].join());
  t("timeout accepted", () => vm.runInNewContext("1", {}, { timeout: 1000 }));
  t("string options", () => vm.runInNewContext("1", {}, "f.js"));
  t("measureMemory", () => vm.measureMemory() instanceof Promise);
  t("instanceof cross realm", () => [vm.runInNewContext("[]") instanceof Array, vm.runInNewContext("[] instanceof Array"), vm.runInNewContext("a instanceof Array", { a: [] })].join());
  t("Script methods", () => ["runInThisContext", "runInContext", "runInNewContext", "createCachedData"].every((m) => typeof (vm.Script.prototype as never)[m] === "function"));
}
