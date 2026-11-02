interface ImportMetaEnv {
  /** Set by vite.config.ts from `DOCS_URL` (see src/base.ts). */
  readonly DOCS_URL: string;
  /** Set by vite.config.ts: true in canary builds (`CANARY=1`), which show src/canary.ts's badge. */
  readonly CANARY: boolean;
}
