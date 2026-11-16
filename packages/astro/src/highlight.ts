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
 *
 * A block with marked lines (`.runbun-lines`, see markup.ts byLine) has each line as an inline block at least as wide
 * as the code, which is as wide as its longest line, so a mark's background spans the block as it scrolls; the shadows
 * carry it through the `<pre>`'s padding. The `\n`s between lines stay text, so the code copies as written. The
 * `+`/`−` gutter is generated content, out of the copied text, with alt text for screen readers (`"+" / "inserted"`;
 * a browser without that keeps the bare sign from the line before).
 *
 * A poster's preset requests (`.runbun-requests`, markup.ts requestPanel) switch like tabbed blocks: radios, and the
 * checked one's panel (the tablist is the first child, so panel n is child n + 1) visible in the shared grid cell.
 * `--runbun-requests-gap` spaces it from the code, `--runbun-method-bg`/`--runbun-method-fg` color the method badge.
 *
 * A note's marker is a numbered pill (`.runbun-note`, the number generated content). Its list (`.runbun-notes`) is
 * popovers, so where the browser has them the list takes no room and an open item is a bubble in the top layer, outside
 * the block, styled on its own; with anchor positioning it sits above its marker (the invoker is its implicit
 * anchor), else where the UA puts a popover, centered. A browser without popovers shows the list as a list.
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
.runbun-tablist label{position:relative;padding:.5rem 1rem;cursor:pointer;white-space:nowrap;opacity:.65;border-bottom:2px solid transparent;border-radius:var(--tab-radius,0)}
.runbun-tablist label:hover{opacity:.9}
.runbun-tablist label:not(:has(input:checked)):hover{background:var(--tab-hover,none)}
.runbun-tablist label:has(input:checked){opacity:1;border-bottom-color:var(--tab-mark,currentColor);background:var(--tab-selected,none);box-shadow:inset 0 0 0 1px var(--tab-selected-border,transparent)}
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
.runbun-lines {
  display: block;
  min-width: max-content;
  & > .line {
    --runbun-line-bg: transparent;
    position: relative;
    display: inline-block;
    min-width: 100%;
    min-height: 1lh;
    vertical-align: top;
    background: var(--runbun-line-bg);
    box-shadow: -1rem 0 var(--runbun-line-bg), 1rem 0 var(--runbun-line-bg);
    &[data-mark] {
      --runbun-line-bg: var(--runbun-mark-bg, color-mix(in srgb, var(--hls-foreground) 12%, transparent));
    }
    &[data-ins] {
      --runbun-line-bg: var(--runbun-ins-bg, color-mix(in srgb, var(--hls-diff-plus, #3fb950) 18%, transparent));
    }
    &[data-del] {
      --runbun-line-bg: var(--runbun-del-bg, color-mix(in srgb, var(--hls-diff-minus, #f85149) 18%, transparent));
    }
    &[data-ins]::before,
    &[data-del]::before {
      position: absolute;
      left: -1rem;
      width: 1rem;
      text-align: center;
    }
    &[data-ins]::before {
      content: "+";
      content: "+" / "inserted";
      color: var(--hls-diff-plus, currentColor);
    }
    &[data-del]::before {
      content: "\\2212";
      content: "\\2212" / "deleted";
      color: var(--hls-diff-minus, currentColor);
    }
  }
}
.runbun-note {
  display: inline-grid;
  place-items: center;
  min-width: 1.5em;
  height: 1.5em;
  margin-inline-start: 0.5em;
  padding: 0 0.35em;
  vertical-align: 0.1em;
  border: 0;
  border-radius: 999px;
  font: inherit;
  font-size: 0.75em;
  line-height: 1;
  color: var(--hls-background);
  background: var(--hls-foreground);
  cursor: pointer;
  &::before {
    content: attr(data-n);
  }
  &:focus-visible {
    outline: 2px solid var(--hls-foreground);
    outline-offset: 2px;
  }
}
@supports selector(:popover-open) {
  .runbun-notes {
    margin: 0;
    list-style: none;
    & > li[popover] {
      box-sizing: border-box;
      max-width: min(32rem, calc(100vw - 2rem));
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--runbun-code-border, color-mix(in srgb, currentColor 15%, transparent));
      border-radius: var(--runbun-code-radius, 8px);
      font-size: var(--runbun-note-size, 0.875rem);
      color: var(--hls-foreground);
      background: var(--hls-background);
      box-shadow: 0 0.25rem 1rem rgb(0 0 0 / 0.2);
      & > :first-child {
        margin-top: 0;
      }
      & > :last-child {
        margin-bottom: 0;
      }
    }
  }
}
@supports (position-area: top) {
  .runbun-notes > li[popover] {
    inset: auto;
    margin: 0 0 0.375rem;
    position-area: top;
    position-try-fallbacks: flip-block;
  }
}
.runbun-requests {
  display: grid;
  margin-top: var(--runbun-requests-gap, 0.75rem);
  overflow: hidden;
  border: 1px solid var(--runbun-code-border, color-mix(in srgb, currentColor 15%, transparent));
  border-radius: var(--runbun-code-radius, 8px);
  color: var(--hls-foreground);
  background: var(--hls-background);
  /* The tabs as the live preview's after Run (@runbun/ui css/tabs.css .tab, apps/playground style.css #preview-tabs):
     a bar padded 6px with 4px between tabs, each tab a rounded box padded 4px 10px, muted until hovered, the open one
     raised with a 2px line under it inset 7px, and a 1px ring when focused. --runbun-accent colors the line and the
     ring (default: the text color). */
  & > .runbun-requests-tablist {
    grid-area: 1 / 1;
    display: flex;
    gap: 4px;
    padding: var(--runbun-tabs-pad, 6px);
    overflow-x: auto;
    overflow-y: hidden;
    box-shadow: inset 0 -1px var(--runbun-code-border, color-mix(in srgb, currentColor 15%, transparent));
    font-family: var(--runbun-ui-font, system-ui, sans-serif);
    font-size: var(--runbun-code-caption-size, 0.75rem);
    & label {
      position: relative;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: var(--tab-radius, var(--runbun-tab-radius, 6px));
      white-space: nowrap;
      cursor: pointer;
      color: color-mix(in srgb, var(--hls-foreground) 65%, transparent);
      &:hover {
        color: var(--hls-foreground);
      }
      &:not(:has(input:checked)):hover {
        background: var(--tab-hover, color-mix(in srgb, var(--hls-foreground) 9%, transparent));
      }
      &:has(input:checked) {
        color: var(--hls-foreground);
        background: var(--tab-selected, color-mix(in srgb, var(--hls-foreground) 16%, transparent));
        box-shadow: inset 0 0 0 1px var(--tab-selected-border, transparent);
        &::after {
          content: "";
          position: absolute;
          right: 7px;
          bottom: 0;
          left: 7px;
          height: 2px;
          border-radius: 1px 1px 0 0;
          background: var(--tab-mark, var(--runbun-accent, currentColor));
        }
      }
      &:has(input:focus-visible) {
        outline: 1px solid var(--runbun-accent, currentColor);
        outline-offset: -1px;
      }
    }
    & input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
  }
  & .runbun-path {
    font-family: var(--runbun-code-font, ui-monospace, monospace);
  }
  /* The method as the playground's badge (apps/playground style.css .method-badge): its color at 72% over the text on
     15% of it. The colors are the playground's per method, each a --runbun-method-<get|post|put|patch|delete>;
     --runbun-method-fg and --runbun-method-bg replace the mixes outright. */
  & .runbun-method {
    --runbun-method: color-mix(in srgb, var(--hls-foreground) 55%, transparent);
    padding: 0 4px;
    border-radius: 4px;
    font: 500 10px/14px var(--runbun-ui-font, system-ui, sans-serif);
    letter-spacing: 0.02em;
    color: var(--runbun-method-fg, color-mix(in oklab, var(--runbun-method) 72%, var(--hls-foreground)));
    background: var(--runbun-method-bg, color-mix(in oklab, var(--runbun-method) 15%, transparent));
    &[data-method="GET"] {
      --runbun-method: var(--runbun-method-get, #26c9a0);
    }
    &[data-method="POST"] {
      --runbun-method: var(--runbun-method-post, #4ba3f2);
    }
    &[data-method="PUT"] {
      --runbun-method: var(--runbun-method-put, #dc6ee0);
    }
    &[data-method="PATCH"] {
      --runbun-method: var(--runbun-method-patch, #9b86f2);
    }
    &[data-method="DELETE"] {
      --runbun-method: var(--runbun-method-delete, #ec6490);
    }
  }
  /* Each panel keeps the poster's Run button clear of its text: the button sits over the poster's bottom-right corner
     (packages/embed element.ts .play: 12px from the edge, 6px padding, a 1px border, a line of the page's font), so
     the panel ends in that much room. --runbun-requests-run-room sets it (0 where there's no Run button). */
  & > .runbun-request {
    grid-area: 2 / 1;
    min-width: 0;
    padding-bottom: var(--runbun-requests-run-room, calc(12px + 2 * 6px + 2 * 1px + 1.2em));
    visibility: hidden;
  }
  & pre {
    margin: 0;
    padding: 0.75rem 1rem;
    overflow-x: auto;
    font-family: var(--runbun-code-font, ui-monospace, monospace);
    font-size: var(--runbun-code-size, 0.875rem);
    line-height: var(--runbun-code-line-height, 1.6);
  }
  /* What's sent (headers, body) sits in a sunken box, so it reads apart from the response under it, which doesn't.
     --runbun-request-bg and --runbun-request-radius restyle the box. */
  & :is(.runbun-request-headers, .runbun-request-body) pre {
    margin: 0.375rem 0.75rem 0.25rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--runbun-code-border, color-mix(in srgb, currentColor 15%, transparent));
    border-radius: var(--runbun-request-radius, 6px);
    /* An image layer: the highlighter writes the block's background-color inline. */
    background-image: linear-gradient(var(--runbun-request-bg, color-mix(in srgb, currentColor 5%, transparent)) 0 0);
  }
  & .runbun-request-label,
  & .runbun-response-pending {
    margin: 0;
    padding: 0.5rem 1rem 0;
    font-family: var(--runbun-code-font, ui-monospace, monospace);
    font-size: var(--runbun-code-caption-size, 0.75rem);
    opacity: 0.65;
  }
  & .runbun-response-pending {
    padding-bottom: 0.5rem;
  }
${Array.from({ length: 12 }, (_, i) => `  &:has(> .runbun-requests-tablist > label:nth-of-type(${i + 1}) > input:checked) > .runbun-request:nth-child(${i + 2}) {\n    visibility: visible;\n  }`).join("\n")}
}
/* Where anchors can be scoped to a row, the checked tab's fill and mark are one indicator in the row that slides to
   the checked tab and takes its size, as the playground's tabs do (@runbun/ui css/tabs.css .tab-indicator), with their
   --tab-* properties; elsewhere each checked tab draws its own. */
@supports (anchor-scope: --a) {
  :is(.runbun-tablist, .runbun-requests-tablist) {
    --_slide: var(--tab-slide, 220ms) var(--tab-slide-ease, cubic-bezier(0.22, 1, 0.36, 1));
    position: relative;
    isolation: isolate;
    anchor-scope: --runbun-tab;
    &::before,
    &::after {
      content: "";
      position: absolute;
      position-anchor: --runbun-tab;
      z-index: -1;
      pointer-events: none;
      transition: left var(--_slide), width var(--_slide), top var(--_slide), height var(--_slide);
      @media (prefers-reduced-motion: reduce) {
        transition: none;
      }
    }
    &::before {
      top: anchor(top);
      left: anchor(left);
      width: anchor-size(width);
      height: anchor-size(height);
      border-radius: var(--_radius);
      background: var(--_fill);
      box-shadow: inset 0 0 0 1px var(--tab-selected-border, transparent);
    }
    &::after {
      top: calc(anchor(bottom) - 2px);
      left: calc(anchor(left) + var(--_inset));
      width: calc(anchor-size(width) - 2 * var(--_inset));
      height: 2px;
      border-radius: 1px 1px 0 0;
      background: var(--_mark);
    }
  }
  /* The checked tab draws nothing of its own: as specific as the rows' own rules (.runbun-requests > … label), and after. */
  :is(.runbun-tabs > .runbun-tablist, .runbun-requests > .runbun-requests-tablist) > label:has(input:checked) {
    anchor-name: --runbun-tab;
    border-bottom-color: transparent;
    background: none;
    box-shadow: none;
    &::after {
      content: none;
    }
  }
  /* A file group's tabs: an underline the tab's width, no fill. A poster's requests: the live preview's. */
  .runbun-tablist {
    --_fill: var(--tab-selected, transparent);
    --_radius: var(--tab-radius, 0px);
    --_mark: var(--tab-mark, currentColor);
    --_inset: 0px;
  }
  .runbun-requests-tablist {
    --_fill: var(--tab-selected, color-mix(in srgb, var(--hls-foreground) 16%, transparent));
    --_radius: var(--tab-radius, var(--runbun-tab-radius, 6px));
    --_mark: var(--tab-mark, var(--runbun-accent, currentColor));
    --_inset: 7px;
  }
}
`.trim();
