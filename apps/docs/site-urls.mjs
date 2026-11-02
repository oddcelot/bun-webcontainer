// Where the docs and the playground live, so each links to the other in the same environment. Set `DOCS_URL` and
// `PLAYGROUND_URL` for a canary or preview deploy; otherwise `astro dev` links the local playground (vite's
// localhost:5173) and builds link runbun.dev. The playground reads the same `DOCS_URL` (playground/vite.config.ts).

const withSlash = (url) => (url.endsWith("/") ? url : url + "/");
const isDev = process.env.NODE_ENV === "development";

export const DOCS_URL = withSlash(process.env.DOCS_URL || (isDev ? "http://localhost:4321/" : "https://docs.runbun.dev/"));
export const PLAYGROUND_URL = withSlash(process.env.PLAYGROUND_URL || (isDev ? "http://localhost:5173/" : "https://runbun.dev/"));

/** Pages link the playground as `https://runbun.dev/...`; this points those links in a page's HTML at `playground`. */
export const toPlayground = (html, playground) => html.replace(/(href=["'])https:\/\/runbun\.dev(?:\/|(?=["']))/g, `$1${playground}`);
