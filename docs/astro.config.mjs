// @ts-check
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import UnoCSS from "unocss/astro";
import { codeThemes } from "./src/code-themes.mjs";
import remarkPlayground from "./src/remark-playground.mjs";
import { DOCS_URL, PLAYGROUND_URL } from "./site-urls.mjs";

export default defineConfig({
  site: DOCS_URL,
  markdown: { processor: unified({ remarkPlugins: [[remarkPlayground, { playgroundUrl: PLAYGROUND_URL }]] }) },
  integrations: [
    // The playground's tokens and theme families (uno.config.ts); no reset, Starlight brings its own.
    UnoCSS({ injectReset: false }),
    starlight({
      title: "Run Bun",
      description: "Bun in the browser: what runs, where, and how.",
      logo: { src: "./src/favicon.svg" },
      favicon: "/favicon.svg",
      // Starlight's colors mapped onto the playground's tokens (which UnoCSS adds).
      customCss: ["./src/styles/theme.css"],
      // Every family's code themes; the page picks one with data-code-theme (components/ThemeProvider.astro), so a
      // runnable block's poster matches the embed it turns into.
      expressiveCode: {
        themes: codeThemes,
        useStarlightDarkModeSwitch: false,
        themeCssSelector: (theme) => `[data-code-theme='${theme.name}']`,
        styleOverrides: { borderRadius: "var(--radius)", borderColor: "var(--border)" },
      },
      components: {
        SocialIcons: "./src/components/SocialIcons.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        PageTitle: "./src/components/PageTitle.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/oddcelot/bun-webcontainer" },
      ],
      editLink: { baseUrl: "https://github.com/oddcelot/bun-webcontainer/edit/main/docs/" },
      sidebar: [
        // The home page is the overview, first among the guides.
        { label: "Guides", items: [{ label: "Overview", link: "/" }, { autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Compatibility", items: [{ autogenerate: { directory: "compatibility" } }] },
        { label: "Privacy", link: "/privacy/" },
      ],
    }),
  ],
});
