import { dirname, norm, type VFS } from "@runbun/vfs";
import { reachableFiles } from "./moduleServer";

// Which edits the running program can't see, so Watch can reload the preview without restarting it.

/** A page's own files: its `<script src>` and `<link href>` that are local. */
function pageRoots(vfs: VFS): string[] {
  const roots: string[] = [];
  for (const [path] of vfs.files) {
    if (!path.endsWith(".html") || path.includes("node_modules/")) continue;
    const html = vfs.readText(path) ?? "";
    for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=(["'])([^"']+)\1/gi)) {
      const ref = m[2].split(/[?#]/)[0];
      if (/^(https?:|data:|\/\/|#)/.test(ref)) continue;
      roots.push(norm(ref.startsWith("/") ? ref : `${dirname(path)}/${ref}`));
    }
  }
  return roots;
}

/**
 * True when every changed file is one a served page loads (its scripts and what they import, its stylesheets, the
 * HTML itself) and the program `entry` doesn't import: nothing the server runs changed, so it needn't restart. Anything
 * else (package.json, an installed package, a file the server imports or reads at run time) is false: a restart.
 */
export function clientOnly(vfs: VFS, entry: string, changed: Iterable<string>): boolean {
  const paths = [...changed].map(norm);
  if (!paths.length) return false;
  const client = reachableFiles(vfs, pageRoots(vfs), "browser");
  const server = reachableFiles(vfs, [entry], "bun");
  // The scan reaches only what it can resolve: a changed file must be in the client's set before the edit counts.
  return paths.every((p) => (p.endsWith(".html") || client.has(p)) && !server.has(p) && !p.includes("node_modules/"));
}
