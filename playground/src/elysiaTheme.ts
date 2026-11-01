import type { ThemeLike } from "@pierre/theming";
import { createThemeCollection } from "@pierre/theming";
import { createTheme } from "@pierre/theming/themes";

// The Elysia docs' code themes (src/spica/code-themes.mjs there), so an embed in those docs colors code the same way
// the page's own code blocks do. The colors are sRGB anchors from the docs' tokens, not runbun's palette.
type ElysiaTheme = ThemeLike & {
  tokenColors: { scope: string[]; settings: { foreground: string } }[];
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
): ElysiaTheme => ({
  name,
  type,
  colors: { "editor.foreground": foreground, "editor.background": background },
  tokenColors: [
    { scope: ["keyword", "storage"], settings: { foreground: keyword } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: method } },
    { scope: ["string"], settings: { foreground: string } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: number } },
    { scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: method } },
    { scope: ["comment"], settings: { foreground: comment } },
  ],
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
);

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
