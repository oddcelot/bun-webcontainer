import { test, expect, describe } from "bun:test";

expect.extend({
  toBeWithin(received: number, lo: number, hi: number) {
    return { pass: received >= lo && received <= hi, message: () => `expected ${received} ${this.isNot ? "not " : ""}to be within ${lo}..${hi}` };
  },
  toEqualBoth(received: unknown, other: unknown) {
    return { pass: this.equals(received, other), message: () => "values differ" };
  },
  toBeFmt(received: unknown) {
    return { pass: false, message: () => `got ${this.utils.stringify?.(received) ?? "?"} / ${typeof this.utils.printReceived} ${typeof this.utils.matcherHint}` };
  },
});

test("custom pass", () => {
  (expect(5) as any).toBeWithin(1, 10);
  (expect(50) as any).not.toBeWithin(1, 10);
});
test("custom fail", () => {
  (expect(50) as any).toBeWithin(1, 10);
});
test("custom not fail", () => {
  (expect(5) as any).not.toBeWithin(1, 10);
});
test("this.equals", () => {
  (expect({ a: 1 }) as any).toEqualBoth({ a: 1 });
  (expect({ a: 1 }) as any).toEqualBoth({ a: 2 });
});
test("utils", () => {
  (expect({ a: 1 }) as any).toBeFmt();
});
test("unknown matcher", () => {
  (expect(1) as any).toBeNope();
});
test("extend on resolves", async () => {
  await (expect(Promise.resolve(5)) as any).resolves.toBeWithin(1, 10);
});
test("assertions ok", () => {
  expect.assertions(2);
  expect(1).toBe(1);
  expect(2).toBe(2);
});
test("assertions bad", () => {
  expect.assertions(2);
  expect(1).toBe(1);
});
test("hasAssertions ok", () => {
  expect.hasAssertions();
  expect(1).toBe(1);
});
test("hasAssertions bad", () => {
  expect.hasAssertions();
});
test("assertions async", async () => {
  expect.assertions(1);
  await Promise.resolve();
  expect(1).toBe(1);
});
test("a test after the failed ones", () => {
  expect(1).toBe(1);
});
describe("failing and concurrent", () => {
  test.failing("failing throws", () => {
    expect(1).toBe(2);
  });
  test.failing("failing passes", () => {
    expect(1).toBe(1);
  });
  test.failing("failing async", async () => {
    await Promise.resolve();
    throw new Error("x");
  });
  test.concurrent("conc 1", async () => {
    await Bun.sleep(5);
    expect(1).toBe(1);
  });
  test.concurrent("conc 2", async () => {
    await Bun.sleep(5);
    expect(1).toBe(2);
  });
  test.concurrent.each([[1], [2]])("conc each %d", (n) => {
    expect(n).toBeGreaterThan(0);
  });
  test.failing.each([[1]])("failing each %d", (n) => {
    expect(n).toBe(2);
  });
  test.serial("serial", () => {});
});
