import type { ThemeLike } from "@pierre/theming";
import { colorUtils, normalizeThemeColors } from "@pierre/theming/color";

// Theme families and the chrome colors derived from a theme. No DOM here: scripts/theme-swatches.ts runs it too.

/** Themes that come in both schemes: [name, light variant, dark variant]. */
export const FAMILIES: Record<string, [string, string, string][]> = {
  Elysia: [["Elysia", "elysia-light", "elysia-dark"]],
  Pierre: [
    ["Pierre", "pierre-light", "pierre-dark"],
    ["Pierre Soft", "pierre-light-soft", "pierre-dark-soft"],
    ["Pierre Vibrant", "pierre-light-vibrant", "pierre-dark-vibrant"],
    ["Pierre Protanopia & Deuteranopia", "pierre-light-protanopia-deuteranopia", "pierre-dark-protanopia-deuteranopia"],
    ["Pierre Tritanopia", "pierre-light-tritanopia", "pierre-dark-tritanopia"],
  ],
  Shiki: [
    ["Ayu", "ayu-light", "ayu-dark"],
    ["Catppuccin", "catppuccin-latte", "catppuccin-mocha"],
    ["Everforest", "everforest-light", "everforest-dark"],
    ["GitHub", "github-light", "github-dark"],
    ["GitHub Default", "github-light-default", "github-dark-default"],
    ["GitHub High Contrast", "github-light-high-contrast", "github-dark-high-contrast"],
    ["Gruvbox Hard", "gruvbox-light-hard", "gruvbox-dark-hard"],
    ["Gruvbox Medium", "gruvbox-light-medium", "gruvbox-dark-medium"],
    ["Gruvbox Soft", "gruvbox-light-soft", "gruvbox-dark-soft"],
    ["Horizon", "horizon-bright", "horizon"],
    ["Kanagawa", "kanagawa-lotus", "kanagawa-wave"],
    ["Material", "material-theme-lighter", "material-theme"],
    ["Min", "min-light", "min-dark"],
    ["Night Owl", "night-owl-light", "night-owl"],
    ["One", "one-light", "one-dark-pro"],
    ["Rosé Pine", "rose-pine-dawn", "rose-pine"],
    ["Slack", "slack-ochin", "slack-dark"],
    ["Solarized", "solarized-light", "solarized-dark"],
    ["Visual Studio", "light-plus", "dark-plus"],
    ["Vitesse", "vitesse-light", "vitesse-dark"],
  ],
};

/**
 * Shiki swaps colors it can't use as-is (`color(display-p3 ...)` in the Pierre Vibrant themes) for
 * placeholders like `#00000001` and keeps the real ones in `colorReplacements`; the UI wants the real ones.
 */
export function withRealColors(theme: ThemeLike & { colorReplacements?: Record<string, string> }): ThemeLike {
  const map = theme.colorReplacements;
  if (!map) return theme;
  // Only strings: some themes carry other values (github-dark-high-contrast has an array of colors for
  // symbolIcon.constantForeground), and a throw here keeps the theme from applying at all.
  const real = (v: unknown) => (typeof v === "string" && map[v.toLowerCase()]) || v;
  const colors = Object.fromEntries(Object.entries(theme.colors ?? {}).map(([k, v]) => [k, real(v) as string]));
  return { ...theme, fg: real(theme.fg) as string | undefined, bg: real(theme.bg) as string | undefined, colors };
}

const isHex = (v: string | undefined) => !!v && /^#[0-9a-f]{3,8}$/i.test(v);

type Rgba = [r: number, g: number, b: number, a: number];
/** #rgb(a), #rrggbb(aa) or color(display-p3 r g b [/ a]) (read as sRGB: close enough to judge contrast). */
function parseColor(c: string): Rgba | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((h) => h + h).join("") : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), full.length === 8 ? n(6) : 1];
  }
  const p3 = /^color\(display-p3\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(c);
  return p3 ? [+p3[1], +p3[2], +p3[3], p3[4] ? +p3[4] : 1] : null;
}
const over = ([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
const luminance = ([r, g, b]: Rgba) => {
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The accent for selection marks and focus rings: the first of the theme's candidate colors that stands out (3:1,
 * WCAG's bar for UI parts) on a pressed control, which style.css colors `--control-hover` (16% fg into the panel);
 * else the one that stands out most. Many themes use a focus border or button color close to their panel (Min Light, Gruvbox, Kanagawa
 * Lotus), which made the pressed color-scheme toggle unreadable.
 */
function readableAccent(candidates: (string | undefined)[], panel: string, fg: string): string | undefined {
  const usable = candidates.filter((v): v is string => !!v && !colorUtils.isFullyTransparent(v));
  const [base, text] = [parseColor(panel), parseColor(fg)];
  if (!base || !text) return usable[0];
  const pressed = over([...text.slice(0, 3), 0.16] as Rgba, base);
  const scored = [...usable, fg].flatMap((v) => {
    const rgba = parseColor(v);
    return rgba ? [{ v, ratio: contrast(over(rgba, pressed), pressed) }] : [];
  });
  return (scored.find((s) => s.ratio >= 3) ?? scored.sort((a, b) => b.ratio - a.ratio)[0])?.v ?? usable[0];
}

/** App chrome variables (see style.css); unset ones fall back to mixes of --bg and --fg. */
export function chromeVars(theme: ThemeLike): Record<string, string | undefined> {
  const c = normalizeThemeColors(theme).colors ?? {};
  const bg = c["editor.background"] ?? theme.bg ?? "";
  const fg = c["editor.foreground"] ?? theme.fg ?? "";
  // The sidebar color is the chrome's panel, unless the editor text doesn't read on it (Slack Ochin pairs a dark
  // sidebar with black text): then the panel is the editor background. (Unset, it would be style.css's dark default.)
  const sidebar = c["sideBar.background"];
  const [sidebarRgba, fgRgba] = [sidebar && parseColor(sidebar), parseColor(fg)];
  const panel = sidebarRgba && fgRgba && contrast(fgRgba, sidebarRgba) < 3 ? bg : sidebar;
  // Many themes (pierre-dark too) draw borders in a surface color; those would vanish here.
  let border: string | undefined = c["panel.border"] ?? c["sideBar.border"] ?? c["editorGroup.border"];
  if (border && [bg, panel].some((s) => s && (s === border || colorUtils.surfacesMatch(border, s)))) border = undefined;
  return {
    "color-scheme": theme.type,
    "--bg": bg,
    "--fg": fg,
    "--panel": panel,
    "--border": border,
    // The color math reads hex only; other colors get style.css's mix.
    "--muted": isHex(fg) && isHex(bg) ? colorUtils.deriveMutedFg(fg, bg) : undefined,
    "--accent": readableAccent(
      [c["focusBorder"], c["button.background"], c["textLink.foreground"], c["terminal.ansiBlue"], c["editorCursor.foreground"]],
      panel ?? bg,
      fg,
    ),
    "--error": c["terminal.ansiRed"] ?? c["editorError.foreground"],
    "--warn": c["terminal.ansiYellow"] ?? c["editorWarning.foreground"],
    "--info": c["terminal.ansiBlue"] ?? c["editorInfo.foreground"],
    "--ok": c["terminal.ansiGreen"] ?? c["gitDecoration.addedResourceForeground"],
  };
}
