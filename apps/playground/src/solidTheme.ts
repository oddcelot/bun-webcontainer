import type { ThemeLike } from "@pierre/theming";
import { createThemeCollection } from "@pierre/theming";
import { createTheme } from "@pierre/theming/themes";
import type { Theme as ZedTheme } from "@pierre/highlights";

// The SolidJS sites' look (solidjs.com and docs.solidjs.com share one set of tokens): their surfaces, text and brand
// blues as the chrome, the code colors of solidjs.com's own code blocks, and Geist as the font. For a Solid playground
// (the hosting file's `theme.family`, hosting/README.md), and a family like any other in the theme picker.
// Each comes twice, like the Elysia pair: a TextMate theme (the theme controller, the chrome) and a Zed one
// (@pierre/highlights, the code).
type SolidTheme = ThemeLike & {
  tokenColors: { scope: string[]; settings: { foreground: string; fontStyle?: string } }[];
  zed: ZedTheme;
};

/** The sites' tokens this theme uses, by their names there (`--color-*`). */
interface Palette {
  /** `bg`: the panes. */
  bg: string;
  /** `bg-subtle`: the chrome's panels (menus, controls). */
  panel: string;
  border: string;
  /** Code's text color (`code-text`); the UI's text is `text`. */
  code: string;
  text: string;
  muted: string;
  faint: string;
  /** `brand-text`: links and keywords. */
  brand: string;
  /** `info`: calls. */
  info: string;
  /** `accent-text`: strings (Solid's yellow, darkened on white). */
  accent: string;
  warning: string;
  success: string;
  danger: string;
  /** The focus ring. */
  focus: string;
  selection: string;
}

const theme = (name: string, type: "light" | "dark", p: Palette): SolidTheme => ({
  name,
  type,
  colors: {
    "editor.foreground": p.code,
    "editor.background": p.bg,
    "editor.selectionBackground": p.selection,
    "editorCursor.foreground": p.focus,
    "editorLineNumber.foreground": p.faint,
    "sideBar.background": p.panel,
    "panel.border": p.border,
    focusBorder: p.focus,
    "textLink.foreground": p.brand,
    "editorError.foreground": p.danger,
    "editorWarning.foreground": p.warning,
    "editorInfo.foreground": p.info,
    "terminal.ansiBlack": type === "light" ? p.text : p.panel,
    "terminal.ansiRed": p.danger,
    "terminal.ansiGreen": p.success,
    "terminal.ansiYellow": p.warning,
    "terminal.ansiBlue": p.info,
    "terminal.ansiMagenta": p.brand,
    "terminal.ansiCyan": p.focus,
    "terminal.ansiWhite": p.muted,
    "terminal.ansiBrightBlack": p.faint,
  },
  tokenColors: [
    { scope: ["comment"], settings: { foreground: p.faint, fontStyle: "italic" } },
    { scope: ["keyword", "storage"], settings: { foreground: p.brand } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: p.info } },
    { scope: ["string"], settings: { foreground: p.accent } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: p.warning } },
    { scope: ["entity.name.tag", "entity.name.type", "support.type", "support.class"], settings: { foreground: p.success } },
    { scope: ["entity.other.attribute-name", "variable.other.property"], settings: { foreground: p.text } },
    { scope: ["punctuation", "keyword.operator"], settings: { foreground: p.muted } },
  ],
  zed: {
    name,
    appearance: type,
    style: {
      "editor.foreground": p.code,
      "editor.background": p.bg,
      players: [{ selection: p.selection }],
      syntax: {
        comment: { color: p.faint, font_style: "italic" },
        keyword: { color: p.brand, font_weight: 500 },
        function: { color: p.info },
        string: { color: p.accent },
        "string.escape": { color: p.warning },
        "string.regex": { color: p.danger },
        number: { color: p.warning },
        boolean: { color: p.warning },
        constant: { color: p.warning },
        tag: { color: p.success },
        type: { color: p.success },
        constructor: { color: p.success },
        attribute: { color: p.text },
        property: { color: p.text },
        operator: { color: p.muted },
        punctuation: { color: p.muted },
      },
    },
  },
});

export const solidLight = theme("solid-light", "light", {
  bg: "#ffffff",
  panel: "#f5f7fa",
  border: "#dfe4ec",
  code: "#1c2735",
  text: "#03152c",
  muted: "#4a5568",
  faint: "#5f6b7c",
  brand: "#0a4593",
  info: "#0265b2",
  accent: "#8a6a00",
  warning: "#9a5b00",
  success: "#1d7a4a",
  danger: "#b42318",
  // The sites' ring is #008edc, which doesn't reach 3:1 on a pressed control here; the next blue down does.
  focus: "#0265b2",
  selection: "#008edc3d",
});
export const solidDark = theme("solid-dark", "dark", {
  bg: "#03152c",
  panel: "#122339",
  border: "#303f52",
  code: "#dbe4f2",
  text: "#ffffff",
  muted: "#aab6c8",
  faint: "#8b98ad",
  brand: "#65c5ff",
  info: "#0aa0ef",
  accent: "#ffd400",
  warning: "#f2b84b",
  success: "#5fd394",
  danger: "#ff8a80",
  focus: "#65c5ff",
  selection: "#0a4593",
});

/**
 * What the chrome takes from the sites beyond the theme's colors: the page behind the panes (their `slate-100` and
 * `slate-950`), the muted text as they have it, their medium radius, and Geist (the theme's `load` fetches the fonts).
 */
const FONTS = {
  "--font-ui": '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "--font-mono": '"Geist Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  "--radius": "10px",
};
export const SOLID_THEME_VARS: Record<string, Record<string, string>> = {
  "solid-light": { ...FONTS, "--canvas": "#eef2f7", "--border": "#dfe4ec", "--muted": "#4a5568" },
  "solid-dark": { ...FONTS, "--canvas": "#020e1e", "--border": "#303f52", "--muted": "#aab6c8" },
};

/** Geist and Geist Mono (variable, SIL OFL), fetched when a Solid theme first loads. A failed fetch leaves the fallbacks. */
const fonts = () => Promise.all([import("@fontsource-variable/geist/wght.css"), import("@fontsource-variable/geist-mono/wght.css")]).catch(() => {});

/** The pair as a theme family: selecting `solid-light` selects `solid-dark` for dark mode too. */
export const solidThemes = createThemeCollection({
  themes: [
    createTheme({
      name: "solid-light",
      displayName: "Solid Light",
      collection: "Solid",
      colorScheme: "light",
      load: async () => (void fonts(), solidLight),
    }),
    createTheme({
      name: "solid-dark",
      displayName: "Solid Dark",
      collection: "Solid",
      colorScheme: "dark",
      load: async () => (void fonts(), solidDark),
    }),
  ],
});
