import type { VFS } from "@runbun/vfs";
import { listRepo, parseRepo, repoFile } from "./github";
import { entryOf } from "./shell";

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

/** A look at a project without opening it: its file paths, and the file to show (its entry, else its first) with its text. */
export type ProjectPeek = { paths: string[]; path: string; text: string };

const peeks = new Map<string, Promise<ProjectPeek | null>>();

/**
 * What a picker value (`""` the demo, an example's name, `repo:<query>`) holds, without loading it. A repo costs one
 * GitHub API call (60/hour without a token) and two raw files, so each value is fetched once per page.
 */
export function peekProject(value: string): Promise<ProjectPeek | null> {
  let peek = peeks.get(value);
  if (!peek) {
    peek = (value.startsWith("repo:") ? peekRepo(value.slice(5)) : peekBundled(value || "demo")).catch(() => null);
    peeks.set(value, peek);
  }
  return peek;
}

async function peekBundled(name: string): Promise<ProjectPeek | null> {
  const files = await exampleFiles(name);
  if (!files) return null;
  const path = shownFile([...files.keys()], (f) => files.get(f));
  return { paths: [...files.keys()], path, text: files.get(path) ?? "" };
}

async function peekRepo(query: string): Promise<ProjectPeek | null> {
  const r = parseRepo(query);
  const list = r && (await listRepo(r));
  if (!r || !list || typeof list === "string") return null;
  const prefix = r.dir ? `${r.dir}/` : "";
  const paths = list.paths.map((p) => p.slice(prefix.length));
  const text = async (path: string) => {
    const data = await repoFile(r, prefix + path);
    return typeof data === "string" ? data : "(binary file)";
  };
  const pkg = paths.includes("package.json") ? await text("package.json") : undefined;
  const path = shownFile(paths, (f) => (f === "package.json" ? pkg : undefined));
  return { paths, path, text: path === "package.json" && pkg !== undefined ? pkg : await text(path) };
}

/** The entry file Run would start, else the first file. */
function shownFile(paths: string[], read: (path: string) => string | undefined) {
  const has = new Set(paths);
  const entry = entryOf((f) => has.has(f), read);
  return has.has(entry) ? entry : paths[0];
}
