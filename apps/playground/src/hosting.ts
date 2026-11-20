/**
 * Where this copy of the playground is hosted, read when the page or worker starts: `hosting.js` next to index.html,
 * which a deploy writes (hosting/configure.ts, from a hosting file such as hosting/runbun.dev.json). A built playground
 * is the same files for every host; only hosting.js, sw.js's first lines, the HTML's docs links and _headers differ.
 * In dev, vite.config.ts serves the same object from the `HOSTING` file without a request. Outside Vite (scripts under
 * plain Bun), package.json's `imports` map `#hosting` to src/hostingDefaults.ts.
 */
import hosting from "#hosting";

export interface RuntimeHosting {
  /** The docs site, ending in "/". */
  docsUrl: string;
  /** The origin that runs project code, or null to run it on the editor's own origin (src/contentOrigin.ts). */
  contentOrigin: string | null;
  /** The editor origins the content origin's pages answer. */
  editorOrigins: string[];
  /** A canary build: shows src/canary.ts's badge. */
  canary: boolean;
}

export const HOSTING: RuntimeHosting = hosting;
