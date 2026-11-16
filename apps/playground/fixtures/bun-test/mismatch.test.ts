import { expect, test } from "bun:test";

test("object differs", () => {
  expect({ v: 3, w: [1] }).toMatchSnapshot();
});
test("array of many lines differs", () => {
  expect({ a: 1, b: [1, 2, 3, 4, 5, 6, 7, 8], c: "x" }).toMatchSnapshot();
});
test("string differs", () => {
  expect("hello").toMatchSnapshot("s");
});
test("new one among them", () => {
  expect("new").toMatchSnapshot();
});
test("same as stored", () => {
  expect([1, 2, 3]).toMatchSnapshot();
});
test("inline differs", () => {
  expect({ a: 2 }).toMatchInlineSnapshot(`
{
  "a": 1,
}
`);
});
test("inline string differs", () => {
  expect("y").toMatchInlineSnapshot(`"x"`);
});
test("toEqual diff", () => {
  expect({ a: 1, b: [1, 2, 3, 4, 5, 6, 7, 8], c: "x" }).toEqual({ a: 1, b: [1, 2, 3, 4, 5, 6, 7, 9], c: "y" });
});
