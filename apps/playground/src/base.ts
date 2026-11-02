/** Where the app is served, always ending in "/" (`vite build --base=/sub/path/`). */
export const BASE = import.meta.env.BASE_URL;

/** The docs site, ending in "/": `DOCS_URL` at build time, else localhost:4321 in dev and docs.runbun.dev in builds (vite.config.ts). */
export const DOCS = import.meta.env.DOCS_URL;
