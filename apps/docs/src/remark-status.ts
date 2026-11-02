// Renders the status emojis (✅ 🟡 ⚪ ❌ ❔, see status.ts) in Markdown text as icons in the status colors. Only
// text is touched, never code. When the label follows ("✅ Works"), icon and label become one unit that doesn't wrap;
// on its own (a list item "✅ `.ts` files") the icon carries the label for screen readers.
import { STATUS } from "./status.ts";

const SOURCE = `(${Object.keys(STATUS).join("|")})\\uFE0F?`;
/** For split; `HAS` tests, since a global regex's test() carries lastIndex from one string to the next. */
const EMOJI = new RegExp(SOURCE, "g");
const HAS = new RegExp(SOURCE);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The icon's HTML, and how much of the text after it (the label, when it follows) it took in. */
function icon(emoji: keyof typeof STATUS, after: string) {
  const { label, icon, tone } = STATUS[emoji];
  const glyph = `<span class="${icon}" aria-hidden="true"></span>`;
  const m = new RegExp(`^\\s*${label}\\b`).exec(after);
  if (m) return { html: `<span class="status status-${tone}">${glyph}${esc(label)}</span>`, taken: m[0].length };
  return { html: `<span class="status status-${tone}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${glyph}</span>`, taken: 0 };
}

function visit(node: { children?: any[] }): void {
  if (!node.children) return;
  const out = [];
  for (const child of node.children) {
    if (child.type !== "text" || !HAS.test(child.value)) {
      visit(child);
      out.push(child);
      continue;
    }
    const parts = child.value.split(EMOJI); // [text, emoji, text, emoji, …]
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        if (parts[i]) out.push({ type: "text", value: parts[i] });
        continue;
      }
      const { html, taken } = icon(parts[i], parts[i + 1] ?? "");
      out.push({ type: "html", value: html });
      parts[i + 1] = (parts[i + 1] ?? "").slice(taken);
    }
  }
  node.children = out;
}

export default function remarkStatus() {
  return (tree: { children?: any[] }) => visit(tree);
}
