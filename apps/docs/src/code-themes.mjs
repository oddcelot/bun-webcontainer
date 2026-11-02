// The code themes of every playground theme family, for Expressive Code, so a runnable block's poster matches the
// embed it turns into whatever family the reader picks. Pierre's come from @pierre/theme, Elysia's and Pierre
// Vibrant's (in sRGB) from @runbun/ui (packages/ui/code-themes/), the rest are Shiki's bundled themes, loaded by name.
import elysiaDark from "@runbun/ui/code-themes/elysia-dark.json" with { type: "json" };
import elysiaLight from "@runbun/ui/code-themes/elysia-light.json" with { type: "json" };
import pierreDarkVibrant from "@runbun/ui/code-themes/pierre-dark-vibrant.json" with { type: "json" };
import pierreLightVibrant from "@runbun/ui/code-themes/pierre-light-vibrant.json" with { type: "json" };
import themes from "@runbun/ui/themes.json" with { type: "json" };

const FILES = {
  "elysia-light": elysiaLight,
  "elysia-dark": elysiaDark,
  "pierre-light-vibrant": pierreLightVibrant,
  "pierre-dark-vibrant": pierreDarkVibrant,
};
// A copy each time, as when they were read from disk: Expressive Code and highlights may adjust the objects.
const json = (name) => structuredClone(FILES[name]);

async function load(name) {
  if (name in FILES) return json(name);
  if (name.startsWith("pierre-")) return (await import(`@pierre/theme/${name}`)).default;
  return name;
}

/** Pierre Dark first: Expressive Code's base theme, which the others are declared against. */
const names = ["pierre-dark", ...themes.families.flatMap((f) => [f.dark, f.light]).filter((n) => n !== "pierre-dark")];
export const codeThemes = await Promise.all(names.map(load));

/** The same themes for @runbun/astro: highlights bundles all but Elysia's, which go in as their VS Code JSON. */
export const codeThemeOptions = [...new Set(themes.families.flatMap((f) => [f.dark, f.light]))].map((n) =>
  n.startsWith("elysia-") ? json(n) : n,
);
