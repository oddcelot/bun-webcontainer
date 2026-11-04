import type { VFS } from "@runbun/vfs";

// Project files of each fixture (top level and src/), bundled as text. Their node_modules are never
// included; "bun install" fetches packages from the lockfile.
const files = import.meta.glob<string>("../fixtures/*/{package.json,tsconfig.json,bun.lock,*.ts,*.tsx,*.js,*.mjs,*.html,*.css,src/**/*}", {
  query: "?raw",
  import: "default",
});

export const examples: Record<string, string> = {
  "elysia-demo": "Elysia",
  "elysia2-demo": "Elysia 2 (rc)",
  "node-demo": "node:* built-ins",
  "lockfile-demo": "bun.lock + nested node_modules",
  "vite-demo": "Vite (probe)",
  "astro-solid-demo": "Astro + Solid",
};

/** Public GitHub repos in the picker, loaded with `?repo=` (see github.ts). */
export const repoExamples: Record<string, string> = {
  "oddcelot/bun-elysia-demo": "Elysia (from GitHub)",
  "https://github.com/oddcelot/lit-devtools/tree/main/examples/elysia": "Lit SSR guestbook (from GitHub)",
  "https://github.com/honojs/starter/tree/main/templates/bun": "Hono (from GitHub)",
};

/** The files of `fixtures/<name>/` (`demo` included) by path, without touching the VFS; null if there is no such example. */
export async function exampleFiles(name: string): Promise<Map<string, string> | null> {
  const prefix = `../fixtures/${name}/`;
  const entries = Object.entries(files).filter(([path]) => path.startsWith(prefix));
  if (!entries.length) return null;
  return new Map(await Promise.all(entries.map(async ([path, load]) => [path.slice(prefix.length), await load()] as const)));
}

/** Loads `fixtures/<name>/` into the VFS; false if there is no such example. */
export async function loadExample(vfs: VFS, name: string): Promise<boolean> {
  const loaded = await exampleFiles(name);
  if (!loaded) return false;
  vfs.clear();
  for (const [path, text] of loaded) vfs.write(path, text);
  return true;
}
