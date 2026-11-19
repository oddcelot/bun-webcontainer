// @ts-check
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import solid from "@astrojs/solid-js";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import runbun from "@runbun/astro";
import remarkRunbun from "@runbun/astro/remark";
import UnoCSS from "unocss/astro";
import remarkExamples from "./src/remark-examples.ts";
import remarkStatus from "./src/remark-status.ts";
import { DOCS_URL, PLAYGROUND_URL } from "./site-urls.ts";

// The source repository, linked from the header (GitHub icon) and each page's "Edit page". It is private for now, so
// the links would 404 for readers: set REPO_PUBLIC to true once it is public.
const REPO = "https://github.com/oddcelot/bun-webcontainer";
const REPO_PUBLIC = false;

/** The code themes, dark first: Shiki's names. */
const CODE_THEMES = ["rose-pine", "rose-pine-dawn"] as const;

export default defineConfig({
  site: DOCS_URL,
  // `:where(.astro-HASH)`, as Starlight forced before 0.43: the overrides in src/components and styles/theme.css are
  // written against its zero specificity.
  scopedStyleStrategy: "where",
  // remarkExamples first: it hands each ````md example's result to remarkRunbun itself (with fences: "all").
  markdown: { processor: unified({ remarkPlugins: [remarkExamples, remarkRunbun, remarkStatus] }) },
  integrations: [
    // The playground's tokens and theme families (uno.config.ts); no reset, Starlight brings its own.
    UnoCSS({ injectReset: false }),
    // Solid 2 islands (.tsx). @astrojs/solid-js is the vendored v8 in packages/astro-solid until it is on npm.
    solid(),
    // Runnable fences and <Code> blocks, in Rosé Pine (Dawn by day), which suits the kitchen's palette; embeds follow
    // the page's scheme, and take the same family from the page's defaults (components/Footer.astro).
    runbun({
      playgroundUrl: PLAYGROUND_URL,
      themes: [...CODE_THEMES],
      themeSelector: ({ appearance }) => (appearance === "light" ? ":root[data-theme='light']" : ":root:not([data-theme='light'])"),
      sync: { scheme: "data-theme" },
    }),
    starlight({
      title: "Run Bun",
      description: "Bun in the browser: what runs, where, and how.",
      // /llms.txt, /llms-full.txt and /llms-small.txt: the docs as plain text for coding agents. The playground's own
      // llms.txt (apps/playground/public/llms.txt) points here for the details.
      plugins: [
        starlightLlmsTxt({
          projectName: "Run Bun",
          description:
            "Run Bun (runbun.dev) runs Bun in the browser: a playground and embeddable examples where `Bun.*`, `bun:*` and `node:*` code, `bun install` and `Bun.serve` run in the visitor's browser, with no server.",
          details: `- The playground is at ${PLAYGROUND_URL}. A project can be shared as a link that carries its files in the URL's hash; the guide "Reproduce a bug with an agent" shows how to build one.
- The compatibility pages say what works: each API or feature is marked Works, Partial, Stub, Missing or Untested.
- Code runs in the browser engine, not in Bun's JavaScriptCore, so some APIs behave differently or are missing; check the compatibility pages before assuming a Bun API works.`,
          promote: ["index*", "guides/**", "playground/**"],
        }),
      ],
      favicon: "/favicon.svg",
      // Starlight's colors mapped onto the playground's tokens (which UnoCSS adds).
      customCss: [
        "@fontsource/pixelify-sans/latin-600.css",
        "@fontsource/press-start-2p/latin-400.css",
        "@runbun/ui/css/retro.css",
        "./src/styles/theme.css",
      ],
      // The same pair as the runnable blocks, so a block's poster matches the embed it turns into. Starlight switches
      // them with its scheme: the dark one first.
      expressiveCode: {
        themes: [...CODE_THEMES],
        // Square corners; the pixel frame around each block is drawn in styles/theme.css.
        // And the kitchen's card behind the code, not the theme's own background.
        styleOverrides: {
          borderRadius: "0",
          borderColor: "transparent",
          codeBackground: "var(--code-bg)",
          frames: {
            editorBackground: "var(--code-bg)",
            terminalBackground: "var(--code-bg)",
            editorActiveTabBackground: "var(--code-bg)",
            editorTabBarBackground: "var(--panel)",
            terminalTitlebarBackground: "var(--panel)",
          },
        },
      },
      components: {
        SocialIcons: "./src/components/SocialIcons.astro",
        Sidebar: "./src/components/Sidebar.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        PageTitle: "./src/components/PageTitle.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
        Banner: "./src/components/Banner.astro",
        Footer: "./src/components/Footer.astro",
      },
      ...(REPO_PUBLIC
        ? { social: [{ icon: "github", label: "GitHub", href: REPO }], editLink: { baseUrl: `${REPO}/edit/main/apps/docs/` } }
        : {}),
      // Starlight sets the title, description, canonical, og:url and twitter:card per page; the share image is the
      // playground's card (apps/playground/public/og.png), so links to the docs preview like links to the playground.
      // ?v=: social sites cache a card's image by its URL, so a redrawn card needs a new one. Bump it here and in the
      // playground's index.html and configure.html when `bun run og` changes the picture.
      head: [
        { tag: "meta", attrs: { property: "og:image", content: `${PLAYGROUND_URL}og.png?v=2` } },
        { tag: "meta", attrs: { property: "og:image:type", content: "image/png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "A pixel-art kitchen counter with a dumpling in a bamboo steamer, under the words: Bun in your browser" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${PLAYGROUND_URL}og.png?v=2` } },
        { tag: "meta", attrs: { name: "twitter:site", content: "@oddcelot" } },
      ],
      sidebar: [
        // The home page is the overview, first among the guides.
        { label: "Guides", items: [{ label: "Overview", link: "/" }, { autogenerate: { directory: "guides" } }] },
        // What the playground does, area by area; guides/features.md is the tour that links into these.
        { label: "Playground", items: [{ autogenerate: { directory: "playground" } }] },
        { label: "Examples", items: [{ autogenerate: { directory: "examples" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Compatibility", items: [{ autogenerate: { directory: "compatibility" } }] },
        { label: "Compare", items: [{ autogenerate: { directory: "compare" } }] },
        { label: "Privacy", link: "/privacy/" },
      ],
    }),
  ],
});
