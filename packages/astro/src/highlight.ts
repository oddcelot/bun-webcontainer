// Code highlighted at build time with @pierre/highlights, the highlighter of the playground's Pierre views. Spans
// color with CSS variables (its `cssVariables` theme); themeCss() defines them for each configured theme, so one copy
// of the HTML takes whichever theme the page wears.
import { codeToHtml, isSupportedLanguage, tokenNames, type Theme } from "@pierre/highlights";
import * as bundled from "@pierre/highlights/themes";

const ALIASES: Record<string, string> = { typescript: "ts", javascript: "js", shell: "sh", bash: "sh", zsh: "sh", jsonc: "json", md: "markdown" };

/** `code` as a `<pre class="highlights">`; languages highlights doesn't know stay plain. */
export function highlight(code: string, lang = "plain"): string {
  const l = ALIASES[lang] ?? lang;
  const html = codeToHtml(code, { lang: isSupportedLanguage(l) ? l : "plain", theme: bundled.cssVariables });
  return new TextDecoder().decode(html);
}

const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_: string, c: string) => c.toUpperCase());

/** TextMate scopes to look a Zed scope up by, for themes given as VS Code JSON. */
const TEXTMATE: Record<string, string[]> = {
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
  property: ["variable.other.property", "support.type.property-name"],
  variable: ["variable"],
};

/** A bundled @pierre/highlights theme's name (`pierre-dark`), a Zed theme, or a VS Code theme (`{ name, type, tokenColors }`). */
export type ThemeOption = string | { name: string; [key: string]: unknown };

export type ThemeSelector = (theme: { name: string; appearance: string }) => string;

interface Rule {
  scope?: string | string[];
  settings: { foreground?: string };
}
interface VscodeTheme {
  name: string;
  type: string;
  tokenColors?: Rule[];
  colors?: Record<string, string>;
}
interface Resolved {
  name: string;
  theme: Theme;
}

/** A VS Code theme as the Zed theme highlights reads. */
function fromVscode(json: VscodeTheme): Theme {
  const rules = json.tokenColors ?? [];
  const find = (scope: string) =>
    rules.find((r: Rule) => [r.scope].flat().some((s) => s === scope || scope.startsWith(s + ".")))?.settings.foreground;
  const syntax: Record<string, { color: string }> = {};
  for (const [zed, scopes] of Object.entries(TEXTMATE)) {
    const color = scopes.map(find).find(Boolean);
    if (color) syntax[zed] = { color };
  }
  const { "editor.background": background, "editor.foreground": foreground } = json.colors ?? {};
  return { name: json.name, appearance: json.type, style: { "editor.background": background, "editor.foreground": foreground, syntax } };
}

/**
 * A theme option as `{ name, theme }`: a bundled theme's name (`pierre-dark`), a Zed theme (`{ name, appearance,
 * style }`), or a VS Code theme (`{ name, type, tokenColors }`). Objects are named by their `name`.
 */
export function resolveTheme(option: ThemeOption): { name: string; theme: Theme } {
  if (typeof option === "string") {
    const theme = (bundled as unknown as Record<string, Theme | undefined>)[camel(option)];
    if (!theme) throw new Error(`@runbun/astro: no bundled highlights theme "${option}"`);
    return { name: option, theme };
  }
  return { name: option.name, theme: option.style ? (option as unknown as Theme) : fromVscode(option as unknown as VscodeTheme) };
}

/**
 * `theme` with a color for every scope highlights emits, as Zed falls back: `keyword.declaration` takes `keyword`'s
 * when the theme has none. Without that a span's variable would be unset and the token would lose its color.
 */
function complete(theme: Theme): Theme {
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

/**
 * The variables of every theme. With `selector`, each goes under `selector({ name, appearance })`. Without, the first
 * light theme applies on `:root` and the first dark one under `prefers-color-scheme: dark`.
 */
export function themeCss(options: ThemeOption[], selector?: ThemeSelector): string {
  const themes = options.map(resolveTheme);
  const vars = (t: Resolved) => bundled.toCSS(complete(t.theme));
  if (selector) return themes.map((t: Resolved) => `${selector({ name: t.name, appearance: t.theme.appearance })}{${vars(t)}}`).join("\n");
  const light = themes.find((t: Resolved) => t.theme.appearance === "light");
  const dark = themes.find((t: Resolved) => t.theme.appearance === "dark");
  return [light && `:root{${vars(light)}}`, dark && `@media (prefers-color-scheme: dark){:root{${vars(dark)}}}`]
    .filter(Boolean)
    .join("\n");
}

/**
 * The look of a block, around the theme's colors; `--runbun-code-*` properties adjust it. A tabbed block's files share
 * one grid cell, only the checked tab's visible, so the block keeps its longest file's height as tabs switch.
 */
export const BLOCK_CSS = `
:where(.runbun-code){margin:0}
.runbun-code{position:relative}
.runbun-copy{position:absolute;top:var(--runbun-copy-inset,.3125rem);right:var(--runbun-copy-inset,.3125rem);z-index:1;padding:.125rem .5rem;font-family:var(--runbun-code-font,ui-monospace,monospace);font-size:var(--runbun-code-caption-size,.75rem);line-height:1.2;color:var(--runbun-copy-fg,var(--hls-foreground));background:var(--runbun-copy-bg,var(--hls-background));border:1px solid var(--runbun-copy-border,color-mix(in srgb,currentColor 25%,transparent));border-radius:var(--runbun-copy-radius,6px);cursor:pointer;opacity:0;transition:opacity .15s}
.runbun-code:hover>.runbun-copy,.runbun-code:focus-within>.runbun-copy,.runbun-copy[data-copied]{opacity:1}
@media (hover:none){.runbun-copy{opacity:1}}
@media (prefers-reduced-motion:reduce){.runbun-copy{transition:none}}
.runbun-code{border:1px solid var(--runbun-code-border,color-mix(in srgb,currentColor 15%,transparent));border-radius:var(--runbun-code-radius,8px);overflow:hidden;background:var(--hls-background);color:var(--hls-foreground)}
.runbun-code figcaption{padding:.5rem 1rem;border-bottom:1px solid var(--runbun-code-border,color-mix(in srgb,currentColor 15%,transparent));font-family:var(--runbun-code-font,ui-monospace,monospace);font-size:var(--runbun-code-caption-size,.75rem);opacity:.8}
.runbun-code pre{margin:0;padding:1rem;overflow-x:auto;font-family:var(--runbun-code-font,ui-monospace,monospace);font-size:var(--runbun-code-size,.875rem);line-height:var(--runbun-code-line-height,1.6)}
.runbun-tabs{display:grid;border:1px solid var(--runbun-code-border,color-mix(in srgb,currentColor 15%,transparent));border-radius:var(--runbun-code-radius,8px);overflow:hidden;background:var(--hls-background);color:var(--hls-foreground)}
.runbun-tabs>.runbun-code{grid-area:2/1;visibility:hidden;min-width:0;margin:0;border:0;border-radius:0}
.runbun-tablist{grid-area:1/1;display:flex;overflow-x:auto;overflow-y:hidden;box-shadow:inset 0 -1px var(--runbun-code-border,color-mix(in srgb,currentColor 15%,transparent));font-family:var(--runbun-code-font,ui-monospace,monospace);font-size:var(--runbun-code-caption-size,.75rem)}
.runbun-tablist label{position:relative;padding:.5rem 1rem;cursor:pointer;white-space:nowrap;opacity:.65;border-bottom:2px solid transparent}
.runbun-tablist label:hover{opacity:.9}
.runbun-tablist label:has(input:checked){opacity:1;border-bottom-color:currentColor}
.runbun-tablist label:has(input:focus-visible){outline:2px solid currentColor;outline-offset:-2px}
.runbun-tablist input{position:absolute;opacity:0;pointer-events:none}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(1)>input:checked)>.runbun-code:nth-of-type(1){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(2)>input:checked)>.runbun-code:nth-of-type(2){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(3)>input:checked)>.runbun-code:nth-of-type(3){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(4)>input:checked)>.runbun-code:nth-of-type(4){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(5)>input:checked)>.runbun-code:nth-of-type(5){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(6)>input:checked)>.runbun-code:nth-of-type(6){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(7)>input:checked)>.runbun-code:nth-of-type(7){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(8)>input:checked)>.runbun-code:nth-of-type(8){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(9)>input:checked)>.runbun-code:nth-of-type(9){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(10)>input:checked)>.runbun-code:nth-of-type(10){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(11)>input:checked)>.runbun-code:nth-of-type(11){visibility:visible}
.runbun-tabs:has(>.runbun-tablist>label:nth-of-type(12)>input:checked)>.runbun-code:nth-of-type(12){visibility:visible}
`.trim();
