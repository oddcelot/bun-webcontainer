import { readFileSync } from "node:fs";
import { defineConfig, presetIcons, presetMini } from "unocss";
import { uiPreset } from "@runbun/ui/uno.preset";

// The shared tokens (@runbun/ui, packages/ui/uno.preset.ts), utilities over them (`bg-panel`, `text-muted`, `rounded-pane`), and icons:
// `i-lucide-<name>` is a CSS mask over currentColor. Product logos come from `i-logos-<name>`; add `?bg` to keep their
// colors (the default mask draws them in currentColor, for the black ones a dark theme would hide; Astro's flame goes
// over its mask in color, style.css).
// `i-runbun-<name>` are logos the logos set lacks or draws badly: src/icons/<name>.svg (elysia: skill-icons' fox off its
// tile; sqlite: devicon's feather, which has no wordmark squeezed beside it; both MIT).
const icon = (name: string) => readFileSync(new URL(`./src/icons/${name}.svg`, import.meta.url), "utf8");

export default defineConfig({
  presets: [uiPreset(), presetMini({ preflight: false }), presetIcons({ mode: "mask", collections: { runbun: { elysia: icon("elysia"), sqlite: icon("sqlite") } } })],
  content: { pipeline: { include: [/\.(html|tsx?)($|\?)/] } },
});
