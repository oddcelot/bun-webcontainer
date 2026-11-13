import { defineConfig, presetIcons, presetMini } from "unocss";
import { uiPreset } from "@runbun/ui/uno.preset";
import { STATUS } from "./src/status.ts";

// The playground's tokens (@runbun/ui, packages/ui/uno.preset.ts; styles/theme.css sets their colors to the kitchen's),
// utilities over them, and the playground's icons (`i-lucide-<name>`).
export default defineConfig({
  presets: [uiPreset(), presetMini({ preflight: false }), presetIcons({ mode: "mask" })],
  // The status icons appear only in HTML that remark-status.ts writes, which UnoCSS doesn't scan.
  safelist: Object.values(STATUS).map((s) => s.icon),
});
