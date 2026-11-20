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
  /** The site's name ("runbun.dev"), in titles and "Open in …". */
  name: string;
  /** The page's canonical URL: the first editor origin under the build's base. */
  siteUrl: string;
  /** The gallery's example folders, in order, or null for all of them (src/examples.ts). */
  gallery: string[] | null;
  /** The example a URL without a project opens, or null for the demo (src/main.ts). */
  defaultProject: string | null;
  /** Whether `/` may show the landing page (index.html reads the same from data-landing). */
  landing: boolean;
  /**
   * Whether runbun.dev's Worker (worker/index.ts) answers next to the files: short links, feedback, signing in with
   * GitHub, the git proxy. Without it the playground leaves them out.
   */
  worker: boolean;
}

export const HOSTING: RuntimeHosting = hosting;
