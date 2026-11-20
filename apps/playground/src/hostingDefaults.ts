// What `#hosting` (src/hosting.ts) is outside Vite: the defaults hosting/load.ts gives the dev server, for scripts that
// import the app's modules under plain Bun or Node (scripts/runner-stop.ts). Vite answers `#hosting` itself
// (vite.config.ts hostingModule()), so neither the dev server nor a build uses this file.
import type { RuntimeHosting } from "./hosting";

export default {
  docsUrl: "http://localhost:4321/",
  contentOrigin: null,
  editorOrigins: ["http://localhost:5173"],
  canary: false,
  name: "runbun.dev",
  siteUrl: "http://localhost:5173/",
  gallery: null,
  defaultProject: null,
  landing: true,
} satisfies RuntimeHosting;
