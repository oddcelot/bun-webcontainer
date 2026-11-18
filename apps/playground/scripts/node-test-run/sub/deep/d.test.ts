import { expect, test } from "bun:test";
import { inc } from "../lib.ts";

test("deep", () => {
  expect(inc(2)).toBe(3);
});
