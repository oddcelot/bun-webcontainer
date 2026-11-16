import { describe, expect, test } from "bun:test";

test("primitives", () => {
  expect("abc").toMatchSnapshot();
  expect(42).toMatchSnapshot();
  expect("").toMatchSnapshot();
  expect(-0).toMatchSnapshot();
  expect(NaN).toMatchSnapshot();
  expect(Infinity).toMatchSnapshot();
  expect(10n).toMatchSnapshot();
  expect(null).toMatchSnapshot();
  expect(undefined).toMatchSnapshot();
  expect(true).toMatchSnapshot();
  expect(Symbol("s")).toMatchSnapshot();
  expect("héllo ✓ 😀").toMatchSnapshot();
  expect("tab\t and \u0001 ctl and \\ backslash and `tick` and ${x}").toMatchSnapshot();
});

test("objects and arrays", () => {
  expect({ b: 1, a: 2, 3: "n", "key with space": 1, ok_id: 2, u: undefined, nul: null }).toMatchSnapshot();
  expect([[1, [2, [3]]], { x: [] }, {}]).toMatchSnapshot();
  expect([undefined, null, , 3]).toMatchSnapshot();
  expect({ nested: { deep: { deeper: { deepest: 1 } } } }).toMatchSnapshot();
  expect([1.5, "s", true]).toMatchSnapshot();
  const circular: any = { n: 1 };
  circular.self = circular;
  expect(circular).toMatchSnapshot();
  expect(Object.create(null)).toMatchSnapshot();
  expect({ [Symbol("k")]: 1 }).toMatchSnapshot();
});

test("rich values", () => {
  class Foo {
    x = 1;
  }
  expect(new Foo()).toMatchSnapshot();
  expect({ f: new Foo(), d: new Date(0), r: /re/gi, fn: () => {}, named: function named() {}, k: class K {} }).toMatchSnapshot();
  expect(new Date(0)).toMatchSnapshot();
  expect([new Date(0)]).toMatchSnapshot();
  expect(new Error("e1")).toMatchSnapshot();
  expect(new TypeError("e2")).toMatchSnapshot();
  expect(new Uint8Array([1, 2])).toMatchSnapshot();
  expect(new Map()).toMatchSnapshot();
  expect(new Set(["a", "b"])).toMatchSnapshot();
  expect(new Map([["a", { b: 1 }]])).toMatchSnapshot();
  expect({ h: new Map([[1, "x"]]), i: new Set([1]) }).toMatchSnapshot();
  expect(new Map([[{ a: 1 }, new Set([1])]])).toMatchSnapshot();
  expect(["a\nb"]).toMatchSnapshot();
  expect({ s: "multi\nline" }).toMatchSnapshot();
  expect("line1\nline2").toMatchSnapshot();
});

describe("naming", () => {
  describe("nested", () => {
    test("by describe and test", () => {
      expect([1, 2]).toMatchSnapshot("first");
      expect({ x: 1 }).toMatchSnapshot("second");
      expect([1, 2]).toMatchSnapshot();
      expect([3]).toMatchSnapshot();
      expect(1).toMatchSnapshot("h");
      expect(2).toMatchSnapshot("h");
    });
  });
  test.each([[1], [2]])("each %d", (n) => {
    expect(n).toMatchSnapshot();
  });
});

describe("property matchers", () => {
  test("replace what varies", () => {
    expect({ id: 5, name: "n", at: new Date(0), nested: { n: 1, keep: "k" } }).toMatchSnapshot({ id: expect.any(Number), at: expect.any(Date), nested: { n: expect.any(Number) } });
  });
  test("a value that doesn't fit them fails", () => {
    expect({ id: "x" }).toMatchSnapshot({ id: expect.any(Number) });
  });
});

describe("inline", () => {
  test("new snapshots are written into the call", () => {
    expect(5).toMatchInlineSnapshot();
    expect("str").toMatchInlineSnapshot();
    expect({ n: [1, 2], s: "x" }).toMatchInlineSnapshot();
    expect("multi\nline").toMatchInlineSnapshot();
    expect({ id: 1, d: "x" }).toMatchInlineSnapshot({ id: expect.any(Number) });
    expect([]).toMatchInlineSnapshot( );
  });
  test("existing ones compare, indented or not", () => {
    expect({ a: 1 }).toMatchInlineSnapshot(`
{
  "a": 1,
}
`);
    expect("x").toMatchInlineSnapshot(`"x"`);
    expect({ a: [1] }).toMatchInlineSnapshot(`
      {
        "a": [
          1,
        ],
      }
    `);
  });
});

test("not is refused", () => {
  expect({ a: 1 }).not.toMatchSnapshot();
});
