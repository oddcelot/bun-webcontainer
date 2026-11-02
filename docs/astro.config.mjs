// @ts-check
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import remarkPlayground from "./src/remark-playground.mjs";
import { DOCS_URL, PLAYGROUND_URL } from "./site-urls.mjs";

export default defineConfig({
  site: DOCS_URL,
  markdown: { processor: unified({ remarkPlugins: [[remarkPlayground, { playgroundUrl: PLAYGROUND_URL }]] }) },
  integrations: [
    starlight({
      title: "Bun Playground",
      description: "Bun in the browser: what runs, where, and how.",
      logo: { src: "./src/favicon.svg" },
      favicon: "/favicon.svg",
      // The playground's look: shared tokens, then Starlight's colors mapped onto them.
      customCss: ["../ui/tokens.css", "./src/styles/theme.css"],
      // The code themes the playground's editor uses, so a runnable block's poster matches the embed it turns into.
      expressiveCode: {
        themes: [pierreDark, pierreLight],
        styleOverrides: { borderRadius: "var(--radius)", borderColor: "var(--border)" },
      },
      components: { SocialIcons: "./src/components/SocialIcons.astro" },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/oddcelot/bun-webcontainer" },
      ],
      editLink: { baseUrl: "https://github.com/oddcelot/bun-webcontainer/edit/main/docs/" },
      sidebar: [
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Compatibility", items: [{ autogenerate: { directory: "compatibility" } }] },
        { label: "Privacy", link: "/privacy/" },
      ],
    }),
  ],
});
