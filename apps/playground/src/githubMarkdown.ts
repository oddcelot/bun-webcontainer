import { markdownToHtml } from "./transpiler";
import { BITS } from "./worker/markdown";

/** GitHub's extensions in Bun's renderer: tables, ~~strikethrough~~, task lists, bare links, its tag filter, heading anchors. */
const GFM = BITS.tables | BITS.strikethrough | BITS.tasklists | BITS.autolinkUrl | BITS.autolinkWww | BITS.autolinkEmail | BITS.tagFilter | BITS.headingIds;

const icon = (d: string) => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
/** GitHub's alerts (`> [!TIP]`): their titles, with lucide's icons. */
const ALERTS: Record<string, [string, string]> = {
  note: ["Note", icon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>')],
  tip: ["Tip", icon('<path d="M15 14c.2-1 .7-1.7 1.5-2.5c1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5c.7.7 1.3 1.5 1.5 2.5m0 4h6m-5 4h4"/>')],
  important: ["Important", icon('<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2zm-10-2h.01M12 7v4"/>')],
  warning: ["Warning", icon('<path d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/>')],
  caution: ["Caution", icon('<path d="M12 16h.01M12 8v4m3.312-10a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/>')],
};
const MARKER = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|<br>\n?|$)/i;

/** A blockquote whose first line is only `[!NOTE]` (or TIP, …) becomes GitHub's alert markup, as github.com does it. */
function alerts(doc: Document) {
  for (const quote of doc.querySelectorAll("blockquote")) {
    const p = quote.firstElementChild;
    const m = p?.tagName === "P" ? MARKER.exec(p.innerHTML) : null;
    if (!p || !m) continue;
    const kind = m[1].toLowerCase();
    p.innerHTML = p.innerHTML.slice(m[0].length);
    if (!p.innerHTML.trim()) p.remove();
    const box = doc.createElement("div");
    box.className = `markdown-alert markdown-alert-${kind}`;
    const title = doc.createElement("p");
    title.className = "markdown-alert-title";
    title.innerHTML = ALERTS[kind][1];
    title.append(ALERTS[kind][0]);
    box.append(title, ...quote.childNodes);
    quote.replaceWith(box);
  }
}

/**
 * Markdown as GitHub shows it, as a document to adjust before display: Bun's renderer (`bun_md`, wasm), or micromark's
 * GFM where the wasm can't load (Safari: no Memory64); then GitHub's alerts. Raw HTML stays: show it without scripts.
 */
export async function githubMarkdown(text: string): Promise<Document> {
  let html: string;
  try {
    html = await markdownToHtml(text, GFM);
  } catch {
    const [{ micromark }, { gfm, gfmHtml }] = await Promise.all([import("micromark"), import("micromark-extension-gfm")]);
    html = micromark(text, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  alerts(doc);
  return doc;
}

/** The alerts' colors (GitHub's, light and dark), for the page that shows the HTML. */
export const ALERT_CSS = `.markdown-alert { margin: 0 0 16px; padding: 8px 16px; border-left: 4px solid var(--alert); }
.markdown-alert > :last-child { margin-bottom: 0; }
.markdown-alert-title { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; color: var(--alert); font-weight: 600; }
.markdown-alert-note { --alert: light-dark(#0969da, #4493f8); }
.markdown-alert-tip { --alert: light-dark(#1a7f37, #3fb950); }
.markdown-alert-important { --alert: light-dark(#8250df, #ab7df8); }
.markdown-alert-warning { --alert: light-dark(#9a6700, #d29922); }
.markdown-alert-caution { --alert: light-dark(#d1242f, #f85149); }`;
