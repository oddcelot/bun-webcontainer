import { describe, test } from "node:test";
import assert from "node:assert";

test("passes", () => {
  assert.ok(true);
});
test("fails", () => {
  assert.strictEqual(1, 2);
});
test("skipped", { skip: "why" }, () => {});
test("todo", { todo: true }, () => {});
test.skip("skip2", () => {});
test.todo("todo2");
describe("suite", () => {
  test("inner", () => {});
  describe("deeper", () => {
    test("deepest", () => {});
  });
});
describe.skip("skipped suite", () => {
  test("never", () => {});
});
test("with sub", async (t) => {
  await t.test("sub ok", () => {});
  await t.test("sub skip", { skip: true }, () => {});
});
test("failing sub", async (t) => {
  await t.test("sub fails", () => {
    throw new TypeError("bad sub");
  });
});
test("skips itself", (t) => {
  t.skip("not today");
});
console.log("hello from a");
