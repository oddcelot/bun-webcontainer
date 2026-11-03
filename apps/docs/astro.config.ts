// @ts-check
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import solid from "@astrojs/solid-js";
import starlight from "@astrojs/starlight";
import runbun from "@runbun/astro";
import remarkRunbun from "@runbun/astro/remark";
import UnoCSS from "unocss/astro";
import { codeThemeOptions, codeThemes } from "./src/code-themes.ts";
import remarkStatus from "./src/remark-status.ts";
import { DOCS_URL, PLAYGROUND_URL } from "./site-urls.ts";

export default defineConfig({
  site: DOCS_URL,
  markdown: { processor: unified({ remarkPlugins: [remarkRunbun, remarkStatus] }) },
  integrations: [
    // The playground's tokens and theme families (uno.config.ts); no reset, Starlight brings its own.
    UnoCSS({ injectReset: false }),
    // Solid 2 islands (.tsx). @astrojs/solid-js is the vendored v8 in packages/astro-solid until it is on npm.
    solid(),
    // Runnable fences and <Code> blocks, in every family's code theme (data-code-theme, components/ThemeProvider.astro);
    // embeds follow the page's scheme and family.
    runbun({
      playgroundUrl: PLAYGROUND_URL,
      themes: codeThemeOptions,
      themeSelector: ({ name }) => `:root[data-code-theme='${name}']`,
      sync: { scheme: "data-theme", family: "data-family" },
    }),
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
        Banner: "./src/components/Banner.astro",
        Footer: "./src/components/Footer.astro",
      },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/oddcelot/bun-webcontainer" },
      ],
      editLink: { baseUrl: "https://github.com/oddcelot/bun-webcontainer/edit/main/apps/docs/" },
      // Starlight sets the title, description, canonical, og:url and twitter:card per page; the share image is the
      // playground's card (apps/playground/public/og.png), so links to the docs preview like links to the playground.
      head: [
        { tag: "meta", attrs: { property: "og:image", content: `${PLAYGROUND_URL}og.png` } },
        { tag: "meta", attrs: { property: "og:image:type", content: "image/png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "Bun's logo next to the words: Bun in your browser" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${PLAYGROUND_URL}og.png` } },
        { tag: "meta", attrs: { name: "twitter:site", content: "@oddcelot" } },
      ],
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
