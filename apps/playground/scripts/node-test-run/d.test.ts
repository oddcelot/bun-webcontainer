import { expect, test } from "bun:test";

// bun:test's own tests: a run() child reports none of them, only the file.
test("bun test", () => {
  expect(1).toBe(1);
});
