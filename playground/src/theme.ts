import { createThemeCatalog, createThemeController, type ColorMode, type ThemeLike } from "@pierre/theming";
import { colorUtils, normalizeThemeColors } from "@pierre/theming/color";
import { themes } from "@pierre/theming/themes";

// A color mode (system/light/dark) plus a theme family; the family's variant for the scheme in
// effect colors the editor, the file tree and the app chrome.
const VARS_KEY = "theme-vars";

/** Themes that come in both schemes: [name, light variant, dark variant]. */
export const FAMILIES: Record<string, [string, string, string][]> = {
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

const controller = createThemeController({
  catalog: createThemeCatalog({ themes, defaultLightThemeName: "pierre-light", defaultDarkThemeName: "pierre-dark" }),
  defaultMode: "system",
  storageKey: "theme-selection",
});
const listeners = new Set<(name: string, theme: ThemeLike) => void>();
let source: ThemeLike | undefined;
let applied: ThemeLike | undefined;

/** The theme name for the scheme in effect (`system` resolved against the OS). */
export function themeName() {
  const s = controller.getState();
  return s.resolvedColorScheme === "light" ? s.lightThemeName : s.darkThemeName;
}

/**
 * Shiki swaps colors it can't use as-is (`color(display-p3 ...)` in the Pierre Vibrant themes) for
 * placeholders like `#00000001` and keeps the real ones in `colorReplacements`; the UI wants the real ones.
 */
function withRealColors(theme: ThemeLike & { colorReplacements?: Record<string, string> }): ThemeLike {
  const map = theme.colorReplacements;
  if (!map) return theme;
  const real = (v: string | undefined) => (v && map[v.toLowerCase()]) || v;
  const colors = Object.fromEntries(Object.entries(theme.colors ?? {}).map(([k, v]) => [k, real(v)!]));
  return { ...theme, fg: real(theme.fg), bg: real(theme.bg), colors };
}

const isHex = (v: string | undefined) => !!v && /^#[0-9a-f]{3,8}$/i.test(v);

/** App chrome variables (see style.css); unset ones fall back to mixes of --bg and --fg. */
function chromeVars(theme: ThemeLike): Record<string, string | undefined> {
  const c = normalizeThemeColors(theme).colors ?? {};
  const bg = c["editor.background"] ?? theme.bg ?? "";
  const fg = c["editor.foreground"] ?? theme.fg ?? "";
  const panel = c["sideBar.background"];
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
    "--accent": [c["focusBorder"], c["button.background"]].find((v) => v && !colorUtils.isFullyTransparent(v)),
    "--error": c["terminal.ansiRed"] ?? c["editorError.foreground"],
    "--warn": c["terminal.ansiYellow"] ?? c["editorWarning.foreground"],
    "--info": c["terminal.ansiBlue"] ?? c["editorInfo.foreground"],
    "--ok": c["terminal.ansiGreen"] ?? c["gitDecoration.addedResourceForeground"],
  };
}

function applyVars(vars: Record<string, string | undefined>) {
  const style = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) v ? style.setProperty(k, v) : style.removeProperty(k);
  // Mobile browser chrome matches the header.
  const panel = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
  if (panel) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", panel);
}

// The last theme's variables, so the page doesn't flash the defaults while the theme loads.
try {
  applyVars(JSON.parse(localStorage.getItem(VARS_KEY) ?? "{}"));
} catch {}

function sync() {
  const { resolvedTheme, pendingThemeResolution } = controller.getState();
  if (!resolvedTheme || pendingThemeResolution || resolvedTheme === source) return;
  source = resolvedTheme;
  applied = withRealColors(resolvedTheme);
  const vars = chromeVars(applied);
  applyVars(vars);
  localStorage.setItem(VARS_KEY, JSON.stringify(vars));
  for (const fn of listeners) fn(themeName(), applied);
}
controller.subscribe(sync);
sync();

// Preview pages follow the mode (previewColorScheme in sw.js).
const previewScheme = new BroadcastChannel("bun-color-scheme");
let mode = controller.getState().mode;
controller.subscribe(() => {
  if (controller.getState().mode === mode) return;
  mode = controller.getState().mode;
  previewScheme.postMessage(mode);
});

/** Calls `fn` with the current theme once it's resolved, and again on every change. Returns the unsubscribe. */
export function onTheme(fn: (name: string, theme: ThemeLike) => void) {
  listeners.add(fn);
  if (applied) fn(themeName(), applied);
  return () => void listeners.delete(fn);
}

const families = Object.values(FAMILIES).flat();

/** Sets both halves of a theme family, given its light variant. */
export function pickFamily(light: string) {
  const [, , dark] = families.find((f) => f[1] === light)!;
  controller.setThemeNameForScheme("light", light);
  controller.setThemeNameForScheme("dark", dark);
}

/** The family (by light variant) of the current pair, if it is one. */
export const familyOf = (s: { lightThemeName: string; darkThemeName: string }) =>
  families.find((f) => f[1] === s.lightThemeName && f[2] === s.darkThemeName)?.[1];

// A saved pair that isn't a family (e.g. from an older version): fall back to the light side's family, or Pierre.
if (!familyOf(controller.getState())) pickFamily(families.find((f) => f[1] === controller.getState().lightThemeName)?.[1] ?? "pierre-light");

export type ThemeState = ReturnType<typeof controller.getState>;
/** Theme state, for `from()`: emits the current state, then every change. */
export const watchTheme = (next: (s: ThemeState) => void) => {
  next(controller.getState());
  return controller.subscribe(() => next(controller.getState()));
};
export const setColorMode = (mode: ColorMode) => controller.setColorMode(mode);
