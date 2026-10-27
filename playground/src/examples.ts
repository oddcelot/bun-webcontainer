import type { VFS } from "./vfs";

// Top-level project files of each fixture, bundled as text. Their node_modules are never included;
// "bun install" fetches packages from the lockfile.
const files = import.meta.glob<string>("../fixtures/*/{package.json,bun.lock,*.ts,*.tsx,*.js,*.html,*.css}", {
  query: "?raw",
  import: "default",
});

export const examples: Record<string, string> = {
  "elysia-demo": "Elysia",
  "lockfile-demo": "bun.lock + nested node_modules",
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
