// Code highlighted at build time with @pierre/highlights, the highlighter of the playground's Pierre views. Spans
// color with CSS variables (its `cssVariables` theme), and highlights.css (pages/highlights.css.ts) defines them for
// every family's code theme under [data-code-theme] (components/ThemeProvider.astro), so one copy of the HTML takes
// whatever theme the reader picks.
import { codeToHtml, isSupportedLanguage, tokenNames } from "@pierre/highlights";
import * as bundled from "@pierre/highlights/themes";
import elysiaDark from "../../ui/code-themes/elysia-dark.json" with { type: "json" };
import elysiaLight from "../../ui/code-themes/elysia-light.json" with { type: "json" };
import families from "../../ui/themes.json" with { type: "json" };

const ALIASES = { typescript: "ts", javascript: "js", shell: "sh", bash: "sh", zsh: "sh", jsonc: "json", md: "markdown" };

/** `code` as a `<pre class="highlights">`; languages highlights doesn't know stay plain. */
export function highlight(code, lang = "plain") {
  const l = ALIASES[lang] ?? lang;
  const html = codeToHtml(code, { lang: isSupportedLanguage(l) ? l : "plain", theme: bundled.cssVariables });
  return new TextDecoder().decode(html);
}

const camel = (name) => name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/** TextMate scopes to look a Zed scope up by, for themes that only come as VS Code JSON (Elysia's). */
const TEXTMATE = {
  comment: ["comment"],
  string: ["string"],
  number: ["constant.numeric"],
  boolean: ["constant.language"],
  constant: ["constant.language", "constant"],
  keyword: ["keyword", "storage"],
  function: ["entity.name.function", "support.function"],
  type: ["entity.name.type", "support.type", "support.class"],
  constructor: ["entity.name.type", "support.class"],
  tag: ["entity.name.tag"],
  attribute: ["entity.other.attribute-name"],
};

/** A VS Code theme as the Zed theme highlights reads. */
function fromVscode(json) {
  const rules = json.tokenColors ?? [];
  const find = (scope) =>
    rules.find((r) => [r.scope].flat().some((s) => s === scope || scope.startsWith(s + ".")))?.settings.foreground;
  const syntax = {};
  for (const [zed, scopes] of Object.entries(TEXTMATE)) {
    const color = scopes.map(find).find(Boolean);
    if (color) syntax[zed] = { color };
  }
  const { "editor.background": background, "editor.foreground": foreground } = json.colors;
  return { name: json.name, appearance: json.type, style: { "editor.background": background, "editor.foreground": foreground, syntax } };
}

/** The families' code themes highlights doesn't bundle, as VS Code JSON. */
const VSCODE = { "elysia-dark": elysiaDark, "elysia-light": elysiaLight };

const load = (name) => bundled[camel(name)] ?? fromVscode(VSCODE[name]);

/**
 * `theme` with a color for every scope highlights emits, as Zed falls back: `keyword.declaration` takes `keyword`'s
 * when the theme has none. Without that a span's variable would be unset and the token would lose its color.
 */
function complete(theme) {
  const syntax = { ...theme.style.syntax };
  for (const name of tokenNames) {
    if (name === "background" || name === "foreground" || syntax[name]) continue;
    for (let base = name; base.includes("."); ) {
      base = base.slice(0, base.lastIndexOf("."));
      if (syntax[base]) {
        syntax[name] = syntax[base];
        break;
      }
    }
  }
  return { ...theme, style: { ...theme.style, syntax } };
}

/** The variables of every family's code themes, each under its `[data-code-theme]`. */
export function themeCss() {
  const names = [...new Set(families.families.flatMap((f) => [f.dark, f.light]))];
  return names.map((n) => `:root[data-code-theme='${n}']{${bundled.toCSS(complete(load(n)))}}`).join("\n");
}
