// bunfig.toml's [test] preload: runs once before the test files; its plugin serves their imports, its hooks are global.
import { plugin } from "bun";
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";

const counts = { beforeAll: 0, beforeEach: 0, afterEach: 0, afterAll: 0, loads: 0 };
(globalThis as { preloadCounts?: typeof counts }).preloadCounts = counts;
counts.loads++;
plugin({
  name: "preloaded",
  setup(build) {
    build.module("preloaded:greeting", () => ({ contents: "export default 'hello from a preloaded plugin'", loader: "js" }));
  },
});
beforeAll(() => void counts.beforeAll++);
beforeEach(() => void counts.beforeEach++);
afterEach(() => void counts.afterEach++);
afterAll(() => void counts.afterAll++);
