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
  { value: "starter-blank", kind: "starter", name: "Blank", description: "One TypeScript file that logs to the console", tags: [], icon: "i-logos-bun?bg" },
  { value: "starter-http", kind: "starter", name: "HTTP API", description: "A JSON API with Bun.serve routes", tags: [], icon: "i-logos-bun?bg" },
  { value: "starter-react", kind: "starter", name: "React", description: "Bun.serve with an HTML import that bundles a React app", tags: ["React", "HTML imports"], icon: "i-logos-react?bg" },
  { value: "starter-sqlite", kind: "starter", name: "SQLite", description: "Notes in bun:sqlite, served as JSON", tags: ["bun:sqlite"], icon: "i-runbun-sqlite?bg" },
  { value: "starter-websocket", kind: "starter", name: "WebSocket chat", description: "A chat room over Bun.serve WebSockets and pub/sub", tags: ["WebSocket", "HTML imports"], icon: "i-logos-websocket" },
  { value: "", kind: "example", name: "Confetti demo", description: "An API route, an HTML import and a package from npm", tags: ["HTML imports"], icon: "i-logos-bun?bg" },
  { value: "elysia-demo", kind: "example", name: "Elysia", description: "Routes, params and validation in Elysia 1.4", tags: ["Elysia"], icon: "i-runbun-elysia?bg" },
  { value: "elysia2-demo", kind: "example", name: "Elysia 2 (rc)", description: "Plugins, macros, server-sent events and a WebSocket chat", tags: ["Elysia", "WebSocket"], icon: "i-runbun-elysia?bg" },
  { value: "astro-solid-demo", kind: "example", name: "Astro + Solid", description: "The Astro dev server with a hydrated Solid island", tags: ["Astro", "Solid"], icon: "i-logos-astro-icon" },
  { value: "vite-demo", kind: "example", name: "Vite", description: "The Vite dev server, with HMR over the preview", tags: ["Vite"], icon: "i-logos-vitejs?bg" },
  { value: "node-demo", kind: "example", name: "node:* built-ins", description: "fs, crypto, events, path, url and util", tags: ["Node.js"], icon: "i-logos-nodejs-icon?bg" },
  { value: "lockfile-demo", kind: "example", name: "bun.lock", description: "Nested node_modules installed from a lockfile", tags: [], icon: "i-logos-bun?bg" },
  { value: "repo:oddcelot/bun-elysia-demo", kind: "github", name: "Elysia", description: "oddcelot/bun-elysia-demo", tags: ["Elysia"], icon: "i-runbun-elysia?bg" },
  { value: "repo:https://github.com/oddcelot/lit-devtools/tree/main/examples/elysia", kind: "github", name: "Lit SSR guestbook", description: "Streamed Lit SSR, bun:sqlite and WebSockets on Elysia", tags: ["Lit", "Elysia", "bun:sqlite"], icon: "i-logos-lit-icon?bg" },
  { value: "repo:https://github.com/honojs/starter/tree/main/templates/bun", kind: "github", name: "Hono", description: "The Hono starter for Bun", tags: ["Hono"], icon: "i-logos-hono?bg" },
];

/** Each tag's product logo (see uno.config.ts). */
export const techIcons: Record<string, string> = {
  "bun:sqlite": "i-runbun-sqlite?bg",
  "HTML imports": "i-logos-html-5?bg",
  WebSocket: "i-logos-websocket",
  React: "i-logos-react?bg",
  Elysia: "i-runbun-elysia?bg",
  Astro: "i-logos-astro-icon",
  Solid: "i-logos-solidjs-icon?bg",
  Vite: "i-logos-vitejs?bg",
  "Node.js": "i-logos-nodejs-icon?bg",
  Lit: "i-logos-lit-icon?bg",
  Hono: "i-logos-hono?bg",
};

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
