// Four looks for one embed (guides/embedding.mdx, Theme): a family for the code's colors, `vars` for the chrome, and
// the page's own CSS for the frame around it. ElementThemes.astro renders them live and the guide prints their
// snippets, both from this data, so what a reader copies is what they see.

type Palette = Record<"--bg" | "--panel" | "--fg" | "--muted" | "--border" | "--accent", string>;
export type Look = {
  name: string;
  /** A theme family by its light variant: the syntax colors. */
  family: string;
  /** No `'` in a value: the snippet puts `vars` in a single-quoted attribute. */
  base: Record<string, string>;
  light: Palette;
  dark: Palette;
  /** The two stops of the gradient behind the panes (`--canvas`) and on the poster, per scheme. */
  gradient: { light: [string, string]; dark: [string, string] };
  /** The frame the page draws around the element. */
  radius: string;
  shadow: string;
  /** Lines of at most 34 characters: the grid's cells are narrow, and the editor doesn't wrap. */
  code: string;
};

/** The same program in every look, so only the look differs; each prints its own symbol. */
const sample = (symbol: string) => `for (const n of [1, 2, 3]) {\n  console.log("${symbol}".repeat(n));\n}`;

export const LOOKS: Look[] = [
  {
    name: "Fire",
    family: "horizon-bright",
    base: { "--radius": "0", "--font-ui": "system-ui, sans-serif" },
    light: { "--bg": "#fff4ec", "--panel": "#ffe6d5", "--fg": "#4a1608", "--muted": "#a8573a", "--border": "#f3a57e", "--accent": "#e8390e" },
    dark: { "--bg": "#1c0d0a", "--panel": "#2a120c", "--fg": "#ffe3c9", "--muted": "#c98a6b", "--border": "#5a2414", "--accent": "#ff6a1f" },
    gradient: { light: ["#ffd9a8", "#ff9d8a"], dark: ["#2b0a05", "#7a2208"] },
    radius: "0",
    shadow: "0 0 0 2px light-dark(#e8390e, #ff6a1f), 0 0 28px -2px light-dark(#ff8a4c, #ff4d00)",
    code: sample("🔥"),
  },
  {
    name: "Wind",
    family: "min-light",
    base: { "--radius": "1.25rem", "--font-ui": "system-ui, sans-serif" },
    light: { "--bg": "#fbfdfd", "--panel": "#f4f8f9", "--fg": "#33464d", "--muted": "#86a0a8", "--border": "#dbe7ea", "--accent": "#2f8799" },
    dark: { "--bg": "#20282c", "--panel": "#1b2326", "--fg": "#dfeaec", "--muted": "#8aa1a8", "--border": "#2f3b40", "--accent": "#9fdbe6" },
    gradient: { light: ["#eef8fa", "#cfdff5"], dark: ["#1a2b31", "#2c2f4a"] },
    radius: "1.5rem",
    shadow: "0 0 0 1px light-dark(#dbe7ea, #2f3b40), 0 18px 36px -20px light-dark(#7fa9b3, #000)",
    code: sample("💨"),
  },
  {
    name: "Earth",
    family: "everforest-light",
    base: { "--radius": "3px", "--font-ui": "system-ui, sans-serif" },
    light: { "--bg": "#f6f0dc", "--panel": "#ebe0c2", "--fg": "#3b2f1e", "--muted": "#7d6b4c", "--border": "#c9b88c", "--accent": "#5f7a2e" },
    dark: { "--bg": "#2a241a", "--panel": "#231d14", "--fg": "#e9dfc4", "--muted": "#a39676", "--border": "#4a3f2b", "--accent": "#a3b85a" },
    gradient: { light: ["#eadfae", "#c3d096"], dark: ["#33270f", "#1f3319"] },
    radius: "4px",
    shadow: "0 0 0 3px light-dark(#6b5433, #8a7448), 7px 7px 0 0 light-dark(#c9b88c, #14100a)",
    code: sample("🌱"),
  },
  {
    name: "Water",
    family: "night-owl-light",
    base: { "--radius": "0.75rem", "--font-ui": "system-ui, sans-serif" },
    light: { "--bg": "#f2f9ff", "--panel": "#e0f0fd", "--fg": "#0b2c4a", "--muted": "#5580a3", "--border": "#a9d0f0", "--accent": "#0a7fd6" },
    dark: { "--bg": "#06182b", "--panel": "#0a2038", "--fg": "#d6ecff", "--muted": "#6f9ac0", "--border": "#15385c", "--accent": "#3fb6ff" },
    gradient: { light: ["#c3ecff", "#a9c2ff"], dark: ["#03243f", "#101456"] },
    radius: "1rem",
    shadow: "0 0 0 2px light-dark(#a9d0f0, #15385c), 0 16px 32px -14px light-dark(#0a7fd6, #0059b3)",
    code: sample("💧"),
  },
];

const ANGLE = "160deg";
export const gradient = (a: string, b: string) => `linear-gradient(${ANGLE}, ${a}, ${b})`;

/** The `vars` attribute: the palettes, with the gradient as `--canvas` (a `background`, so any image works). */
export const vars = ({ base, light, dark, gradient: g }: Look) => ({
  base,
  light: { ...light, "--canvas": gradient(...g.light) },
  dark: { ...dark, "--canvas": gradient(...g.dark) },
});

/**
 * The frame, and the poster (what the element shows until the embed is ready, or until a click with `load="click"`)
 * in the look's colors: its code over the same gradient, and the Run button as the look's accent.
 */
export const frame = (l: Look) => {
  const both = (name: keyof Palette) => `light-dark(${l.light[name]}, ${l.dark[name]})`;
  return [
    `border-radius: ${l.radius}`,
    `overflow: hidden`,
    `box-shadow: ${l.shadow}`,
    `--poster-bg: ${gradient(`light-dark(${l.gradient.light[0]}, ${l.gradient.dark[0]})`, `light-dark(${l.gradient.light[1]}, ${l.gradient.dark[1]})`)}`,
    `--poster-fg: ${both("--fg")}`,
    `--play-bg: ${both("--accent")}`,
    `--play-fg: ${both("--bg")}`,
    `--play-border: ${both("--accent")}`,
    `--play-radius: ${l.base["--radius"]}`,
    `--play-font: 600 0.875rem ${l.base["--font-ui"]}`,
  ];
};

const row = (o: Record<string, string>) => `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
const indent = (s: string, by: string) => s.split("\n").map((line) => by + line).join("\n");

/** What a reader copies for a look: the element as the first grid renders it (the second adds `load="click"`). */
export const snippet = (l: Look) => `<bun-playground
  mode="code"
  family="${l.family}"
  vars='{
    "base": ${row(l.base)},
    "light": ${row(vars(l).light)},
    "dark": ${row(vars(l).dark)}
  }'
  style="
${indent(frame(l).join(";\n") + ";", "    ")}
  "
>
  <script type="text/plain" data-file="index.ts">
${indent(l.code, "    ")}
  </script>
</bun-playground>`;
