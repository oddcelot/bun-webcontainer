// node:test failures as Bun reports them: a parent of failing subtests ("2 subtests failed", the first failure as its
// cause), and plans: one that waits for its assertions, one whose wait times out, one that doesn't wait.
import assert from "node:assert";
import { test } from "node:test";

test("parent of failing subtests", async (t) => {
  await t.test("child passes", () => {});
  await t.test("child fails", () => {
    assert.strictEqual(1, 2);
  });
  await t.test("child throws", () => {
    throw Object.assign(new TypeError("bad thing"), { code: "E_X" });
  });
});

test("plan waits for its assertions", (t) => {
  t.plan(2, { wait: true });
  setTimeout(() => t.assert.ok(true), 20);
  setTimeout(() => t.assert.ok(true), 40);
});

test("plan wait times out", (t) => {
  t.plan(2, { wait: 100 });
  setTimeout(() => t.assert.ok(true), 20);
});

test("plan without wait", (t) => {
  t.plan(1);
  setTimeout(() => t.assert.ok(true), 20);
});
