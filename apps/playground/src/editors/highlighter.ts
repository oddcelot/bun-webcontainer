import { registerCustomTheme } from "@pierre/diffs";
import { elysiaDark, elysiaLight } from "../elysiaTheme";

/**
 * Every @pierre/diffs surface (the editor, the viewer, the Changes tab) highlights with @pierre/highlights (bundled
 * lexers and Zed themes), not Shiki. A page holds one backend: the first surface to ask loads it, so each one asks
 * for this.
 */
export const HIGHLIGHTER = "highlights" as const;

// @pierre/diffs resolves theme names from its own bundles; the Elysia pair (elysiaTheme.ts) has to be registered.
registerCustomTheme("elysia-light", async () => elysiaLight.zed, "zed");
registerCustomTheme("elysia-dark", async () => elysiaDark.zed, "zed");

/**
 * The language for a file, where its extension alone picks the wrong one. Highlights has no ReactiveScript lexer:
 * .rx is TSX plus `component`/`source` blocks, so TSX is the closest.
 */
export const langFor = (name: string) => (name.endsWith(".rx") ? ("tsx" as const) : undefined);
