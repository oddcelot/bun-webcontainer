// pruneNodeModules (src/lockfile.ts): what `bun install` removes from node_modules once bun.lock no longer places it.
import { pruneNodeModules } from "../src/lockfile";

const files = new Set([
  "node_modules/kept/package.json",
  "node_modules/kept/node_modules/nested-kept/index.js",
  "node_modules/kept/node_modules/nested-gone/index.js",
  "node_modules/gone/package.json",
  "node_modules/gone/node_modules/below-gone/index.js",
  "node_modules/@s/kept/package.json",
  "node_modules/@s/gone/package.json",
  "node_modules/.bin/kept",
  "node_modules/.vite/deps/x.js",
  "node_modules/kept/node_modules/.cache/x",
  "src/index.ts",
]);
const vfs = {
  list: (prefix: string) => [...files].filter((f) => f.startsWith(prefix + "/")),
  remove: (dir: string) => [...files].forEach((f) => f.startsWith(dir + "/") && files.delete(f)),
};
const keep = new Set(["node_modules/kept", "node_modules/kept/node_modules/nested-kept", "node_modules/@s/kept"]);
const removed = pruneNodeModules(vfs, keep).sort();
const expectRemoved = ["node_modules/@s/gone", "node_modules/gone", "node_modules/kept/node_modules/nested-gone"];
const expectLeft = [
  "node_modules/kept/package.json",
  "node_modules/kept/node_modules/nested-kept/index.js",
  "node_modules/@s/kept/package.json",
  "node_modules/.bin/kept",
  "node_modules/.vite/deps/x.js",
  "node_modules/kept/node_modules/.cache/x",
  "src/index.ts",
].sort();
const ok = JSON.stringify(removed) === JSON.stringify(expectRemoved) && JSON.stringify([...files].sort()) === JSON.stringify(expectLeft);
if (!ok) {
  console.error("removed:", removed, "\nleft:", [...files].sort());
  process.exit(1);
}
console.log(`install-prune: removed ${removed.length} stale packages, kept the rest`);
