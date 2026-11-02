// The code themes of every playground theme family, for Expressive Code, so a runnable block's poster matches the
// embed it turns into whatever family the reader picks. Pierre's come from @pierre/theme, Elysia's and Pierre
// Vibrant's (in sRGB) from ui/code-themes/, the rest are Shiki's bundled themes, loaded by name.
import { readFileSync } from "node:fs";
import themes from "../../ui/themes.json" with { type: "json" };

const FILES = new Set(["elysia-light", "elysia-dark", "pierre-light-vibrant", "pierre-dark-vibrant"]);
const json = (name) => JSON.parse(readFileSync(new URL(`../../ui/code-themes/${name}.json`, import.meta.url), "utf8"));

async function load(name) {
  if (FILES.has(name)) return json(name);
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
