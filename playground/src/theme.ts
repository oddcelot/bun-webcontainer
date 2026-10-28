import { createThemeCatalog, createThemeController, type ColorMode, type ThemeLike } from "@pierre/theming";
import { colorUtils, normalizeThemeColors } from "@pierre/theming/color";
import { themes } from "@pierre/theming/themes";
import { bundledThemesInfo } from "shiki/themes";

// A color mode (system/light/dark) plus one theme per scheme; the active theme (any Pierre or Shiki
// theme) colors the editor, the file tree and the app chrome.
const VARS_KEY = "theme-vars";

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

/**
 * A system/light/dark toggle into `modes`, and into `select` the themes for the scheme in effect
 * (Pierre's first). Picking one sets it for that scheme.
 */
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

  const shikiNames = new Map(bundledThemesInfo.map((t) => [t.id, t.displayName]));
  let shown: string | undefined;
  const render = () => {
    const { mode, resolvedColorScheme: scheme } = controller.getState();
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(MODES[i][0] === mode)));
    if (scheme !== shown) {
      shown = scheme;
      const groups = new Map<string, HTMLOptGroupElement>();
      for (const t of themes.getThemes({ colorScheme: scheme })) {
        const label = t.collection === "pierre" ? "Pierre" : "Shiki";
        let group = groups.get(label);
        if (!group) groups.set(label, (group = Object.assign(document.createElement("optgroup"), { label })));
        group.append(new Option(t.displayName ?? shikiNames.get(t.name) ?? t.name, t.name));
      }
      select.replaceChildren(...groups.values());
      select.title = `${scheme === "light" ? "Light" : "Dark"} theme`;
    }
    select.value = themeName();
  };
  select.onchange = () => controller.setThemeNameForScheme(controller.getState().resolvedColorScheme, select.value);
  controller.subscribe(render);
  render();
}
