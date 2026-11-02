// The compatibility pages' status labels (compatibility/index.md): the emoji authors write, and the icon and color it
// renders as (remark-status.ts). The icons are the playground's lucide set, through UnoCSS (uno.config.ts).
export const STATUS = {
  "✅": { label: "Works", icon: "i-lucide-circle-check", tone: "ok" },
  "🟡": { label: "Partial", icon: "i-lucide-contrast", tone: "warn" },
  "⚪": { label: "Stub", icon: "i-lucide-circle-dashed", tone: "muted" },
  "❌": { label: "Missing", icon: "i-lucide-circle-x", tone: "error" },
  "❔": { label: "Untested", icon: "i-lucide-circle-help", tone: "muted" },
};
