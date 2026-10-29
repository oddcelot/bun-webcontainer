// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.runbun.dev",
  integrations: [
    starlight({
      title: "Bun Playground",
      description: "Bun in the browser: what runs, where, and how.",
      logo: { src: "./src/favicon.svg" },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/oddcelot/bun-webcontainer" },
        { icon: "external", label: "Playground", href: "https://runbun.dev" },
      ],
      editLink: { baseUrl: "https://github.com/oddcelot/bun-webcontainer/edit/main/docs/" },
      sidebar: [
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Compatibility", items: [{ autogenerate: { directory: "compatibility" } }] },
      ],
    }),
  ],
});
