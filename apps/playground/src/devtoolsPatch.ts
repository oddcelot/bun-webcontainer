// The service worker's half of the devtools prototype (previewDevtools.ts has the page's, and says why).

/** The paths of the package's modules, as Vite serves them (its own files, or the optimizer's bundle of them). */
export const DEVTOOLS_MODULE = /start-devtools/;

/** The toolbar's Portal with a `mount`: what the page's `__runbunDevtoolsMount` returns, or the page's body as before. */
export const patchDevtools = (js: string) => js.replace(/return \[\s*createComponent\(Portal, \{/, (m) => `${m} get mount() { return globalThis.__runbunDevtoolsMount?.(); },`);
