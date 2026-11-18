// A folder whose bunfig.toml turns coverage on: bun test spawned there counts, with no --coverage flag.
import { expect, test } from "bun:test";
import { inc } from "./lib.ts";

test("inc", () => {
  expect(inc(1)).toBe(2);
});
