import { defineConfig, presetIcons } from "unocss";

// Icons only (no utility preset): `i-lucide-<name>` is a CSS mask over currentColor.
export default defineConfig({
  presets: [presetIcons({ mode: "mask" })],
  content: { pipeline: { include: [/\.(html|tsx?)($|\?)/] } },
});
