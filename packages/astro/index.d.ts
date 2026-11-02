import type { AstroIntegration } from "astro";

/** A bundled @pierre/highlights theme's name (`pierre-dark`), a Zed theme, or a VS Code theme (`{ name, type, tokenColors }`). */
export type ThemeOption = string | { name: string; [key: string]: unknown };

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

export default function runbun(options?: RunbunOptions): AstroIntegration;
