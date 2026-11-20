import { registerCustomTheme } from "@pierre/diffs";
import { elysiaDark, elysiaLight } from "../elysiaTheme";
import { solidDark, solidLight } from "../solidTheme";
import { languageByExt } from "../languages";

/**
 * Every @pierre/diffs surface (the editor, the viewer, the Changes tab) highlights with @pierre/highlights (bundled
 * lexers and Zed themes), not Shiki. A page holds one backend: the first surface to ask loads it, so each one asks
 * for this.
 */
export const HIGHLIGHTER = "highlights" as const;

// @pierre/diffs resolves theme names from its own bundles; the Elysia and Solid pairs (elysiaTheme.ts, solidTheme.ts)
// have to be registered.
registerCustomTheme("elysia-light", async () => elysiaLight.zed, "zed");
registerCustomTheme("elysia-dark", async () => elysiaDark.zed, "zed");
registerCustomTheme("solid-light", async () => solidLight.zed, "zed");
registerCustomTheme("solid-dark", async () => solidDark.zed, "zed");

/**
 * The language for a file, where its extension alone picks the wrong one: a language pack's files (src/languages).
 * Highlights has no ReactiveScript lexer: .rx is TSX plus `component`/`source` blocks, so TSX is the closest.
 */
export const langFor = (name: string) => languageByExt(/\.([^./]+)$/.exec(name)?.[1].toLowerCase() ?? "")?.highlightAs;
