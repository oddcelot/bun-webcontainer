// node:test under `bun test`: tests, suites, hooks, subtests, skip/todo and the mock tracker. Every test checks what
// it saw with node:assert, so a difference from native Bun shows as a failure (or as other pass/skip/todo counts).
import nodeTest, { after, afterEach, before, beforeEach, describe, getTestContext, it, mock, skip, suite, test, todo } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const log: string[] = [];
before(() => void log.push("before"));
beforeEach((t) => void log.push(`beforeEach ${t.name}`));
afterEach((t) => void log.push(`afterEach ${t.name}`));
after(() => assert.ok(log.length > 0));

test("the module", () => {
  assert.strictEqual(nodeTest, test);
  assert.strictEqual(createRequire(import.meta.url)("node:test"), nodeTest);
  assert.deepStrictEqual(Object.keys(nodeTest).sort(), ["after", "afterEach", "assert", "before", "beforeEach", "describe", "getTestContext", "it", "mock", "only", "run", "skip", "snapshot", "suite", "test", "todo"]);
  assert.strictEqual(typeof test.skip, "function");
  assert.strictEqual(typeof describe.todo, "function");
});

test("hooks ran around it", () => {
  assert.deepStrictEqual(log, ["before", "beforeEach the module", "afterEach the module", "beforeEach hooks ran around it"]);
});

test("async", async () => {
  await new Promise((r) => setTimeout(r, 1));
});

test("done callback", (_t, done) => {
  setTimeout(done, 1);
});

test("context", (t) => {
  assert.strictEqual(t.name, "context");
  assert.strictEqual(t.fullName, "context");
  assert.strictEqual(t.signal.aborted, false);
  assert.strictEqual(typeof t.filePath, "string");
  assert.strictEqual(getTestContext(), t);
  assert.strictEqual(typeof t.diagnostic, "function");
});

test("subtests", async (t) => {
  const seen: string[] = [];
  t.beforeEach((c) => void seen.push(`each ${c.name}`));
  const r = await t.test("one", (c) => {
    seen.push(c.fullName);
  });
  assert.strictEqual(r, undefined);
  await t.test("two", async (c) => {
    await c.test("deep", (d) => void seen.push(d.fullName));
  });
  await t.test("skipped", { skip: true }, () => {
    throw new Error("never runs");
  });
  t.test("not awaited", () => void seen.push("late"));
  assert.deepStrictEqual(seen, ["each one", "subtests > one", "each two", "each deep", "subtests > two > deep"]);
  assert.ok(log.includes("beforeEach one"), "the file's beforeEach runs for subtests too");
});

test("subtest after the parent returned", (t) => {
  let ran = false;
  t.after(() => assert.ok(ran));
  t.test("child", () => void (ran = true));
});

test("skipped by option", { skip: true }, () => {
  throw new Error("never runs");
});
test("skipped with a reason", { skip: "not here" }, () => {});
test("todo by option", { todo: true }, () => {});
test.skip("test.skip", () => {});
test.todo("test.todo");
skip("skip()", () => {});
todo("todo()", () => {});
test("t.skip()", (t) => {
  t.skip("at run time");
});
test("t.todo()", (t) => {
  t.todo("later");
});
test("only runs like any other", { only: true }, () => {});

describe("a suite", () => {
  const order: string[] = [];
  beforeEach(() => void order.push("suite beforeEach"));
  it("nested it", (t) => {
    assert.strictEqual(t.fullName, "a suite > nested it");
    order.push("it");
  });
  describe("inner", () => {
    it("deep", (t) => {
      assert.strictEqual(t.fullName, "a suite > inner > deep");
      assert.deepStrictEqual(order, ["suite beforeEach", "it", "suite beforeEach"]);
    });
  });
  describe.skip("skipped suite", () => {
    it("in a skipped suite", () => {
      throw new Error("never runs");
    });
  });
});

suite("suite() is describe()", (s) => {
  it("in it", () => assert.strictEqual(s.name, "suite() is describe()"));
});

test("mock.fn", () => {
  const fn = mock.fn((a: number, b: number) => a + b);
  assert.strictEqual(fn(1, 2), 3);
  fn(3, 4);
  assert.strictEqual(fn.mock.callCount(), 2);
  assert.deepStrictEqual(fn.mock.calls[0].arguments, [1, 2]);
  assert.strictEqual(fn.mock.calls[1].result, 7);
  assert.deepStrictEqual(Object.keys(fn.mock.calls[0]), ["arguments", "error", "result", "stack", "target", "this"]);
  fn.mock.mockImplementation(() => 0);
  assert.strictEqual(fn(1, 1), 0);
  fn.mock.mockImplementationOnce(() => 99);
  assert.strictEqual(fn(1, 1), 99);
  assert.strictEqual(fn(1, 1), 0);
  fn.mock.resetCalls();
  assert.strictEqual(fn.mock.callCount(), 0);
  const thrower = mock.fn(() => {
    throw new Error("x");
  });
  assert.throws(() => thrower());
  assert.strictEqual((thrower.mock.calls[0].error as Error).message, "x");
  const times = mock.fn(() => 1, () => 2, { times: 1 });
  assert.deepStrictEqual([times(), times()], [2, 1]);
});

test("t.mock.method, getter, restored after the test", (t) => {
  const obj = {
    greet: (n: string) => `hi ${n}`,
    get size() {
      return 1;
    },
  };
  const m = t.mock.method(obj, "greet", (n: string) => `yo ${n}`);
  assert.strictEqual(obj.greet("a"), "yo a");
  assert.strictEqual(m.mock.callCount(), 1);
  m.mock.restore();
  assert.strictEqual(obj.greet("a"), "hi a");
  t.mock.getter(obj, "size", () => 5);
  assert.strictEqual(obj.size, 5);
  globalThis.__nodeTestObj = obj;
  t.mock.method(Math, "random", () => 0.5);
  assert.strictEqual(Math.random(), 0.5);
});

test("t.mock is reset after its test", () => {
  assert.notStrictEqual(Math.random(), 0.5);
  assert.strictEqual((globalThis.__nodeTestObj as { size: number }).size, 1);
});

test("mock.timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hit = 0;
  setTimeout(() => hit++, 100);
  t.mock.timers.tick(99);
  assert.strictEqual(hit, 0);
  t.mock.timers.tick(1);
  assert.strictEqual(hit, 1);
});

test("plan and t.assert", (t) => {
  t.plan(2);
  t.assert.ok(true);
  t.assert.strictEqual(1, 1);
});

declare global {
  var __nodeTestObj: unknown;
}
