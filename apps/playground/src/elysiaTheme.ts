import type { ThemeLike } from "@pierre/theming";
import { createThemeCollection } from "@pierre/theming";
import { createTheme } from "@pierre/theming/themes";
import type { Theme as ZedTheme } from "@pierre/highlights";

// The Elysia docs' code themes (src/spica/code-themes.mjs there), so an embed in those docs colors code the same way
// the page's own code blocks do. The colors are sRGB anchors from the docs' tokens, not runbun's palette.
// Each comes twice: a TextMate theme (the theme controller, the chrome) and a Zed one (@pierre/highlights, the code).
type ElysiaTheme = ThemeLike & {
  tokenColors: { scope: string[]; settings: { foreground: string } }[];
  zed: ZedTheme;
};

const theme = (
  name: string,
  type: "light" | "dark",
  foreground: string,
  background: string,
  keyword: string,
  method: string,
  string: string,
  number: string,
  comment: string,
  selection: string,
): ElysiaTheme => ({
  name,
  type,
  // Without a selection color the editor paints selections in the line's background, i.e. invisibly.
  colors: { "editor.foreground": foreground, "editor.background": background, "editor.selectionBackground": selection },
  tokenColors: [
    { scope: ["keyword", "storage"], settings: { foreground: keyword } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: method } },
    { scope: ["string"], settings: { foreground: string } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: number } },
    { scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: method } },
    { scope: ["comment"], settings: { foreground: comment } },
  ],
  zed: {
    name,
    appearance: type,
    style: {
      "editor.foreground": foreground,
      "editor.background": background,
      players: [{ selection }],
      syntax: {
        keyword: { color: keyword },
        function: { color: method },
        string: { color: string },
        number: { color: number },
        boolean: { color: number },
        constant: { color: number },
        type: { color: method },
        constructor: { color: method },
        comment: { color: comment },
      },
    },
  },
});

export const elysiaLight = theme(
  "elysia-light",
  "light",
  "#2A2630",
  "#FFFFFF",
  "#7E5BA8",
  "#904061",
  "#45688B",
  "#5360AA",
  "#585563",
  "#F9578A40",
);
export const elysiaDark = theme(
  "elysia-dark",
  "dark",
  "#EDEAFB",
  "#171723",
  "#CFB4E8",
  "#F6BCD6",
  "#A8CDF0",
  "#C9D2F2",
  "#A7AEDC",
  "#FE8DC54D",
);

/**
 * The docs' page overlay for each theme (style.css `.overlay`): `--surface-wash-iris-glow` as the wash and
 * `--gradient-magic-strong` as the ring, from the docs' src/styles/spica.css. The docs' oklch tokens are converted to
 * sRGB, and `color-mix(in oklab, c N%, transparent)` is c at alpha N%.
 */
export const THEME_VARS: Record<string, Record<string, string>> = {
  "elysia-light": {
    "--overlay":
      "radial-gradient(60% 54% at 98% 2%, rgba(207, 180, 232, 0.22) 0%, rgba(207, 180, 232, 0) 68%), radial-gradient(56% 50% at 2% 98%, rgba(222, 194, 236, 0.18) 0%, rgba(222, 194, 236, 0) 70%), radial-gradient(50% 46% at 88% 96%, rgba(255, 116, 156, 0.1) 0%, rgba(255, 116, 156, 0) 72%)",
    "--overlay-ring": "linear-gradient(135deg, #FCD3E2 0%, #F1E1FC 50%, #9FCEFA 100%)",
  },
  "elysia-dark": {
    "--overlay":
      "radial-gradient(75% 67.5% at 98% 2%, rgba(105, 69, 135, 0.28), transparent 100%), radial-gradient(70% 62.5% at 2% 98%, rgba(105, 69, 135, 0.24), transparent 100%), radial-gradient(62.5% 57.5% at 88% 96%, rgba(132, 59, 97, 0.14), transparent 100%)",
    "--overlay-ring": "linear-gradient(135deg, #69334E, #31263B 50%, #1D2D3C)",
  },
};

/** The pair as a theme family: selecting `elysia-light` selects `elysia-dark` for dark mode too. */
export const elysiaThemes = createThemeCollection({
  themes: [
    createTheme({
      name: "elysia-light",
      displayName: "Elysia Light",
      collection: "Elysia",
      colorScheme: "light",
      load: async () => elysiaLight,
    }),
    createTheme({
      name: "elysia-dark",
      displayName: "Elysia Dark",
      collection: "Elysia",
      colorScheme: "dark",
      load: async () => elysiaDark,
    }),
  ],
});
