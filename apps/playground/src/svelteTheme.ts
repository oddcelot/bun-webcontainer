import type { ThemeLike } from "@pierre/theming";
import { createThemeCollection } from "@pierre/theming";
import { createTheme } from "@pierre/theming/themes";
import type { Theme as ZedTheme } from "@pierre/highlights";

// The Svelte playground's look (svelte.dev/playground, its tokens from @sveltejs/site-kit): its surfaces, text and
// accent orange as the chrome, the colors of its CodeMirror editor for code. For a Svelte playground (the hosting
// file's `theme.family`, hosting/README.md), and a family like any other in the theme picker. Each comes twice, like
// the Elysia and Solid pairs: a TextMate theme (the theme controller, the chrome) and a Zed one (@pierre/highlights,
// the code).
type SvelteTheme = ThemeLike & {
  tokenColors: { scope: string[]; settings: { foreground: string; fontStyle?: string } }[];
  zed: ZedTheme;
};

/** The site's tokens this theme uses, by their names there (`--sk-*`, the editor's `--shiki-*`). */
interface Palette {
  /** `bg-1`: the panes and the editor. */
  bg: string;
  /** `bg-3`: the chrome's panels (the gutter, menus, the nav). */
  panel: string;
  border: string;
  /** Code's text color (`shiki-color-text`): also variables, properties, attributes, operators and punctuation. */
  code: string;
  /** `fg-1`: the UI's text. */
  text: string;
  /** `fg-3`: muted text and the cursor. */
  muted: string;
  /** `fg-4`: comments and line numbers. */
  faint: string;
  /** `fg-accent`: links, the focus ring. */
  accent: string;
  /** The editor's keyword blue. */
  keyword: string;
  /** The editor's function color: also types, tags and numbers (the accent in light, a softer peach in dark). */
  fn: string;
  /** The editor's string brown. */
  string: string;
  /** The console's error color. */
  danger: string;
  /** The diagnostics' warning yellow. */
  warning: string;
  /** Not one of the site's: it has no success color. */
  success: string;
  selection: string;
}

const theme = (name: string, type: "light" | "dark", p: Palette): SvelteTheme => ({
  name,
  type,
  colors: {
    "editor.foreground": p.code,
    "editor.background": p.bg,
    "editor.selectionBackground": p.selection,
    "editorCursor.foreground": p.muted,
    "editorLineNumber.foreground": p.faint,
    "sideBar.background": p.panel,
    "panel.border": p.border,
    focusBorder: p.accent,
    "textLink.foreground": p.accent,
    "editorError.foreground": p.danger,
    "editorWarning.foreground": p.warning,
    "editorInfo.foreground": p.keyword,
    "terminal.ansiBlack": type === "light" ? p.text : p.panel,
    "terminal.ansiRed": p.danger,
    "terminal.ansiGreen": p.success,
    "terminal.ansiYellow": p.warning,
    "terminal.ansiBlue": p.keyword,
    "terminal.ansiMagenta": p.accent,
    "terminal.ansiCyan": p.keyword,
    "terminal.ansiWhite": p.muted,
    "terminal.ansiBrightBlack": p.faint,
  },
  tokenColors: [
    { scope: ["comment"], settings: { foreground: p.faint } },
    { scope: ["keyword", "storage"], settings: { foreground: p.keyword } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: p.fn } },
    { scope: ["string"], settings: { foreground: p.string } },
    { scope: ["constant.numeric"], settings: { foreground: p.fn } },
    { scope: ["entity.name.tag", "entity.name.type", "support.type", "support.class"], settings: { foreground: p.fn } },
    { scope: ["entity.other.attribute-name", "variable.other.property", "punctuation", "keyword.operator"], settings: { foreground: p.code } },
  ],
  zed: {
    name,
    appearance: type,
    style: {
      "editor.foreground": p.code,
      "editor.background": p.bg,
      players: [{ selection: p.selection }],
      syntax: {
        comment: { color: p.faint },
        keyword: { color: p.keyword },
        function: { color: p.fn },
        string: { color: p.string },
        "string.escape": { color: p.fn },
        "string.regex": { color: p.string },
        number: { color: p.fn },
        boolean: { color: p.keyword },
        constant: { color: p.code },
        tag: { color: p.fn },
        type: { color: p.fn },
        constructor: { color: p.fn },
        attribute: { color: p.code },
        property: { color: p.code },
        operator: { color: p.code },
        punctuation: { color: p.code },
      },
    },
  },
});

export const svelteLight = theme("svelte-light", "light", {
  bg: "#ffffff",
  panel: "#fafafa",
  border: "#ebebeb",
  code: "#262626",
  text: "#141414",
  muted: "#666666",
  // The site's fg-4 is #808080, 3.9:1 on white; the next gray down reads at 4.5:1, for comments too.
  faint: "#737373",
  accent: "#d43008",
  keyword: "#0074c2",
  fn: "#d43008",
  string: "#994d00",
  danger: "#da106e",
  // The diagnostics' #fc6 is a background; text needs a darker amber.
  warning: "#946200",
  success: "#2e7d32",
  selection: "#42b4ff4d",
});
export const svelteDark = theme("svelte-dark", "dark", {
  bg: "#1c1e22",
  panel: "#23272f",
  border: "#303541",
  code: "#c4c1bb",
  text: "#e5e5e6",
  muted: "#a1a4aa",
  faint: "#8c8c8c",
  accent: "#f96743",
  keyword: "#57b5f4",
  fn: "#eab095",
  string: "#ccb88f",
  danger: "#eb4e6d",
  warning: "#ffaa00",
  success: "#7cc88a",
  selection: "#42b4ff4d",
});

/**
 * What the chrome takes from the site beyond the theme's colors: the page behind the panes (`bg-4` in light, `bg-0`
 * in dark), the muted text as it has it and its small radius (`--sk-border-radius`). Not its fonts (Fira Sans, Fira
 * Mono): every theme has the same fonts, so picking one moves nothing. A host that wants them names them in its
 * hosting file (`theme.fonts`, `theme.vars`), as hosting/svelte.json does.
 */
const SHAPE = { "--radius": "4px" };
export const SVELTE_THEME_VARS: Record<string, Record<string, string>> = {
  "svelte-light": { ...SHAPE, "--canvas": "#f2f2f2", "--border": "#ebebeb", "--muted": "#666666" },
  "svelte-dark": { ...SHAPE, "--canvas": "#17191c", "--border": "#303541", "--muted": "#a1a4aa" },
};

/** The pair as a theme family: selecting `svelte-light` selects `svelte-dark` for dark mode too. */
export const svelteThemes = createThemeCollection({
  themes: [
    createTheme({
      name: "svelte-light",
      displayName: "Svelte Light",
      collection: "Svelte",
      colorScheme: "light",
      load: async () => svelteLight,
    }),
    createTheme({
      name: "svelte-dark",
      displayName: "Svelte Dark",
      collection: "Svelte",
      colorScheme: "dark",
      load: async () => svelteDark,
    }),
  ],
});
