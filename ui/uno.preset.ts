// The design tokens the playground and the docs share, as a UnoCSS preset: the CSS variables (as a preflight) and
// theme entries that point at them, so utilities like `bg-panel` or `text-muted` work wherever a utility preset is on.
// Plain data, no imports from node_modules: both apps load it by relative path. The colors come from themes.json, which
// the playground's scripts/theme-swatches.ts writes.
import themes from "./themes.json";

type Vars = Record<string, string>;
export type Family = { group: string; name: string; light: string; dark: string };
export const FAMILIES: Family[] = themes.families;
const CHROME: Record<string, Vars> = themes.chrome;
/** The family pages start in, by its light variant. */
export const DEFAULT_FAMILY = "pierre-light";

/** Tokens that don't depend on the theme; colors other than the chrome's derive from it. */
const BASE: Vars = {
  "--font-ui": "system-ui, sans-serif",
  "--font-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  "--control": "color-mix(in srgb, var(--fg) 9%, var(--panel))",
  "--control-hover": "color-mix(in srgb, var(--fg) 16%, var(--panel))",
  "--control-border": "color-mix(in srgb, var(--fg) 18%, var(--panel))",
  // Behind the panes: a step from the panel toward the text color, so the cards (--bg) stand apart in either scheme.
  "--canvas": "color-mix(in srgb, var(--fg) 7%, var(--panel))",
  // Nested corners are concentric: an inner corner is the outer one minus the padding between them.
  "--radius": "12px",
  "--pad": "6px",
  "--inner-radius": "calc(var(--radius) - var(--pad))",
  // Every control in a bar is this tall, whatever its padding, font or border.
  "--control-height": "28px",
  "--scrollbar": "color-mix(in srgb, var(--fg) 22%, transparent)",
  "--scrollbar-hover": "color-mix(in srgb, var(--fg) 38%, transparent)",
};

const block = (selector: string, vars: Vars) =>
  `${selector}{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;

/**
 * The token CSS. `:root` gets Pierre Dark and the base tokens; `[data-theme="light"]` (the docs' light scheme)
 * Pierre Light. With `families`, `[data-family="<light variant>"]` picks a family's colors for each scheme.
 */
export function tokensCss({ families = false } = {}): string {
  const [light, dark] = [CHROME["pierre-light"]!, CHROME["pierre-dark"]!];
  const css = [block(":root", { ...BASE, ...dark }), block(':root[data-theme="light"]', light)];
  if (families)
    for (const f of FAMILIES) {
      css.push(block(`:root[data-family="${f.light}"]:not([data-theme="light"])`, CHROME[f.dark]!));
      css.push(block(`:root[data-family="${f.light}"][data-theme="light"]`, CHROME[f.light]!));
    }
  return css.join("\n");
}

const v = (name: string) => `var(--${name})`;

/** The preset. `families: true` adds every family's colors (the docs; the playground sets them at runtime). */
export function uiPreset(options: { families?: boolean } = {}) {
  return {
    name: "bun-playground-ui",
    theme: {
      colors: {
        bg: v("bg"),
        fg: v("fg"),
        panel: v("panel"),
        canvas: v("canvas"),
        border: v("border"),
        muted: v("muted"),
        accent: v("accent"),
        error: v("error"),
        warn: v("warn"),
        info: v("info"),
        ok: v("ok"),
        control: { DEFAULT: v("control"), hover: v("control-hover"), border: v("control-border") },
      },
      fontFamily: { ui: v("font-ui"), mono: v("font-mono") },
      borderRadius: { pane: v("radius"), inner: v("inner-radius"), control: "6px" },
    },
    preflights: [{ getCSS: () => tokensCss(options) }],
  };
}
