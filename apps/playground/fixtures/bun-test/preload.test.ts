// What bunfig.toml's [test] preload (preload.ts) did before this file loaded.
import { expect, test } from "bun:test";
import greeting from "preloaded:greeting";

const counts = (globalThis as { preloadCounts?: Record<string, number> }).preloadCounts!;

test("the preloaded plugin serves a static import", () => {
  expect(greeting).toBe("hello from a preloaded plugin");
});

test("the preload ran once, its hooks around every test", () => {
  expect(counts.loads).toBe(1);
  expect(counts.beforeAll).toBe(1);
  expect(counts.afterAll).toBe(0);
  // This test's beforeEach has run, its afterEach not yet.
  expect(counts.beforeEach).toBe(counts.afterEach + 1);
  expect(counts.beforeEach).toBeGreaterThanOrEqual(2);
});
