// The service worker's half of the devtools prototype (previewDevtools.ts has the page's, and says why).

/**
 * Whether a script is (or bundles) the toolbar of @solidjs/start-devtools: Vite serves the package's own files or its
 * optimizer's bundle of them, and a project can bundle it into its own script (solid-ssr-dashboard's Bun.build).
 */
export const hasDevtools = (js: string) => js.includes("data-solid-dev-toolbar-dock");

/**
 * The toolbar's Portal with a `mount`: what the page's `__runbunDevtoolsMount` returns, or the page's body as before.
 * A bundler may have renamed `createComponent` and `Portal` (`Portal2`).
 */
export const patchDevtools = (js: string) =>
  js.replace(/return \[\s*createComponent\w*\(Portal\w*, \{/, (m) => `${m} get mount() { return globalThis.__runbunDevtoolsMount?.(); },`);
