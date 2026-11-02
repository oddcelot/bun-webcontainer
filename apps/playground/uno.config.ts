import { defineConfig, presetIcons, presetMini } from "unocss";
import { uiPreset } from "../../ui/uno.preset";

// The shared tokens (ui/uno.preset.ts), utilities over them (`bg-panel`, `text-muted`, `rounded-pane`), and icons:
// `i-lucide-<name>` is a CSS mask over currentColor.
export default defineConfig({
  presets: [uiPreset(), presetMini({ preflight: false }), presetIcons({ mode: "mask" })],
  content: { pipeline: { include: [/\.(html|tsx?)($|\?)/] } },
});
