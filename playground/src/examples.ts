import type { VFS } from "./vfs";

// Top-level project files of each fixture, bundled as text. Their node_modules are never included;
// "bun install" fetches packages from the lockfile.
const files = import.meta.glob<string>("../fixtures/*/{package.json,bun.lock,*.ts,*.tsx,*.js,*.html,*.css}", {
  query: "?raw",
  import: "default",
});

export const examples: Record<string, string> = {
  "elysia-demo": "Elysia",
  "elysia2-demo": "Elysia 2 (rc)",
  "node-demo": "node:* built-ins",
  "lockfile-demo": "bun.lock + nested node_modules",
  "vite-demo": "Vite (probe)",
};

/** Public GitHub repos in the picker, loaded with `?repo=` (see github.ts). */
export const repoExamples: Record<string, string> = {
  "oddcelot/bun-elysia-demo": "Elysia (from GitHub)",
  "https://github.com/oddcelot/lit-devtools/tree/main/examples/elysia": "Lit SSR guestbook (from GitHub)",
};

/** Loads `fixtures/<name>/` into the VFS; false if there is no such example. */
export async function loadExample(vfs: VFS, name: string): Promise<boolean> {
  const prefix = `../fixtures/${name}/`;
  const entries = Object.entries(files).filter(([path]) => path.startsWith(prefix));
  if (!entries.length) return false;
  vfs.clear();
  for (const [path, load] of entries) vfs.write(path.slice(prefix.length), await load());
  return true;
}
