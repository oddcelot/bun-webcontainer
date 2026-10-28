import { resolveTheme, type DiffsTheme } from "@pierre/diffs";
import { colorUtils, normalizeThemeColors } from "@pierre/theming/color";
import { themes } from "@pierre/theming/themes";
import { bundledThemesInfo } from "shiki/themes";

// One theme (any Pierre or Shiki theme) colors the editor, the file tree and the app chrome.
const KEY = "theme";
const VARS_KEY = "theme-vars";
const DEFAULT = "pierre-dark";

let name = themes.getThemeNames().includes(localStorage.getItem(KEY) ?? "") ? localStorage.getItem(KEY)! : DEFAULT;
let resolved: DiffsTheme | undefined;
const listeners = new Set<(name: string, theme: DiffsTheme) => void>();

/** App chrome variables (see style.css); unset ones fall back to mixes of --bg and --fg. */
function chromeVars(theme: DiffsTheme): Record<string, string | undefined> {
  const c = normalizeThemeColors(theme).colors ?? {};
  const bg = c["editor.background"] ?? theme.bg;
  const fg = c["editor.foreground"] ?? theme.fg;
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

export const themeName = () => name;

/** Calls `fn` with the current theme once it's resolved, and again on every change. */
export function onTheme(fn: (name: string, theme: DiffsTheme) => void) {
  listeners.add(fn);
  if (resolved) fn(name, resolved);
}

export async function setTheme(next: string) {
  name = next;
  const theme = await resolveTheme(next);
  if (name !== next) return; // a later pick won
  resolved = theme;
  const vars = chromeVars(theme);
  applyVars(vars);
  localStorage.setItem(KEY, next);
  localStorage.setItem(VARS_KEY, JSON.stringify(vars));
  for (const fn of listeners) fn(next, theme);
}

/** Fills `select` with every theme (Pierre's, then Shiki's dark and light ones) and switches on change. */
export function mountThemePicker(select: HTMLSelectElement) {
  const shikiNames = new Map(bundledThemesInfo.map((t) => [t.id, t.displayName]));
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const t of themes.getThemes()) {
    const label = t.collection === "pierre" ? "Pierre" : t.colorScheme === "light" ? "Light" : "Dark";
    let group = groups.get(label);
    if (!group) groups.set(label, (group = Object.assign(document.createElement("optgroup"), { label })));
    group.append(new Option(t.displayName ?? shikiNames.get(t.name) ?? t.name, t.name));
  }
  select.replaceChildren(...groups.values());
  select.value = name;
  select.onchange = () => setTheme(select.value);
}

setTheme(name);
