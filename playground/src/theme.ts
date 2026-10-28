import { createThemeCatalog, createThemeController, type ColorMode, type ThemeLike } from "@pierre/theming";
import { colorUtils, normalizeThemeColors } from "@pierre/theming/color";
import { themes } from "@pierre/theming/themes";

// A color mode (system/light/dark) plus a theme family; the family's variant for the scheme in
// effect colors the editor, the file tree and the app chrome.
const VARS_KEY = "theme-vars";

/** Themes that come in both schemes: [name, light variant, dark variant]. */
const FAMILIES: Record<string, [string, string, string][]> = {
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
let applied: ThemeLike | undefined;

/** The theme name for the scheme in effect (`system` resolved against the OS). */
export function themeName() {
  const s = controller.getState();
  return s.resolvedColorScheme === "light" ? s.lightThemeName : s.darkThemeName;
}

/** App chrome variables (see style.css); unset ones fall back to mixes of --bg and --fg. */
function chromeVars(theme: ThemeLike): Record<string, string | undefined> {
  const c = normalizeThemeColors(theme).colors ?? {};
  const bg = c["editor.background"] ?? theme.bg ?? "";
  const fg = c["editor.foreground"] ?? theme.fg ?? "";
  const panel = c["sideBar.background"];
  // Many themes (pierre-dark too) draw borders in a surface color; those would vanish here.
  let border: string | undefined = c["panel.border"] ?? c["sideBar.border"] ?? c["editorGroup.border"];
  if (border && [bg, panel].some((s) => s && colorUtils.surfacesMatch(border, s))) border = undefined;
  return {
    "color-scheme": theme.type,
    "--bg": bg,
    "--fg": fg,
    "--panel": panel,
    "--border": border,
    "--muted": colorUtils.deriveMutedFg(fg, bg),
    "--accent": c["focusBorder"] ?? c["button.background"],
    "--error": c["terminal.ansiRed"] ?? c["editorError.foreground"],
    "--warn": c["terminal.ansiYellow"] ?? c["editorWarning.foreground"],
    "--info": c["terminal.ansiBlue"] ?? c["editorInfo.foreground"],
  };
}

function applyVars(vars: Record<string, string | undefined>) {
  const style = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) v ? style.setProperty(k, v) : style.removeProperty(k);
}

// The last theme's variables, so the page doesn't flash the defaults while the theme loads.
try {
  applyVars(JSON.parse(localStorage.getItem(VARS_KEY) ?? "{}"));
} catch {}

function sync() {
  const { resolvedTheme, pendingThemeResolution } = controller.getState();
  if (!resolvedTheme || pendingThemeResolution || resolvedTheme === applied) return;
  applied = resolvedTheme;
  const vars = chromeVars(resolvedTheme);
  applyVars(vars);
  localStorage.setItem(VARS_KEY, JSON.stringify(vars));
  for (const fn of listeners) fn(themeName(), resolvedTheme);
}
controller.subscribe(sync);
sync();

/** Calls `fn` with the current theme once it's resolved, and again on every change. */
export function onTheme(fn: (name: string, theme: ThemeLike) => void) {
  listeners.add(fn);
  if (applied) fn(themeName(), applied);
}

const MODES: [ColorMode, string, string][] = [
  ["system", "i-lucide-monitor", "System"],
  ["light", "i-lucide-sun", "Light"],
  ["dark", "i-lucide-moon", "Dark"],
];

/** A system/light/dark toggle into `modes`, and the theme families into `select`. */
export function mountThemePicker(modes: HTMLElement, select: HTMLSelectElement) {
  const buttons = MODES.map(([mode, icon, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = `${label} color scheme`;
    b.setAttribute("aria-label", b.title);
    b.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`;
    b.onclick = () => controller.setColorMode(mode);
    return b;
  });
  modes.replaceChildren(...buttons);

  const families = Object.values(FAMILIES).flat();
  select.replaceChildren(
    ...Object.entries(FAMILIES).map(([label, list]) => {
      const group = Object.assign(document.createElement("optgroup"), { label });
      group.append(...list.map(([name, light]) => new Option(name, light)));
      return group;
    }),
  );
  let picking = false;
  const pick = (light: string) => {
    const [, , dark] = families.find((f) => f[1] === light)!;
    picking = true; // the pair is half-set between the two calls
    controller.setThemeNameForScheme("light", light);
    picking = false;
    controller.setThemeNameForScheme("dark", dark);
  };
  select.onchange = () => pick(select.value);

  const render = () => {
    if (picking) return;
    const { mode, lightThemeName, darkThemeName } = controller.getState();
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(MODES[i][0] === mode)));
    const family = families.find((f) => f[1] === lightThemeName && f[2] === darkThemeName);
    // A saved pair that isn't a family (e.g. from an older version): fall back to the light side's family, or Pierre.
    if (!family) return pick(families.find((f) => f[1] === lightThemeName)?.[1] ?? "pierre-light");
    select.value = family[1];
  };
  controller.subscribe(render);
  render();
}
