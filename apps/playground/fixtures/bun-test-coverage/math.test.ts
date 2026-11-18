import { expect, test } from "bun:test";
import { add, branchy, Calc, defaults, gen, later, logic, loops, mul, outer, sw, tc } from "./math";
import { obj, once } from "./util.js";
import { helper } from "./ignored/helper";
const lib = require("./lib.cjs");

test("math", async () => {
  expect(add(1, 2)).toBe(3);
  expect(mul(2, 3)).toBe(6);
  expect(new Calc().inc().value).toBe(1);
  expect(branchy(1)).toBe("pos");
  expect(branchy(0)).toBe("zero");
  expect(loops(5)).toBeGreaterThan(0);
  expect(sw("b")).toBe(2);
  expect(tc(() => {})).toBe("ok");
  expect(logic(0, { foo: 1 })).toHaveLength(4);
  expect(defaults()).toBe(3);
  expect(await later(2)).toBe(2);
  gen();
  outer();
});

test("util", () => {
  expect(once()).toBe(2);
  expect(obj.method()).toBe(2);
  expect(helper(1)).toBe(2);
  expect(lib.used(1)).toBe(2);
});

function unusedHelper() {
  return 1;
}
