import { HOSTING } from "./hosting";

/** Where the app is served, always ending in "/" (`vite build --base=/sub/path/`). */
export const BASE = import.meta.env.BASE_URL;

/** The docs site, ending in "/": the hosting file's docsUrl (src/hosting.ts). */
export const DOCS = HOSTING.docsUrl;

/** runbun's source repository, linked from the header (on a self-hosted copy too). */
export const REPO = "https://github.com/oddcelot/bun-webcontainer";
