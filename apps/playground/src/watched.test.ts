// bun apps/playground/src/watched.test.ts
import assert from "node:assert/strict";
import { watchedBy } from "./watched.ts";

// A file is watched by itself, by its folder, or by a recursive watch on a folder above it.
for (const [key, recursive, path, want] of [
  ["src/a.ts", false, "src/a.ts", true],
  ["src", false, "src/a.ts", true],
  ["src", false, "src/ui/a.ts", false],
  ["src", true, "src/ui/a.ts", true],
  ["", true, "src/ui/a.ts", true],
  ["", false, "index.html", true],
  ["", false, "src/a.ts", false],
  // A folder's name is not a prefix of another's.
  ["src", true, "src2/a.ts", false],
] as const) {
  assert.equal(watchedBy([{ key, recursive }], [path]), want, `${key || "(root)"}${recursive ? " (recursive)" : ""} watches ${path}`);
}

// Every changed file must be watched, and no change is not a watched one.
const src = [{ key: "src", recursive: true }];
assert.equal(watchedBy(src, ["src/a.ts", "src/b.css"]), true);
assert.equal(watchedBy(src, ["src/a.ts", "public/b.css"]), false);
assert.equal(watchedBy(src, []), false);
assert.equal(watchedBy([], ["src/a.ts"]), false);

console.log("watched: ok");
