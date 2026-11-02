// runbun(): the Astro integration. It serves the blocks' stylesheet (their look plus every configured theme's
// colors) and hands its options to <Code>, <Playground> and the fence plugin (@runbun/astro/remark).
import { setConfig } from "./config.js";
import { BLOCK_CSS, themeCss } from "./highlight.js";
import { CSS_PATH } from "./markup.js";

const VIRTUAL = "virtual:@runbun/astro/config";

/** @param {import("./index").RunbunOptions} [options] */
export default function runbun(options = {}) {
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
                resolveId: (id) => (id === VIRTUAL ? "\0" + VIRTUAL : undefined),
                load: (id) => (id === "\0" + VIRTUAL ? source : undefined),
              },
            ],
          },
        });
        injectRoute({ pattern: "/" + CSS_PATH, entrypoint: new URL("./route.js", import.meta.url), prerender: true });
      },
    },
  };
}
