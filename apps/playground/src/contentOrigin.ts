/**
 * The origin that runs project code (the runtime Worker and the previews), or undefined to run it on the editor's own
 * origin. Dev: the editor at http://runbun.localhost:5173 (VITE_EDITOR_ORIGINS) and
 * `VITE_CONTENT_ORIGIN=http://run.runbun.localhost:5173`, the same server under a subdomain: a different origin but the
 * same site, as run.runbun.dev is to runbun.dev. Chrome and Firefox resolve *.localhost to loopback. Same site matters:
 * with another site the content origin's service worker is partitioned under the editor, and "open preview in a new
 * tab" finds none. Plain `localhost` doesn't do as the editor: it is its own site (a bare `localhost` is a public
 * suffix), and so is `run.localhost`, so the two are cross-site.
 */
const raw = import.meta.env.VITE_CONTENT_ORIGIN as string | undefined;
export const CONTENT_ORIGIN: string | undefined = raw ? new URL(raw).origin : undefined;

/**
 * The editor origins the content origin's host page (host.html) talks to. Fixed at build time, never taken from the
 * page's URL: any site can frame host.html, and only these may drive it. `VITE_EDITOR_ORIGINS`, comma-separated.
 */
export const EDITOR_ORIGINS: ReadonlySet<string> = new Set(
  ((import.meta.env.VITE_EDITOR_ORIGINS as string | undefined) ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin),
);
