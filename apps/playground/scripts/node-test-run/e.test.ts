// bun:test for a spawned `bun test`'s flags (main.ts): -t, --timeout, --bail, --todo, --only, --coverage.
import { describe, expect, test } from "bun:test";
import { half, twice } from "./lib.ts";

describe("math", () => {
  test("twice", () => {
    expect(twice(2)).toBe(4);
  });
  test("half fails", () => {
    expect(half(2)).toBe(2);
  });
});
test("slow", async () => {
  await Bun.sleep(200);
});
test("plain", () => {});
test.todo("todo passes", () => {
  expect(1).toBe(1);
});
test.todo("todo fails", () => {
  expect(1).toBe(2);
});
test.todo("todo without body");
test.skip("skipped", () => {});
