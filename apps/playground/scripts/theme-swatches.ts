// Theme data that can't be read in the page, where themes load lazily. Rerun after changing FAMILIES or a theme:
//   bun scripts/theme-swatches.ts
// Writes:
// - packages/ui/themes.json: the families and every theme's chrome colors, for the shared UnoCSS preset (packages/ui/uno.preset.ts)
//   and the swatches (packages/ui/solid/Swatch.tsx: a family's --bg and --accent per scheme).
// - packages/ui/code-themes/*.json: the code themes the docs' highlighter can't load by name (Elysia's; Pierre Vibrant's in
//   sRGB, since it rejects display-p3).
import { themes } from "@pierre/theming/themes";
import { elysiaLight, elysiaDark } from "../src/elysiaTheme";
import { solidLight, solidDark } from "../src/solidTheme";
import { FAMILIES, chromeVars, withRealColors } from "../src/themeColors";

const own: Record<string, unknown> = { "elysia-light": elysiaLight, "elysia-dark": elysiaDark, "solid-light": solidLight, "solid-dark": solidDark };
const load = async (name: string): Promise<any> => {
  if (own[name]) return own[name];
  const theme = await themes.getTheme(name);
  if (!theme) throw new Error(`no theme ${name}`);
  return theme.load();
};

/** Chrome variables that fall back to mixes of --bg and --fg when a theme doesn't set them (as in style.css). */
const MIXES: Record<string, string> = {
  "--border": "color-mix(in srgb, var(--fg) 14%, var(--bg))",
  "--muted": "color-mix(in srgb, var(--fg) 60%, var(--bg))",
};
/** Pierre's status colors, for themes without terminal colors. */
const STATUS = {
  dark: { "--error": "#ff2e3f", "--warn": "#ffca00", "--info": "#009fff", "--ok": "#0dbe4e" },
  light: { "--error": "#d52c36", "--warn": "#d5a910", "--info": "#1a85d4", "--ok": "#18a46c" },
};

/** Every chrome variable for one theme: its own, else the fallbacks the playground's style.css would use. */
function chrome(theme: any): Record<string, string> {
  const vars = chromeVars(withRealColors(theme));
  const scheme = vars["color-scheme"] === "light" ? "light" : "dark";
  const out: Record<string, string> = { "color-scheme": scheme };
  for (const name of ["--bg", "--fg", "--panel", "--border", "--muted", "--accent", "--error", "--warn", "--info", "--ok"])
    out[name] = vars[name] || (STATUS[scheme] as Record<string, string>)[name] || MIXES[name] || "";
  out["--panel"] ||= out["--bg"];
  out["--accent"] ||= out["--fg"];
  return out;
}

// --- display-p3 to sRGB (the docs' highlighter wants hex colors).

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const P3_TO_SRGB = [
  [1.2249401, -0.2249404, 0],
  [-0.0420569, 1.0420571, 0],
  [-0.0196376, -0.0786361, 1.0982735],
];
function p3ToHex(css: string): string {
  const m = /^color\(display-p3\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(css.trim());
  if (!m) return css;
  const lin = [m[1], m[2], m[3]].map((v) => toLinear(Number(v)));
  const rgb = P3_TO_SRGB.map((row) => fromLinear(Math.min(1, Math.max(0, row[0]! * lin[0]! + row[1]! * lin[1]! + row[2]! * lin[2]!))));
  const hex = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  const alpha = m[4] === undefined ? "" : hex(m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]));
  return `#${rgb.map(hex).join("")}${alpha}`;
}
/** A copy of a theme with every display-p3 color in sRGB hex, and no color replacements. */
const inSrgb = (theme: any) =>
  JSON.parse(JSON.stringify(withRealColors(theme)), (key, value) =>
    key === "colorReplacements" ? undefined : typeof value === "string" ? p3ToHex(value) : value,
  );

// --- Write.

const chromeByTheme: Record<string, Record<string, string>> = {};
const families: { group: string; name: string; light: string; dark: string }[] = [];
for (const [group, list] of Object.entries(FAMILIES)) {
  for (const [name, light, dark] of list) {
    families.push({ group, name, light, dark });
    for (const theme of [light, dark]) chromeByTheme[theme] = chrome(await load(theme));
  }
}

await Bun.write(new URL("../../../packages/ui/themes.json", import.meta.url), JSON.stringify({ families, chrome: chromeByTheme }, null, 2) + "\n");
for (const name of ["elysia-light", "elysia-dark", "pierre-light-vibrant", "pierre-dark-vibrant"])
  await Bun.write(new URL(`../../../packages/ui/code-themes/${name}.json`, import.meta.url), JSON.stringify(inSrgb(await load(name))) + "\n");
console.log(`${families.length} families, ${Object.keys(chromeByTheme).length} themes`);
