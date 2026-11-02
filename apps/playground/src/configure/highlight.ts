import { codeToTokens, isSupportedLanguage, type Lang, type Theme } from "@pierre/highlights";

// The configurator's snippet, highlighted with @pierre/highlights: the HTML, and the inline file inside its
// `<script type="text/plain">` in the file's own language (an HTML highlighter leaves a text/plain script plain).

/** All of highlights' bundled themes, loaded on first use (about 320 KB; the page needs whichever theme it wears). */
let bundled: Promise<Record<string, Theme>> | undefined;
const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** The highlights theme for a playground theme name. Elysia's aren't bundled; Pierre's of the same scheme stand in. */
async function themeFor(name: string): Promise<Theme> {
  const all = await (bundled ??= import("@pierre/highlights/themes") as unknown as Promise<Record<string, Theme>>);
  return all[camel(name)] ?? all[name.includes("light") ? "pierreLight" : "pierreDark"]!;
}

/** The inline file inside a snippet: the line after its `<script type="text/plain" data-file="…">` up to its `</script>`. */
const INLINE = /(<script type="text\/plain" data-file="([^"]*)">\n)([\s\S]*?)(\n[ \t]*<\/script>)/;

/** The snippet as runs of one language each; together they are the snippet's text. */
function segments(text: string): { lang: Lang; text: string }[] {
  const m = INLINE.exec(text);
  if (!m) return [{ lang: "html", text }];
  const ext = m[2]!.slice(m[2]!.lastIndexOf(".") + 1).toLowerCase();
  const lang: Lang = isSupportedLanguage(ext) ? ext : "plain";
  const start = m.index + m[1]!.length;
  const end = start + m[3]!.length;
  return [
    { lang: "html", text: text.slice(0, start) },
    { lang, text: text.slice(start, end) },
    { lang: "html", text: text.slice(end) },
  ];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The snippet as highlighted HTML (spans with inline colors), with the theme's background and text colors. Each run's
 * lines join with the newlines they were split at, so the runs put together are the text again.
 */
export async function highlightSnippet(text: string, themeName: string) {
  const theme = await themeFor(themeName);
  let bg = "";
  let fg = "";
  const html = segments(text)
    .map((seg) => {
      const r = codeToTokens(seg.text, { lang: seg.lang, theme });
      bg ||= r.bg ?? "";
      fg ||= r.fg ?? "";
      return r.tokens
        .map((line) =>
          line
            .map((t) => {
              const style = [
                t.color && `color:${t.color}`,
                t.fontStyle && t.fontStyle & 1 && "font-style:italic",
                t.fontStyle && t.fontStyle & 2 && "font-weight:600",
              ]
                .filter(Boolean)
                .join(";");
              return style ? `<span style="${style}">${esc(t.content)}</span>` : esc(t.content);
            })
            .join(""),
        )
        .join("\n");
    })
    .join("");
  return { html, bg, fg };
}
