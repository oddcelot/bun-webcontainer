import { formatRx, RX_FMT_FLAGS } from "./rxFormat";
import { analyzeRx, projectRx, rxView } from "./rx";
import type { LanguagePack } from "../types";

/**
 * ReactiveScript (.rx): types through its compiler's TSX projection (rx.ts), and a formatter that disguises the module
 * as TSX for `bun fmt` (rxFormat.ts). The compiler is rxc.wasm, fetched on the first project that has an .rx file.
 */
export const reactivescript: LanguagePack = {
  projectionSuffix: ".tsx",
  project: projectRx,
  view: rxView,
  // `bun fmt` has no parser for .rx, so the module goes to it disguised as TSX, with the project's configs for a .tsx
  // file beside it, and the result counts only once the compiler's analysis shows the same program.
  format: (vfs, path, text, fmt) =>
    formatRx(text, {
      fmt: async (tsx) => {
        const r = await fmt(vfs, `${path}.tsx`, tsx, RX_FMT_FLAGS);
        return r.exitCode === 0 ? { ok: true, out: r.stdout } : { ok: false, err: r.stderr };
      },
      analyze: (t) => analyzeRx(vfs, path, t),
    }),
  // A module is reflowed a lot (its one-line handlers and blocks open up): only when asked for.
  formatOnSave: false,
};
