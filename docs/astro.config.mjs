// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { DOCS_URL, PLAYGROUND_URL } from "./site-urls.mjs";

export default defineConfig({
  site: DOCS_URL,
  integrations: [
    starlight({
      title: "Bun Playground",
      description: "Bun in the browser: what runs, where, and how.",
      logo: { src: "./src/favicon.svg" },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/oddcelot/bun-webcontainer" },
        { icon: "external", label: "Playground", href: PLAYGROUND_URL },
      ],
      editLink: { baseUrl: "https://github.com/oddcelot/bun-webcontainer/edit/main/docs/" },
      sidebar: [
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Compatibility", items: [{ autogenerate: { directory: "compatibility" } }] },
      ],
    }),
  ],
});
