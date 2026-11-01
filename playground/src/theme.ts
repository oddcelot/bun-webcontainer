import { createThemeCatalog, createThemeController, type ColorMode, type ThemeLike } from "@pierre/theming";
import { themes } from "@pierre/theming/themes";
import type { Vars } from "./embed/protocol";
import { THEME_VARS, elysiaThemes } from "./elysiaTheme";
import { FAMILIES, chromeVars, withRealColors } from "./themeColors";

export { FAMILIES };

// A color mode (system/light/dark) plus a theme family; the family's variant for the scheme in
// effect colors the editor, the file tree and the app chrome.
const VARS_KEY = "theme-vars";
/**
 * An embed (embed.html marks its <html>) takes its theme from the host and keeps it to itself: runbun.dev shares its
 * storage with embeds on docs.runbun.dev, so an embed saving its theme would change the playground's.
 */
export const EMBEDDED = "embed" in document.documentElement.dataset;

const controller = createThemeController({
  catalog: createThemeCatalog({
    themes: [themes, elysiaThemes],
    defaultLightThemeName: "pierre-light",
    defaultDarkThemeName: "pierre-dark",
  }),
  defaultMode: "system",
  storageKey: EMBEDDED ? undefined : "theme-selection",
});
const listeners = new Set<(name: string, theme: ThemeLike) => void>();
let source: ThemeLike | undefined;
let applied: ThemeLike | undefined;

/** CSS custom properties the host sets (the embed's `vars`): on both schemes, or on one. */
type VarSet = Record<string, string>;
let customVars: { base: VarSet; light: VarSet; dark: VarSet } = { base: {}, light: {}, dark: {} };
const VAR_NAME = /^--[a-z0-9-]+$/i;

function cleanVars(vars: unknown): VarSet {
  if (!vars || typeof vars !== "object") return {};
  return Object.fromEntries(
    Object.entries(vars).filter(([name, value]) => VAR_NAME.test(name) && typeof value === "string"),
  ) as VarSet;
}

/** Sets the host's chrome variables; the theme's own run first, so these win. */
export function setThemeVars(vars: Vars | undefined) {
  customVars = {
    base: cleanVars(vars?.base),
    light: cleanVars(vars?.light),
    dark: cleanVars(vars?.dark),
  };
  applyChrome();
}

/** The theme's own variables: its chrome colors, plus what its family declares (e.g. Elysia's overlay). */
const themeVarsFor = (theme: ThemeLike) => ({ ...chromeVars(theme), ...THEME_VARS[themeName()] });

/**
 * `?vars=`: the embed's `vars` shape, limited to the overlay. Other chrome variables feed `background` too, and a
 * shared link must not be able to put a remote image (`url()`, `image-set()`, …) over the page, so values may only
 * call color and gradient functions; `\` is rejected since CSS escapes spell any name (`u\72l(`).
 */
const URL_VARS = new Set(["--overlay", "--overlay-ring"]);
const URL_FUNCTIONS = new Set(
  "linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark calc".split(" "),
);
const urlValue = (v: unknown) =>
  typeof v === "string" &&
  v.length <= 2000 &&
  !v.includes("\\") &&
  !v.includes("/*") &&
  // Every `(` must open an allowed function: a bare one, or one after a name `\w` can't spell, fails too.
  [...v.matchAll(/([\w-]*)\s*\(/g)].every(([, name]) => URL_FUNCTIONS.has(name.toLowerCase()));

export function urlVars(raw: string | null): Vars | undefined {
  let vars: unknown;
  try {
    vars = JSON.parse(raw ?? "");
  } catch {
    return;
  }
  if (!vars || typeof vars !== "object") return;
  const pick = (set: unknown) =>
    set && typeof set === "object"
      ? Object.fromEntries(Object.entries(set).filter(([k, v]) => URL_VARS.has(k) && urlValue(v)))
      : {};
  const { base, light, dark } = vars as Vars;
  return { base: pick(base), light: pick(light), dark: pick(dark) };
}

function chromeVarsFor(theme: ThemeLike) {
  const { resolvedColorScheme } = controller.getState();
  return { ...themeVarsFor(theme), ...customVars.base, ...customVars[resolvedColorScheme] };
}

/** The theme name for the scheme in effect (`system` resolved against the OS). */
export function themeName() {
  const s = controller.getState();
  return s.resolvedColorScheme === "light" ? s.lightThemeName : s.darkThemeName;
}

let appliedVars = new Set<string>();
function applyVars(vars: Record<string, string | undefined>) {
  const style = document.documentElement.style;
  // A host's variable that's gone (or a theme that no longer sets one) must not linger from the last sync.
  for (const k of appliedVars) if (!(k in vars)) style.removeProperty(k);
  appliedVars = new Set();
  for (const [k, v] of Object.entries(vars)) {
    if (v) {
      style.setProperty(k, v);
      appliedVars.add(k);
    } else style.removeProperty(k);
  }
  // Mobile browser chrome matches the header.
  const panel = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
  if (panel) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", panel);
}

// The last theme's variables, so the page doesn't flash the defaults while the theme loads.
try {
  if (!EMBEDDED) applyVars(JSON.parse(localStorage.getItem(VARS_KEY) ?? "{}"));
} catch {}

function applyChrome() {
  if (!applied) return;
  applyVars(chromeVarsFor(applied));
  // Only the theme's: the host's or a URL's variables must not carry over to the next visit (or first paint).
  if (!EMBEDDED) localStorage.setItem(VARS_KEY, JSON.stringify(themeVarsFor(applied)));
}

function sync() {
  const { resolvedTheme, pendingThemeResolution } = controller.getState();
  if (!resolvedTheme || pendingThemeResolution || resolvedTheme === source) return;
  source = resolvedTheme;
  applied = withRealColors(resolvedTheme);
  applyChrome();
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
  // Other tabs' previews follow the playground's mode, not an embed's.
  if (!EMBEDDED) previewScheme.postMessage(mode);
});

/** Calls `fn` with the current theme once it's resolved, and again on every change. Returns the unsubscribe. */
export function onTheme(fn: (name: string, theme: ThemeLike) => void) {
  listeners.add(fn);
  if (applied) fn(themeName(), applied);
  return () => void listeners.delete(fn);
}

const families = Object.values(FAMILIES).flat();

// Every family's themes into the controller's cache once the page is idle: a cached theme applies in the same call,
// so picking or previewing one in the theme picker shows at once instead of waiting for its module to load.
// An embed has no theme picker.
if (!EMBEDDED) (window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1000)))(() => {
  controller.resolver.resolveThemes(families.flatMap(([, light, dark]) => [light, dark])).catch(() => {});
});

/** True for a theme family's light variant (what `pickFamily` takes). */
export const isFamily = (light: string) => families.some((f) => f[1] === light);

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
        { duration: 250, easing: "linear", fill: "forwards", pseudoElement: "::view-transition-new(root)" },
      );
      transition.finished.finally(() => reveal.cancel());
    })
    .catch(() => {}); // skipped transitions (e.g. a second switch mid-animation) still apply the change
}
