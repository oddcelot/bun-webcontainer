import { defineConfig, presetIcons, presetMini } from "unocss";
import { uiPreset } from "../ui/uno.preset";

// The playground's tokens with every theme family's colors (ui/uno.preset.ts), utilities over them, and the
// playground's icons (`i-lucide-<name>`).
export default defineConfig({
  presets: [uiPreset({ families: true }), presetMini({ preflight: false }), presetIcons({ mode: "mask" })],
});
