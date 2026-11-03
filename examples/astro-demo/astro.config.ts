// The setup @runbun/astro's README shows, with every option at its default. PLAYGROUND_URL points embeds at another
// playground (`PLAYGROUND_URL=http://localhost:5173/` for the dev server) to try a change to the element.
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import runbun from "@runbun/astro";
import remarkRunbun from "@runbun/astro/remark";

export default defineConfig({
  integrations: [runbun({ playgroundUrl: process.env.PLAYGROUND_URL })],
  markdown: { processor: unified({ remarkPlugins: [remarkRunbun] }) },
});
