// Four looks for one embed (guides/embedding.mdx, Theme): a family for the code's colors, `vars` for the chrome, and
// the page's own CSS for the frame around it. ElementThemes.astro renders them live and the guide prints their
// snippets, both from this data, so what a reader copies is what they see.

type Palette = Record<"--bg" | "--canvas" | "--panel" | "--fg" | "--muted" | "--border" | "--accent", string>;
export type Look = {
  name: string;
  /** A theme family by its light variant: the syntax colors. */
  family: string;
  /** No `'` in a value: the snippet puts `vars` in a single-quoted attribute. */
  base: Record<string, string>;
  light: Palette;
  dark: Palette;
  /** The frame the page draws around the element. */
  radius: string;
  shadow: string;
  /** Lines of at most 34 characters: the grid's cells are narrow, and the editor doesn't wrap. */
  code: string;
};

export const LOOKS: Look[] = [
  {
    name: "Fire",
    family: "horizon-bright",
    base: { "--radius": "0", "--font-ui": "system-ui, sans-serif" },
    light: { "--bg": "#fff4ec", "--canvas": "#ffd9c2", "--panel": "#ffe6d5", "--fg": "#4a1608", "--muted": "#a8573a", "--border": "#f3a57e", "--accent": "#e8390e" },
    dark: { "--bg": "#1c0d0a", "--canvas": "#120706", "--panel": "#2a120c", "--fg": "#ffe3c9", "--muted": "#c98a6b", "--border": "#5a2414", "--accent": "#ff6a1f" },
    radius: "0",
    shadow: "0 0 0 2px light-dark(#e8390e, #ff6a1f), 0 0 28px -2px light-dark(#ff8a4c, #ff4d00)",
    code: `for (const n of [1, 2, 3]) {\n  console.log("🔥".repeat(n));\n}`,
  },
  {
    name: "Wind",
    family: "min-light",
    base: { "--radius": "1.25rem", "--font-ui": "system-ui, sans-serif" },
    light: { "--bg": "#fbfdfd", "--canvas": "#eef4f5", "--panel": "#f4f8f9", "--fg": "#33464d", "--muted": "#86a0a8", "--border": "#dbe7ea", "--accent": "#2f8799" },
    dark: { "--bg": "#20282c", "--canvas": "#171d20", "--panel": "#1b2326", "--fg": "#dfeaec", "--muted": "#8aa1a8", "--border": "#2f3b40", "--accent": "#9fdbe6" },
    radius: "1.5rem",
    shadow: "0 0 0 1px light-dark(#dbe7ea, #2f3b40), 0 18px 36px -20px light-dark(#7fa9b3, #000)",
    code: `const knots = [4, 12, 28, 48];\nfor (const k of knots) {\n  console.log(k, "~".repeat(k / 4));\n}`,
  },
  {
    name: "Earth",
    family: "everforest-light",
    base: { "--radius": "3px", "--font-ui": "system-ui, sans-serif" },
    light: { "--bg": "#f6f0dc", "--canvas": "#e3d6b3", "--panel": "#ebe0c2", "--fg": "#3b2f1e", "--muted": "#7d6b4c", "--border": "#c9b88c", "--accent": "#5f7a2e" },
    dark: { "--bg": "#2a241a", "--canvas": "#1d1811", "--panel": "#231d14", "--fg": "#e9dfc4", "--muted": "#a39676", "--border": "#4a3f2b", "--accent": "#a3b85a" },
    radius: "4px",
    shadow: "0 0 0 3px light-dark(#6b5433, #8a7448), 7px 7px 0 0 light-dark(#c9b88c, #14100a)",
    code: `const dig = "soil clay rock";\ndig.split(" ").forEach((s, d) => {\n  console.log("  ".repeat(d) + s);\n});`,
  },
  {
    name: "Water",
    family: "night-owl-light",
    base: { "--radius": "0.75rem", "--font-ui": "system-ui, sans-serif" },
    light: { "--bg": "#f2f9ff", "--canvas": "#cfe6fa", "--panel": "#e0f0fd", "--fg": "#0b2c4a", "--muted": "#5580a3", "--border": "#a9d0f0", "--accent": "#0a7fd6" },
    dark: { "--bg": "#06182b", "--canvas": "#030e1c", "--panel": "#0a2038", "--fg": "#d6ecff", "--muted": "#6f9ac0", "--border": "#15385c", "--accent": "#3fb6ff" },
    radius: "1rem",
    shadow: "0 0 0 2px light-dark(#a9d0f0, #15385c), 0 16px 32px -14px light-dark(#0a7fd6, #0059b3)",
    code: `const tide = [0.4, 1.9, 3.1, 1.2];\nfor (const m of tide) {\n  console.log(m, "≈".repeat(m * 4));\n}`,
  },
];

export const vars = ({ base, light, dark }: Look) => ({ base, light, dark });

/**
 * The frame, and the poster (what the element shows until the embed is ready, or until a click with `load="click"`)
 * in the look's colors: its code, and the Run button as the look's accent.
 */
export const frame = (l: Look) => {
  const both = (name: keyof Palette) => `light-dark(${l.light[name]}, ${l.dark[name]})`;
  return [
    `border-radius: ${l.radius}`,
    `overflow: hidden`,
    `box-shadow: ${l.shadow}`,
    `--poster-bg: ${both("--bg")}`,
    `--poster-fg: ${both("--fg")}`,
    `--play-bg: ${both("--accent")}`,
    `--play-fg: ${both("--bg")}`,
    `--play-border: ${both("--accent")}`,
    `--play-radius: ${l.base["--radius"]}`,
    `--play-font: 600 0.875rem ${l.base["--font-ui"]}`,  ];
};

const row = (o: Record<string, string>) => `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
const indent = (s: string, by: string) => s.split("\n").map((line) => by + line).join("\n");

/** What a reader copies for a look: the element as the grid renders it. `load="click"` is the grid of posters. */
export const snippet = (l: Look, load?: "click") => `<bun-playground
  mode="code"${load ? `\n  load="${load}"` : ""}
  family="${l.family}"
  vars='{
    "base": ${row(l.base)},
    "light": ${row(l.light)},
    "dark": ${row(l.dark)}
  }'
  style="
${indent(frame(l).join(";\n") + ";", "    ")}
  "
>
  <script type="text/plain" data-file="index.ts">
${indent(l.code, "    ")}
  </script>
</bun-playground>`;
