import type { VFS } from "@runbun/vfs";
import type { LibraryProject } from "@runbun/embed/protocol";
import { HOSTING } from "./hosting";
import { enabledLanguages } from "./languages";
import { readConfig } from "./projectConfig";

// The gallery's projects come from the examples repo (oddcelot/runbun-examples), a git submodule at examples/: each
// folder's runbun.json or example.json says how the gallery shows it, and every other file of it is bundled as text
// (the repo's check keeps projects to text). Their node_modules are never included; "bun install" fetches packages
// from the lockfile. demo.ts takes the demo's with the same pattern.
const files = import.meta.glob<string>(
  ["../examples/*/**/*", "../examples/*/**/.*", "!../examples/*/**/node_modules/**", "!../examples/*/example.json", "!../examples/*/**/*.{png,jpg,jpeg,gif,webp,ico,woff,woff2,sqlite,db}"],
  { query: "?raw", import: "default" },
);
/**
 * The examples repo's example.json (its example.schema.json): a project, or a GitHub repo to open (`repo`). `languages`:
 * the language packs (src/languages) it needs; a host that leaves one out has no card for it.
 */
type ExampleMeta = { name?: string; description?: string; kind?: "starter" | "example"; order?: number; tags?: string[]; repo?: string; languages?: string[] };
const exampleJsons = import.meta.glob<ExampleMeta>("../examples/*/example.json", { eager: true, import: "default" });
// A folder's runbun.json may carry its card too (name, description, kind, tags), over example.json's: example.json
// stays for what's only the gallery's (order, repo) and for folders without the fields.
const runbunJsons = import.meta.glob<string>("../examples/*/runbun.json", { eager: true, query: "?raw", import: "default" });
const folderOf = (path: string) => path.split("/").at(-2)!;
const metas: Record<string, ExampleMeta> = {};
for (const [path, m] of Object.entries(exampleJsons)) metas[folderOf(path)] = { ...m };
for (const [path, text] of Object.entries(runbunJsons)) {
  const { name, description, kind, tags } = readConfig(() => text);
  const card = Object.fromEntries(Object.entries({ name, description, kind, tags }).filter(([, v]) => v !== undefined));
  if (card.name || metas[folderOf(path)]) metas[folderOf(path)] = { ...metas[folderOf(path)], ...card };
}
if (!Object.keys(metas).length) throw new Error("the examples submodule is empty: git submodule update --init apps/playground/examples");

/** Where a project in the gallery sits: a starting point, a bundled example, or a public GitHub repo. */
export type ProjectKind = "starter" | "example" | "github";

/**
 * A project in the gallery (ui/ProjectPicker.tsx). `value` is what `openProject` takes: `""` the confetti demo (the
 * examples repo's demo/), a folder's name (`?example=`), or `repo:<query>` (`?repo=`, see github.ts). `tags` name its
 * core technologies; `icon` is the first one's logo, else Bun's.
 */
export type CatalogEntry = { value: string; kind: ProjectKind; name: string; description: string; tags: string[]; icon: string };

/** Each tag's product logo (see uno.config.ts); a tag without one shows without a logo. */
export const techIcons: Record<string, string> = {
  SQLite: "i-runbun-sqlite?bg",
  WebSocket: "i-logos-websocket",
  React: "i-logos-react?bg",
  Elysia: "i-runbun-elysia?bg",
  Astro: "i-logos-astro-icon logo-astro",
  Solid: "i-logos-solidjs-icon?bg",
  Vite: "i-logos-vitejs?bg",
  "Node.js": "i-logos-nodejs-icon?bg",
  Lit: "i-logos-lit-icon?bg",
  Hono: "i-logos-hono?bg",
  Vue: "i-logos-vue?bg",
  Pinia: "i-logos-pinia?bg",
  Nuxt: "i-logos-nuxt-icon?bg",
};

const KIND_ORDER: ProjectKind[] = ["starter", "example", "github"];
/** A card's icon: its first tag's logo, else Bun's. */
const iconOf = (tags: string[]) => tags.map((t) => techIcons[t]).find(Boolean) ?? "i-logos-bun?bg";

/** Whether this host enables every language pack (src/languages) an example's `languages` names. */
const supported = (m: ExampleMeta) => (m.languages ?? []).every((id) => enabledLanguages.some((l) => l.id === id));

/** The hosting file's `gallery` (src/hosting.ts): only these folders, in its order; else all of them by their `order`. */
const shown = HOSTING.gallery;
/** Every project of the examples repo, gallery or not: `?example=` and embeds open any of them. */
const everything = Object.entries(metas)
  .filter(([, m]) => m.name)
  .map(([folder, m]) => {
    const entry: CatalogEntry = {
      // The demo is the bare URL, unless the host opens another project there (defaultProject).
      value: m.repo ? `repo:${m.repo}` : folder === "demo" && !HOSTING.defaultProject ? "" : folder,
      kind: m.repo ? "github" : (m.kind ?? "example"),
      name: m.name!,
      description: m.description ?? "",
      tags: m.tags ?? [],
      icon: iconOf(m.tags ?? []),
    };
    return [entry, folder, shown ? shown.indexOf(folder) : (m.order ?? Infinity), supported(m)] as const;
  })
  .sort(([a, , ao], [b, , bo]) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || ao - bo || a.name.localeCompare(b.name));

/** The gallery's projects (ui/ProjectPicker.tsx): not those that need a language pack the host leaves out (`languages`, an example's example.json). */
export const catalog: CatalogEntry[] = everything.filter(([, folder, , ok]) => ok && (!shown || shown.includes(folder))).map(([entry]) => entry);
const all = everything.map(([entry]) => entry);

/**
 * An embed's library (`library` on <bun-playground>, protocol.ts) as gallery entries, valued by id: starters first,
 * then the rest in the host's order.
 */
export function libraryCatalog(projects: LibraryProject[]): CatalogEntry[] {
  const entries = projects.map(
    (p): CatalogEntry => ({
      value: p.id,
      kind: p.repo ? "github" : (p.kind ?? "example"),
      name: p.name,
      description: p.description ?? "",
      tags: p.tags ?? [],
      icon: iconOf(p.tags ?? []),
    }),
  );
  return entries.map((e, i) => [e, i] as const).sort(([a, ai], [b, bi]) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || ai - bi).map(([e]) => e);
}

/** The bundled projects (starters and examples) by fixture name, for labels; the demo isn't one. */
export const examples: Record<string, string> = Object.fromEntries(all.filter((e) => e.kind !== "github" && e.value).map((e) => [e.value, e.name]));

/** Public GitHub repos in the gallery, by `?repo=` query (see github.ts). */
export const repoExamples: Record<string, string> = Object.fromEntries(
  all.filter((e) => e.kind === "github").map((e) => [e.value.slice(5), `${e.name} (from GitHub)`]),
);

/** The files of the examples repo's `<name>/` (`demo` included) by path, without touching the VFS; null if there is no such example. */
export async function exampleFiles(name: string): Promise<Map<string, string> | null> {
  const prefix = `../examples/${name}/`;
  const entries = Object.entries(files).filter(([path]) => path.startsWith(prefix));
  if (!entries.length) return null;
  return new Map(await Promise.all(entries.map(async ([path, load]) => [path.slice(prefix.length), await load()] as const)));
}

/** Loads the examples repo's `<name>/` into the VFS; false if there is no such example. */
export async function loadExample(vfs: VFS, name: string): Promise<boolean> {
  const loaded = await exampleFiles(name);
  if (!loaded) return false;
  vfs.clear();
  for (const [path, text] of loaded) vfs.write(path, text);
  return true;
}
