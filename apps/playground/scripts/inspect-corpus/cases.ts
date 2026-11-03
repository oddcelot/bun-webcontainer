// Values for the console/inspect corpus (scripts/inspect-corpus/diff.ts). Each case is the argument list of one
// console.log call; Bun.inspect and util.inspect get its first argument. Self-contained so the same file runs in
// the playground. Errors get a fixed `stack` so their frames read the same everywhere.

const withStack = <E extends Error>(e: E, frames = ["fn (file.js:1:2)"]): E => {
  e.stack = `${e.name}: ${e.message}\n` + frames.map((f) => `    at ${f}`).join("\n");
  return e;
};

class Foo {
  x = 1;
  get g() {
    return 2;
  }
  m() {}
}
class Bar extends Foo {
  y = "s";
}
class Empty {}
const handled = <T>(p: Promise<T>) => (p.catch(() => {}), p);

class MyErr extends Error {
  override name = "MyErr";
}

export const cases: [name: string, args: () => unknown[]][] = [
  ["primitives", () => [[undefined, null, NaN, -0, 0, 1.5, 1e21, 1e-7, 2 ** 53, Infinity, -Infinity, 10n, true, false]]],
  ["string top", () => ["plain string"]],
  ["strings nested", () => [["a\tb", "q'\"", "\u0001", "é😀", "\\", "", "\b\f\v\0 "]]],
  ["object", () => [{ a: 1, b: [1, 2] }]],
  ["nested depth", () => [{ a: 1, b: { c: { d: { e: 1 } } } }]],
  ["deep 10", () => [{ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } }]],
  ["array mixed", () => [[1, "a", { x: "y" }]]],
  ["array 10", () => [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]],
  ["array 11", () => [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]],
  ["array 30 wide", () => [Array.from({ length: 30 }, (_, i) => i * 1000)]],
  ["array 150", () => [Array.from({ length: 150 }, (_, i) => i)]],
  ["array strings", () => [Array.from({ length: 12 }, (_, i) => "item" + i)]],
  ["array long strings", () => [["a".repeat(30), "b".repeat(41), "c".repeat(20)]]],
  ["array of objects", () => [[{ a: 1 }, { b: 2 }]]],
  ["nested arrays", () => [[[1, 2], [3, [4, [5, [6]]]]]]],
  ["sparse", () => [[1, , , 4, ,]]],
  ["sparse start", () => [[, , 3]]],
  ["array props", () => [Object.assign([1, 2], { k: "v" })]],
  ["empty things", () => [[{}, [], new Map(), new Set(), ""]]],
  ["map", () => [new Map([["a", 1]])]],
  ["map nested", () => [new Map<unknown, unknown>([[{ k: 1 }, [1, 2]], ["s", new Map([[1, 1]])]])]],
  ["set", () => [new Set([1, "x"])]],
  ["set nested", () => [new Set([[1], { a: 1 }])]],
  ["set 12", () => [new Set(Array.from({ length: 12 }, (_, i) => i))]],
  ["weak", () => [[new WeakMap(), new WeakSet()]]],
  ["map iterator", () => [new Map([[1, 2]]).entries()]],
  ["set iterator", () => [new Set([1]).values()]],
  ["functions", () => [function f() {}, () => {}, async function g() {}, function* gen() {}, async function* ag() {}, async () => {}]],
  ["function props", () => [Object.assign(function f() {}, { a: 1 })]],
  ["bound", () => [function q() {}.bind(null)]],
  ["classes", () => [class X {}, class Y extends Foo {}, class {}, class extends Foo {}]],
  ["builtin ctors", () => [[Array, Map, Error, Object, Function, Promise]]],
  ["methods", () => [{ f() {}, g: () => 1, h: async () => {} }]],
  ["circular", () => [(() => {
    const c: Record<string, unknown> = { name: "c" };
    c.self = c;
    return c;
  })()]],
  ["circular array", () => [(() => {
    const a: unknown[] = [1];
    a.push(a);
    return a;
  })()]],
  ["circular map", () => [(() => {
    const m = new Map<string, unknown>();
    m.set("m", m);
    return m;
  })()]],
  ["symbols", () => [Symbol("s"), Symbol(), Symbol.iterator, Symbol.for("x")]],
  ["symbol keys", () => [{ [Symbol("k")]: 1, a: 2 }]],
  ["dates", () => [new Date(0), new Date(NaN)]],
  ["date nested", () => [{ d: new Date(0) }]],
  ["regexp", () => [/a\/b/gi, { r: /x/ }]],
  ["typed arrays", () => [new Uint8Array([1, 2, 3]), new Float64Array(2), new Float32Array([1.5, 0.1]), new BigInt64Array([1n, -2n])]],
  ["typed empty", () => [new Uint8Array(0)]],
  ["typed big", () => [new Uint8Array(600)]],
  ["arraybuffer", () => [new ArrayBuffer(4), new DataView(new ArrayBuffer(2))]],
  ["promise pending", () => [new Promise(() => {})]],
  ["promise resolved", () => [Promise.resolve(1)]],
  ["promise rejected", () => [handled(Promise.reject(2))]],
  ["promise executor", () => [new Promise((r) => r({ a: 1 })), new Promise((_, r) => r(3)).catch(() => {}), new Promise((r) => r(Promise.resolve(1)))]],
  ["promise nested", () => [{ p: Promise.resolve("s"), q: handled(new Promise((_, r) => r("no"))) }]],
  ["promise thenable", () => [new Promise((r) => r({ then() {} }))]],
  ["getters", () => [{ get g() { return 1; }, set s(_v: unknown) {}, get gs() { return 1; }, set gs(_v: unknown) {} }]],
  ["class instance", () => [new Foo()]],
  ["subclass instance", () => [new Bar()]],
  ["empty instance", () => [new Empty()]],
  ["instance in depth", () => [{ a: { b: { c: new Foo() } } }]],
  ["collections in depth", () => [{ a: { b: { c: new Set([1]), d: [1], e: [], f: {}, g: new Map(), h: new Map([[1, 1]]) } } }]],
  ["null prototype", () => [Object.assign(Object.create(null), { a: 1 }), Object.create(null)]],
  ["toStringTag", () => [{ [Symbol.toStringTag]: "T", a: 1 }]],
  ["non-enumerable", () => [Object.defineProperty({ a: 1 }, "h", { value: 2, enumerable: false })]],
  ["keys quoting", () => [{ "a-b": 1, "1": 2, valid_$: 3, "with space": 4, "": 5, é: 6 }]],
  ["many keys", () => [Object.fromEntries(Array.from({ length: 12 }, (_, i) => ["k" + i, i]))]],
  ["long values", () => [{ a: "x".repeat(50), b: "y".repeat(50) }]],
  ["object with arrays", () => [{ list: [1, 2, 3], nested: [[1], [2]] }]],
  ["boxed", () => [new Number(1), new String("s"), new Boolean(true)]],
  ["boxed nested", () => [[new Number(1), new String("s"), new Boolean(false)]]],
  ["custom inspect", () => [{ [Symbol.for("nodejs.util.inspect.custom")]() { return "CUSTOM"; } }]],
  ["custom inspect object", () => [{ [Symbol.for("nodejs.util.inspect.custom")]() { return { replaced: true }; } }]],
  ["toJSON", () => [{ toJSON() { return { z: 1 }; } }]],
  ["arguments", () => [(function (..._a: unknown[]) { return arguments; })(1, 2)]],
  ["multiple values", () => ["a", 1, { x: 1 }, [1], "b"]],
  ["format string", () => ["%s and %d and %o and %j %i %f %%", "str", 4.5, { a: [1] }, { j: 1 }, "12.7px", "1.5", "extra", { z: 1 }]],
  ["format %s object", () => ["%s", { a: 1 }, [1, 2], 3]],
  ["format %O", () => ["%O", { a: { b: { c: { d: 1 } } } }]],
  ["format quirks", () => ["%%%s|%c|%x", 1, 2]],
  ["format numbers", () => ["%i %d %f", 1e21, -1.5e-7, "abc"]],
  ["format second string", () => ["a", "%s", "b"]],
  ["error", () => [withStack(new Error("boom"))]],
  ["error name", () => [withStack(new TypeError("t")), withStack(new MyErr("named"))]],
  ["error in object", () => [{ err: withStack(new RangeError("r")) }]],
  ["error props", () => [Object.assign(withStack(new Error("with props")), { code: "E_X", n: 1, extra: { a: { b: 1 } } })]],
  ["error code prefix", () => [Object.assign(withStack(new Error("ERR_A: msg")), { code: "ERR_A" })]],
  ["error cause", () => [withStack(new Error("outer", { cause: withStack(new Error("inner"), ["inner (x.js:2:3)"]) }))]],
  ["error string cause", () => [withStack(new Error("c", { cause: "str" }))]],
  ["error empty message", () => [withStack(new Error(""))]],
  ["error then value", () => [withStack(new Error("first")), "after"]],
  ["error frames", () => [withStack(new Error("frames"), ["a (file.js:1:2)", "new Foo (lib/p.ts:3:4)", "Object.<anonymous> (a.js:1:1)"])]],
];
