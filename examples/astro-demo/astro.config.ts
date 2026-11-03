// The setup @runbun/astro's README shows, with every option at its default.
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import runbun from "@runbun/astro";
import remarkRunbun from "@runbun/astro/remark";

export default defineConfig({
  integrations: [runbun()],
  markdown: { processor: unified({ remarkPlugins: [remarkRunbun] }) },
});
