// A preview (/__preview/…) or a project module (/__vfs/…) on the content host is served by its service worker (src/sw.ts),
// from the playground tab that runs the project. A request that reaches the server instead has no tab behind it: the URL
// was opened on its own (a preview opened in a new tab from a third-party embed, whose service worker is partitioned
// under the embedder), or after the playground closed. Say so rather than answer with the assets' bare 404.
// worker/index.ts uses it on Cloudflare; vite.config.ts in dev.

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The answer for `pathname` when it is a preview or module path, else null. `editor`: the playground's origin. */
export function stranded(pathname: string, editor: string): Response | null {
  const preview = pathname.startsWith("/__preview/");
  if (!preview && !pathname.startsWith("/__vfs/")) return null;
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex" };
  // A module or asset request: a short message for the console, not a page.
  if (!preview || !/\/$|\.html?$|\/[^./]*$/.test(pathname)) {
    return new Response("This file comes from a playground tab's project, and none is serving it here.\n", { status: 404, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  }
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Preview not running</title>
<style>
  body {
    font: 16px/1.5 system-ui, sans-serif;
    max-width: 34rem;
    margin: 15vh auto;
    padding: 0 1.5rem;
    color-scheme: light dark;
  }
</style>
<h1>This preview isn't running here</h1>
<p>A playground preview is served by the browser tab that runs its project. Opened on its own, or after that tab closed, there is nothing to show.</p>
<p>Go back to the playground (or the page with the embedded playground) and open the preview from there.</p>
<p><a href="${escape(editor)}/">Open the playground</a></p>
`;
  return new Response(html, { status: 404, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}
