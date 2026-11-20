interface ImportMetaEnv {
  /** Set by vite.config.ts from the hosting file's docsUrl or `DOCS_URL` (see src/base.ts). */
  readonly DOCS_URL: string;
  /** Set by vite.config.ts from the hosting file (hosting/load.ts): true in canary builds, which show src/canary.ts's badge. */
  readonly CANARY: boolean;
  /** The hosting file's contentOrigin (an origin), or "" to run project code on the editor's origin (src/contentOrigin.ts). */
  readonly CONTENT_ORIGIN: string;
  /** The hosting file's editorOrigins (origins), see src/contentOrigin.ts. */
  readonly EDITOR_ORIGINS: readonly string[];
}
