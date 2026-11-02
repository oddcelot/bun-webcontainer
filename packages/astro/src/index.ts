// runbun(): the Astro integration. It serves the blocks' stylesheet (their look plus every configured theme's
// colors) and hands its options to <Code>, <Playground> and the fence plugin (@runbun/astro/remark).
import type { AstroIntegration } from "astro";
import { setConfig } from "./config.js";
import { BLOCK_CSS, themeCss, type ThemeOption } from "./highlight.js";
import { CSS_PATH } from "./markup.js";

export type { ThemeOption };

export interface RunbunOptions {
  /** Where the playground lives; embeds load `<playgroundUrl>embed.js` and frame `<playgroundUrl>embed`. Default `https://runbun.dev/`. */
  playgroundUrl?: string;
  /** The code themes blocks can wear. Default `["pierre-light", "pierre-dark"]`. */
  themes?: ThemeOption[];
  /**
   * The CSS selector each theme's colors go under, for a site with its own theme switch (e.g. ``({ name }) =>
   * `:root[data-code-theme='${name}']` ``). Without it the first light theme applies, and the first dark one under
   * `prefers-color-scheme: dark`.
   */
  themeSelector?: (theme: { name: string; appearance: string }) => string;
  /**
   * Keep embeds in the page's scheme and theme family: the `<html>` attributes that hold them (`scheme` says `light`
   * or `dark`). Without it embeds follow the OS.
   */
  sync?: { scheme?: string; family?: string };
}

const VIRTUAL = "virtual:@runbun/astro/config";

export default function runbun(options: RunbunOptions = {}): AstroIntegration {
  const { playgroundUrl = "https://runbun.dev/", themes = ["pierre-light", "pierre-dark"], themeSelector, sync } = options;
  return {
    name: "@runbun/astro",
    hooks: {
      "astro:config:setup": ({ config, injectRoute, updateConfig }) => {
        const base = config.base ?? "/";
        const resolved = { playgroundUrl, base, sync };
        setConfig(resolved);
        const css = BLOCK_CSS + "\n" + themeCss(themes, themeSelector);
        const source = `export const config = ${JSON.stringify(resolved)};\nexport const css = ${JSON.stringify(css)};\n`;
        updateConfig({
          vite: {
            plugins: [
              {
                name: "@runbun/astro:config",
                resolveId: (id: string) => (id === VIRTUAL ? "\0" + VIRTUAL : undefined),
                load: (id: string) => (id === "\0" + VIRTUAL ? source : undefined),
              },
            ],
          },
        });
        injectRoute({ pattern: "/" + CSS_PATH, entrypoint: new URL("./route.js", import.meta.url), prerender: true });
      },
    },
  };
}
