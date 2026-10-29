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
function chromeVars(theme: ThemeLike): Record<string, string | undefined> {
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
  for (const resolve of appliedWaiters.splice(0)) resolve();
}

const appliedWaiters: (() => void)[] = [];
/** Resolves once the theme the controller asks for is applied (themes load lazily), or right away if it is. */
function themeApplied(timeout = 1500): Promise<void> {
  const { resolvedTheme, pendingThemeResolution } = controller.getState();
  if (!pendingThemeResolution && resolvedTheme === source) return Promise.resolve();
  return new Promise((resolve) => {
    appliedWaiters.push(resolve);
    setTimeout(resolve, timeout); // a theme that never loads doesn't hold the page
  });
}
controller.subscribe(sync);
sync();

// Preview pages follow the mode (previewColorScheme in sw.js). The ones in this page's iframes switch right away,
// so a theme view transition captures them in the new mode (a channel message arrives too late for that); the
// channel reaches the rest, e.g. a preview opened in its own tab.
const previewScheme = new BroadcastChannel("bun-color-scheme");
let mode = controller.getState().mode;
controller.subscribe(() => {
  if (controller.getState().mode === mode) return;
  mode = controller.getState().mode;
  for (const frame of document.querySelectorAll("iframe")) {
    try {
      (frame.contentWindow as (Window & { __bunColorScheme?: (mode: string) => void }) | null)?.__bunColorScheme?.(mode);
    } catch {} // not a preview (another origin)
  }
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
export const themeState = () => controller.getState();
/** Calls `next` with the current theme state, then on every change. Returns the unsubscribe. */
export const watchTheme = (next: (s: ThemeState) => void) => {
  next(controller.getState());
  return controller.subscribe(() => next(controller.getState()));
};
export const setColorMode = (mode: ColorMode) => controller.setColorMode(mode);

/** The mask's shape (bun-mask.svg, the logo's outline): its aspect, and where the body's middle sits in it. */
const MASK = { aspect: 66.25 / 76, cx: 38 / 76, cy: 35.7 / 66.25 };
/**
 * How wide the mask must be for the bun to cover the window from (x, y). The body is close to an ellipse with
 * half-axes of 0.49 × width across and 0.45 × height below the middle (above, it reaches further), with a margin.
 */
function coverWidth(x: number, y: number) {
  const a = 0.49;
  const b = 0.45 * MASK.aspect;
  const corners = [
    [x, y],
    [innerWidth - x, y],
    [x, innerHeight - y],
    [innerWidth - x, innerHeight - y],
  ];
  return 1.1 * Math.max(...corners.map(([dx, dy]) => Math.hypot(dx / a, dy / b)));
}

/**
 * Runs a theme change (a color mode or family pick) as a view transition: the new colors reveal in the shape of the
 * Bun logo, growing at a steady pace from the middle of the window until it covers it. Without View Transitions, or
 * with reduced motion, the change applies at once.
 */
export function switchTheme(change: () => void) {
  if (!("startViewTransition" in document) || matchMedia("(prefers-reduced-motion: reduce)").matches) return change();
  const transition = document.startViewTransition(async () => {
    change();
    await themeApplied();
    // A microtask for Solid to render the picker's new state. Not a frame: requestAnimationFrame doesn't fire
    // while the browser waits for this callback, so awaiting one stalls the transition until its 4s timeout.
    // What repaints later (the editor) still shows up: the new side of the transition is live.
    await Promise.resolve();
  });
  const mx = innerWidth / 2;
  const my = innerHeight / 2;
  const w = coverWidth(mx, my);
  const h = w * MASK.aspect;
  // style.css gives the new layer the mask while this class is on.
  document.documentElement.classList.add("theme-switch");
  transition.finished.finally(() => document.documentElement.classList.remove("theme-switch"));
  transition.ready
    .then(() => {
      const reveal = document.documentElement.animate(
        {
          maskSize: ["0px 0px", `${w}px ${h}px`],
          // The body's middle stays on the window's middle as it grows.
          maskPosition: [`${mx}px ${my}px`, `${mx - MASK.cx * w}px ${my - MASK.cy * h}px`],
        },
        // `forwards`: the transition is torn down a frame after the animation ends, and without it the mask falls
        // back to style.css's 0 size for that frame, flashing the old theme. Cancelled once the transition is
        // done, or the filled animation would outlive it and override the next switch's mask.
        { duration: 400, easing: "linear", fill: "forwards", pseudoElement: "::view-transition-new(root)" },
      );
      transition.finished.finally(() => reveal.cancel());
    })
    .catch(() => {}); // skipped transitions (e.g. a second switch mid-animation) still apply the change
}
