import type { VFS } from "@runbun/vfs";

// Project files of each fixture (top level and src/), bundled as text. Their node_modules are never
// included; "bun install" fetches packages from the lockfile.
const files = import.meta.glob<string>("../fixtures/*/{package.json,tsconfig.json,bun.lock,*.ts,*.tsx,*.js,*.mjs,*.html,*.css,src/**/*}", {
  query: "?raw",
  import: "default",
});

/** Where a project in the gallery sits: a starting point, a bundled example, or a public GitHub repo. */
export type ProjectKind = "starter" | "example" | "github";

/**
 * A project in the gallery (ui/ProjectPicker.tsx). `value` is what `openProject` takes: `""` the confetti demo, a
 * fixture's name (`?example=`), or `repo:<query>` (`?repo=`, see github.ts). `tags` name its core technologies.
 */
export type CatalogEntry = { value: string; kind: ProjectKind; name: string; description: string; tags: string[]; icon: string };

export const catalog: CatalogEntry[] = [
  { value: "starter-blank", kind: "starter", name: "Blank", description: "One TypeScript file that logs to the console", tags: ["TypeScript"], icon: "i-simple-icons-bun" },
  { value: "starter-http", kind: "starter", name: "HTTP API", description: "A JSON API with Bun.serve routes", tags: ["Bun.serve", "TypeScript"], icon: "i-lucide-server" },
  { value: "starter-react", kind: "starter", name: "React", description: "Bun.serve with an HTML import that bundles a React app", tags: ["React", "Bun.serve", "HTML imports"], icon: "i-simple-icons-react" },
  { value: "starter-sqlite", kind: "starter", name: "SQLite", description: "Notes in bun:sqlite, served as JSON", tags: ["bun:sqlite", "Bun.serve"], icon: "i-simple-icons-sqlite" },
  { value: "starter-websocket", kind: "starter", name: "WebSocket chat", description: "A chat room over Bun.serve WebSockets and pub/sub", tags: ["WebSocket", "Bun.serve", "HTML imports"], icon: "i-lucide-messages-square" },
  { value: "", kind: "example", name: "Confetti demo", description: "An API route, an HTML import and a package from npm", tags: ["Bun.serve", "HTML imports"], icon: "i-lucide-party-popper" },
  { value: "elysia-demo", kind: "example", name: "Elysia", description: "Routes, params and validation in Elysia 1.4", tags: ["Elysia"], icon: "i-lucide-leaf" },
  { value: "elysia2-demo", kind: "example", name: "Elysia 2 (rc)", description: "Plugins, macros, server-sent events and a WebSocket chat", tags: ["Elysia", "WebSocket"], icon: "i-lucide-leaf" },
  { value: "astro-solid-demo", kind: "example", name: "Astro + Solid", description: "The Astro dev server with a hydrated Solid island", tags: ["Astro", "Solid"], icon: "i-simple-icons-astro" },
  { value: "vite-demo", kind: "example", name: "Vite", description: "The Vite dev server, with HMR over the preview", tags: ["Vite"], icon: "i-simple-icons-vite" },
  { value: "node-demo", kind: "example", name: "node:* built-ins", description: "fs, crypto, events, path, url and util", tags: ["Node.js"], icon: "i-simple-icons-nodedotjs" },
  { value: "lockfile-demo", kind: "example", name: "bun.lock", description: "Nested node_modules installed from a lockfile", tags: ["bun install"], icon: "i-lucide-lock" },
  { value: "repo:oddcelot/bun-elysia-demo", kind: "github", name: "Elysia", description: "oddcelot/bun-elysia-demo", tags: ["Elysia"], icon: "i-lucide-leaf" },
  { value: "repo:https://github.com/oddcelot/lit-devtools/tree/main/examples/elysia", kind: "github", name: "Lit SSR guestbook", description: "Streamed Lit SSR, bun:sqlite and WebSockets on Elysia", tags: ["Lit", "Elysia", "bun:sqlite"], icon: "i-simple-icons-lit" },
  { value: "repo:https://github.com/honojs/starter/tree/main/templates/bun", kind: "github", name: "Hono", description: "The Hono starter for Bun", tags: ["Hono"], icon: "i-simple-icons-hono" },
];

/** The bundled projects (starters and examples) by fixture name, for labels; the demo isn't one. */
export const examples: Record<string, string> = Object.fromEntries(catalog.filter((e) => e.kind !== "github" && e.value).map((e) => [e.value, e.name]));

/** Public GitHub repos in the gallery, by `?repo=` query (see github.ts). */
export const repoExamples: Record<string, string> = Object.fromEntries(
  catalog.filter((e) => e.kind === "github").map((e) => [e.value.slice(5), `${e.name} (from GitHub)`]),
);

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
