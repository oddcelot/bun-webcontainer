// @types/bun (the release BUN_VERSION names) and what it depends on, as checker files under /node_modules: the
// globals Bun provides (Bun.*, node:*, HTML imports) type-check even when the project hasn't installed them.
const modules = import.meta.glob<string>(
  [
    "../../node_modules/{@types/bun,bun-types,@types/node,undici-types}/package.json",
    "../../node_modules/@types/bun/*.d.ts",
    "../../node_modules/{bun-types,@types/node,undici-types}/**/*.d.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

export const bunTypes: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, text]) => [path.replace(/^(?:\.\.\/)+/, "/"), text]),
);
