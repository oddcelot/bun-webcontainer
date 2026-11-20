/**
 * The origin that runs project code (the runtime Worker and the previews), or undefined to run it on the editor's own
 * origin: the hosting file's contentOrigin (hosting/load.ts; vite.config.ts defines it). Dev:
 * the editor at http://runbun.localhost:5173 (VITE_EDITOR_ORIGINS) and
 * `VITE_CONTENT_ORIGIN=http://run.runbun.localhost:5173`, the same server under a subdomain: a different origin but the
 * same site, as run.runbun.dev is to runbun.dev. Chrome and Firefox resolve *.localhost to loopback. Same site matters:
 * with another site the content origin's service worker is partitioned under the editor, and "open preview in a new
 * tab" finds none. Plain `localhost` doesn't do as the editor: it is its own site (a bare `localhost` is a public
 * suffix), and so is `run.localhost`, so the two are cross-site.
 */
export const CONTENT_ORIGIN: string | undefined = import.meta.env.CONTENT_ORIGIN || undefined;

/**
 * The editor origins the content origin's host page (host.html) talks to: the hosting file's editorOrigins. Fixed at
 * build time, never taken from the page's URL: any site can frame host.html, and only these may drive it.
 */
export const EDITOR_ORIGINS: ReadonlySet<string> = new Set(import.meta.env.EDITOR_ORIGINS);
