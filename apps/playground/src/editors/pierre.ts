import { File, getHighlighterIfLoaded, getSharedHighlighter, registerCustomTheme } from "@pierre/diffs";
import { Editor, type Marker } from "@pierre/diffs/edit";
import { elysiaDark, elysiaLight } from "../elysiaTheme";
import { onTheme, themeName } from "../theme";
import type { CodeEditor, CompletionKind, EditorCompletion, EditorCompletionDetails, EditorDiagnostic, EditorEvents, EditorHover, EditorSignatureHelp } from "./types";

// @pierre/diffs resolves theme names from its own bundles; the Elysia pair (elysiaTheme.ts) has to be registered.
registerCustomTheme("elysia-light", async () => elysiaLight);
registerCustomTheme("elysia-dark", async () => elysiaDark);

// Lucide's circle-x and triangle-alert, drawn in the severity's color (the popover is in a shadow root, where the page's icon classes don't apply).
const ICONS = {
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
  warning: '<svg viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/></svg>',
};

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A marker's hover, laid out like an editor's: severity icon, message (TypeScript's nested chains keep their lines), source. */
const hoverHtml = (d: EditorDiagnostic) =>
  `<span class="hover-icon" aria-hidden="true">${ICONS[d.severity]}</span><span class="hover-text">${escapeHtml(d.message)}${d.source ? ` <span class="hover-source">${escapeHtml(d.source)}</span>` : ""}</span>`;

/**
 * The marker hover as an editor widget (the surface the editor's own popovers use) instead of a pill in the severity's
 * color. `unsafeCSS` lands in a cascade layer and the editor's styles don't, so the overrides need `!important`.
 */
const HOVER_CSS = `
  [data-marker-popover] {
    --diffs-widget-bg: color-mix(in lab, var(--diffs-fg) 4%, var(--diffs-bg)) !important;
    color: var(--diffs-fg) !important;
    border: 1px solid color-mix(in lab, var(--diffs-fg) 18%, transparent) !important;
    border-radius: 6px !important;
    padding: 6px 10px !important;
    font-size: 13px !important;
    line-height: 19px !important;
  }
  [data-marker-message] { display: flex; gap: 8px; align-items: flex-start; }
  [data-marker-message] + [data-marker-message] { margin-top: 6px; padding-top: 6px; border-top: 1px solid color-mix(in lab, var(--diffs-fg) 12%, transparent); }
  .hover-icon { flex: none; display: flex; height: 19px; align-items: center; color: var(--diffs-marker-bg); }
  .hover-icon svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .hover-text { white-space: pre-wrap; }
  .hover-source { color: color-mix(in lab, var(--diffs-fg) 50%, transparent); white-space: nowrap; }`;

/** How long the pointer rests on a token before its hover is asked for, and how long a hover outlives the pointer leaving. */
const HOVER_DELAY = 300;
const HIDE_DELAY = 200;

/** Shiki's FontStyle bits. */
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

/**
 * `code` highlighted as TypeScript in the editor's theme, with `[start, end)` (UTF-16 offsets) in <strong>. The editor
 * loads the highlighter for the file it shows; until it has TypeScript (a .tsx file is open), it's asked for here and
 * this hover stays plain.
 */
function codeHtml(code: string, strong?: [number, number]): string {
  const theme = themeName();
  const highlighter = getHighlighterIfLoaded({ theme, lang: "typescript" });
  const mark = (s: string, from: number, style = "") => {
    const span = (t: string) => (style ? `<span style="${style}">${escapeHtml(t)}</span>` : escapeHtml(t));
    if (!strong) return span(s);
    const [a, b] = [Math.max(0, strong[0] - from), Math.min(s.length, strong[1] - from)];
    if (a >= b) return span(s);
    return span(s.slice(0, a)) + `<strong>${span(s.slice(a, b))}</strong>` + span(s.slice(b));
  };
  if (!highlighter) {
    void getSharedHighlighter({ themes: [theme], langs: ["typescript"] }).catch(() => {});
    return mark(code, 0);
  }
  const { tokens } = highlighter.codeToTokens(code, { lang: "typescript", theme });
  return tokens
    .map((line) =>
      line
        .map((t) => {
          const f = t.fontStyle ?? 0;
          const style = [
            t.color && `color:${t.color}`,
            f & ITALIC && "font-style:italic",
            f & BOLD && "font-weight:bold",
            f & UNDERLINE && "text-decoration:underline",
          ].filter(Boolean).join(";");
          return mark(t.content, t.offset, style);
        })
        .join(""),
    )
    .join("\n");
}

/** Fence languages highlighted as TypeScript (a JSDoc @example without one is, too). */
const SCRIPT_FENCE = /^(?:|[jt]sx?|typescript|javascript)$/i;

/** Inline markdown: `code`, **strong**, *emphasis*; links keep their text. */
const inlineHtml = (md: string) =>
  escapeHtml(md)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])[*_]([^*_]+)[*_]/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

/** The JSDoc part of a hover: paragraphs and fenced code blocks. */
function docsHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inlineHtml(para.join("\n"))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})\s*([\w-]*)/.exec(lines[i]);
    if (!open) {
      if (lines[i].trim()) para.push(lines[i]);
      else flush();
      continue;
    }
    flush();
    const close = new RegExp(`^\`{${open[1].length},}\\s*$`);
    const body: string[] = [];
    while (++i < lines.length && !close.test(lines[i])) body.push(lines[i]);
    // TypeScript wraps a JSDoc @example in a longer fence; inside is markdown again (a caption, then the code).
    const code = body.join("\n");
    out.push(body.some((l) => l.startsWith("```")) ? docsHtml(code) : `<pre>${SCRIPT_FENCE.test(open[2]) ? codeHtml(code) : escapeHtml(code)}</pre>`);
  }
  flush();
  return out.join("");
}

/** A signature (highlighted) with the active parameter in bold, its docs, then the signature's docs. */
function signatureHtml(help: EditorSignatureHelp): string {
  const sig = help.signatures[help.active];
  const param = help.param === undefined ? undefined : sig.params[help.param];
  const label = codeHtml(sig.label, param && param.start >= 0 ? [param.start, param.end] : undefined);
  const count = help.signatures.length > 1 ? `<span class="editor-signature-count">${help.active + 1}/${help.signatures.length}</span>` : "";
  const docs = [param?.docs, sig.docs].filter(Boolean).map((d) => docsHtml(d!)).join("");
  return `<pre class="editor-hover-code">${count}${label}</pre>` + (docs ? `<div class="editor-hover-docs">${docs}</div>` : "");
}

const tipHtml = (h: EditorHover) =>
  (h.code ? `<pre class="editor-hover-code">${codeHtml(h.code)}</pre>` : "") + (h.docs ? `<div class="editor-hover-docs">${docsHtml(h.docs)}</div>` : "");

/** Lucide icons for completion kinds (literal class names, so UnoCSS finds them). */
const KIND_ICONS: Record<CompletionKind, string> = {
  function: "i-lucide-square-function",
  variable: "i-lucide-variable",
  constant: "i-lucide-variable",
  property: "i-lucide-wrench",
  class: "i-lucide-component",
  interface: "i-lucide-braces",
  type: "i-lucide-type",
  enum: "i-lucide-list-ordered",
  module: "i-lucide-package",
  file: "i-lucide-file",
  folder: "i-lucide-folder",
  keyword: "i-lucide-key-round",
  text: "i-lucide-text",
};

/** Characters after which the language service has something to offer: members, import paths, JSX, decorators, private names. */
const TRIGGERS = new Set([".", '"', "'", "`", "/", "@", "<", "#"]);
const WORD = /[\w$]/;
/** Characters that start or move along a call's arguments: parameter hints for it. */
const SIGNATURE_TRIGGERS = new Set(["(", ",", "<"]);
/** Rows the list shows; typing narrows the rest down. */
const MAX_SHOWN = 200;

/** How well `typed` matches `text`: 0 (same-case prefix), 1 (prefix), 2 (its letters in order), or -1. */
function matchScore(text: string, typed: string): number {
  if (text.startsWith(typed)) return 0;
  const lower = text.toLowerCase();
  const want = typed.toLowerCase();
  if (lower.startsWith(want)) return 1;
  let at = 0;
  for (const c of want) {
    at = lower.indexOf(c, at) + 1;
    if (!at) return -1;
  }
  return 2;
}

/**
 * A read-only, highlighted view of some text, the language from `name`'s extension (a response body): the `File`
 * surface the editor works on, without the editor or line numbers, wrapping long lines.
 */
export function createViewer(parent: HTMLElement) {
  const host = document.createElement("div");
  host.className = "pierre-viewer";
  parent.replaceChildren(host);
  let view: File | undefined;
  let theme = themeName();
  const unsubscribe = onTheme((next) => {
    if (next === theme) return;
    theme = next;
    if (!view) return;
    view.setOptions({ ...view.options, theme });
    view.onThemeChange();
  });
  return {
    show(name: string, text: string) {
      view?.cleanUp();
      view = new File({
        theme,
        disableFileHeader: true,
        disableLineNumbers: true,
        overflow: "wrap",
        unsafeCSS: "* { scrollbar-width: thin; }",
      });
      view.render({ containerWrapper: host, file: { name, contents: text } });
    },
    destroy() {
      unsubscribe();
      view?.cleanUp();
      host.remove();
    },
  };
}

/** @pierre/diffs edit mode: a highlighted `File` surface with an `Editor` attached. */
export function createPierre(parent: HTMLElement, events: EditorEvents = {}): CodeEditor {
  const host = document.createElement("div");
  host.className = "pierre-host";
  parent.replaceChildren(host);

  let view: File | undefined;
  let finish: (() => void) | undefined;
  let editor: Editor<"file"> | undefined;
  let text = "";
  let path = "";
  let listener: (text: string) => void = () => {};
  let theme = themeName();
  let markers: Marker[] = [];

  // The editor has no selection event; read the cursor after whatever can move it (events from its shadow root bubble here).
  let lastCursor = "";
  function reportCursor() {
    const sel = editor?.getViewState().selections?.[0];
    // The caret is the end a selection was extended to.
    const caret = sel?.direction === -1 ? sel.start : sel?.end;
    const cursor = sel && caret && {
      line: caret.line + 1,
      column: caret.character + 1,
      selected: Math.abs(offsetOf(sel.end) - offsetOf(sel.start)),
    };
    const key = JSON.stringify(cursor ?? null);
    if (key === lastCursor) return;
    lastCursor = key;
    events.onCursor?.(cursor ?? null);
    if (signature) void requestSignature();
  }
  /** A zero-based position as an offset into the text. */
  const offsetOf = (p: { line: number; character: number }) => {
    let offset = 0;
    for (let l = 0; l < p.line; l++) {
      const next = text.indexOf("\n", offset);
      if (next < 0) return text.length;
      offset = next + 1;
    }
    return offset + p.character;
  };
  const onMove = () => requestAnimationFrame(reportCursor);
  for (const type of ["keyup", "pointerup", "focusin"]) host.addEventListener(type, onMove);

  // Type information for the token under the pointer (events.hover), in a popup fixed over the page, above the token
  // (below when there's no room). Pointing into the popup keeps it open, so its text can be selected. It sits beside
  // the host, so whatever replaces the editor's element removes it too.
  const tip = document.createElement("div");
  tip.className = "editor-hover";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  parent.append(tip);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverSeq = 0;
  let hovered: HTMLElement | undefined;
  function hideHover() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoverSeq++;
    hovered = undefined;
    tip.hidden = true;
  }
  function placeHover(anchor: HTMLElement) {
    const at = anchor.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = tip;
    const above = at.top - height - 4;
    tip.style.top = `${above >= 4 ? above : at.bottom + 4}px`;
    tip.style.left = `${Math.max(4, Math.min(at.left, innerWidth - width - 4))}px`;
  }
  type Token = { lineNumber: number; lineCharStart: number; tokenElement: HTMLElement };
  /** Asks for the hover of `token` after `delay` ms and shows it there, unless another token is asked for first. */
  function hoverToken(token: Token, delay: number) {
    if (!events.hover || !editor) return;
    clearTimeout(hideTimer);
    if (token.tokenElement === hovered && !tip.hidden) return;
    clearTimeout(hoverTimer);
    const mine = ++hoverSeq;
    hovered = token.tokenElement;
    const at = path;
    hoverTimer = setTimeout(async () => {
      const info = await events.hover!(at, token.lineNumber, token.lineCharStart + 1).catch(() => null);
      if (mine !== hoverSeq || at !== path) return;
      if (!info) return void (tip.hidden = true);
      tip.innerHTML = tipHtml(info);
      tip.hidden = false;
      placeHover(token.tokenElement);
    }, delay);
  }
  const onTokenEnter = (token: Token) => hoverToken(token, HOVER_DELAY);
  /** The token at a zero-based position: the one it's in, else the one it ends (the cursor just after a name). */
  function tokenAt(line: number, character: number): Token | undefined {
    const root = host.querySelector("diffs-container")?.shadowRoot;
    const spans = [...(root?.querySelectorAll<HTMLElement>(`code [data-line="${line + 1}"] [data-char]`) ?? [])];
    const start = (s: HTMLElement) => Number(s.dataset.char);
    const end = (s: HTMLElement) => start(s) + (s.textContent?.length ?? 0);
    const word = (s: HTMLElement) => !!s.textContent?.trim();
    const span =
      spans.find((s) => word(s) && start(s) <= character && character < end(s)) ?? spans.find((s) => word(s) && end(s) === character);
    return span && { lineNumber: line + 1, lineCharStart: start(span), tokenElement: span };
  }
  function onTokenLeave() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideHover, HIDE_DELAY);
  }
  tip.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  tip.addEventListener("pointerleave", onTokenLeave);
  // Typing, clicking or scrolling moves the text out from under it.
  for (const type of ["keydown", "pointerdown", "wheel"]) host.addEventListener(type, hideHover, { capture: true });

  // The completion list (events.complete): asked for by the suggest shortcut, a trigger character, or typing the
  // first letter of a word; typing then narrows it down. Like the hover it sits beside the host, fixed over the page,
  // below the word (above when there's no room), with the selected entry's declaration and docs under it. Its keys
  // are taken in the capture phase, before the editor (inside the shadow root) sees them.
  const suggestBox = document.createElement("div");
  suggestBox.className = "editor-suggest";
  suggestBox.hidden = true;
  const suggestList = document.createElement("ul");
  suggestList.setAttribute("role", "listbox");
  suggestList.setAttribute("aria-label", "Completions");
  const suggestDocs = document.createElement("div");
  suggestDocs.className = "editor-suggest-docs";
  suggestBox.append(suggestList, suggestDocs);
  parent.append(suggestBox);
  type Suggest = { line: number; start: number; items: EditorCompletion[]; incomplete: boolean; shown: EditorCompletion[]; selected: number };
  let suggest: Suggest | undefined;
  let suggestSeq = 0;
  let resolveSeq = 0;
  /** Set while accepting, so the edit doesn't count as typing. */
  let applying = false;
  // Each entry's details, asked for once: for the docs under the list, and the import accepting it adds.
  let resolved = new WeakMap<EditorCompletion, Promise<EditorCompletionDetails | null>>();
  function details(item: EditorCompletion) {
    let p = resolved.get(item);
    if (!p) resolved.set(item, (p = events.resolveCompletion ? events.resolveCompletion(path, item).catch(() => null) : Promise.resolve(null)));
    return p;
  }

  /** The cursor, zero-based, if nothing is selected. */
  function caretPos() {
    const sel = editor?.getViewState().selections?.[0];
    if (!sel || sel.start.line !== sel.end.line || sel.start.character !== sel.end.character) return undefined;
    return sel.end;
  }
  const lineText = (line: number) => text.split("\n", line + 1)[line] ?? "";
  /** Where the word that ends at `character` starts. */
  function wordStart(line: number, character: number) {
    const t = lineText(line);
    let i = character;
    while (i > 0 && WORD.test(t[i - 1])) i--;
    return i;
  }
  /** The screen box of the character at a zero-based position (zero width at a line's end). */
  function rectAt(line: number, character: number): DOMRect | undefined {
    const root = host.querySelector("diffs-container")?.shadowRoot;
    const row = root?.querySelector<HTMLElement>(`code [data-line="${line + 1}"]`);
    if (!row) return undefined;
    for (const span of row.querySelectorAll<HTMLElement>("[data-char]")) {
      const from = Number(span.dataset.char);
      const node = span.firstChild;
      const len = span.textContent?.length ?? 0;
      if (!node || character < from || character > from + len) continue;
      const range = document.createRange();
      range.setStart(node, Math.min(character - from, node.textContent?.length ?? 0));
      return range.getBoundingClientRect();
    }
    return row.getBoundingClientRect();
  }

  function closeSuggest() {
    suggestSeq++;
    resolveSeq++;
    suggest = undefined;
    suggestBox.hidden = true;
  }

  /** Asks for the completions at the cursor; `trigger` is the character just typed, if that's what asked. */
  async function requestSuggest(trigger?: string) {
    const caret = caretPos();
    if (!events.complete || !caret) return closeSuggest();
    const mine = ++suggestSeq;
    const at = path;
    const r = await events.complete(at, caret.line + 1, caret.character + 1, trigger).catch(() => null);
    if (mine !== suggestSeq || at !== path) return;
    const now = caretPos();
    if (!r?.items.length || !now || now.line !== caret.line) return closeSuggest();
    const start = wordStart(now.line, caret.character);
    // Typed past the word it was asked for (a space, a parenthesis): it's for a place that's gone.
    if (now.character < start || lineText(now.line).slice(start, now.character).match(/[^\w$]/)) return closeSuggest();
    suggest = { line: now.line, start, items: r.items, incomplete: r.incomplete, shown: [], selected: 0 };
    resolved = new WeakMap();
    filterSuggest();
  }

  /** Narrows the list down to what matches the word before the cursor. */
  function filterSuggest() {
    const s = suggest;
    const caret = caretPos();
    if (!s || !caret || caret.line !== s.line || caret.character < s.start) return closeSuggest();
    const t = lineText(s.line);
    const scored: [EditorCompletion, number][] = [];
    for (const item of s.items) {
      const from = item.start === undefined ? s.start : item.start - 1;
      if (from > caret.character) continue;
      const score = matchScore(item.filter, t.slice(from, caret.character));
      if (score >= 0) scored.push([item, score]);
    }
    if (!scored.length) return closeSuggest();
    scored.sort(([a, x], [b, y]) => x - y || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0) || a.label.localeCompare(b.label));
    s.shown = scored.slice(0, MAX_SHOWN).map(([item]) => item);
    s.selected = 0;
    suggestList.replaceChildren(
      ...s.shown.map((item, i) => {
        const row = document.createElement("li");
        row.setAttribute("role", "option");
        row.dataset.index = String(i);
        row.innerHTML =
          `<i class="${KIND_ICONS[item.kind]} editor-suggest-kind" aria-hidden="true" title="${item.kind}"></i>` +
          `<span class="editor-suggest-label">${escapeHtml(item.label)}</span>` +
          (item.description ? `<span class="editor-suggest-description">${escapeHtml(item.description)}</span>` : "");
        return row;
      }),
    );
    suggestBox.hidden = false;
    selectSuggest(0);
    placeSuggest();
  }

  function placeSuggest() {
    if (!suggest) return;
    const at = rectAt(suggest.line, suggest.start);
    if (!at) return closeSuggest();
    const { offsetWidth: width, offsetHeight: height } = suggestBox;
    const below = at.bottom + 2;
    suggestBox.style.top = `${below + height <= innerHeight - 4 || at.top - height - 2 < 4 ? below : at.top - height - 2}px`;
    // The icon column sits left of the word, so labels line up with what's typed.
    suggestBox.style.left = `${Math.max(4, Math.min(at.left - 26, innerWidth - width - 4))}px`;
  }

  function selectSuggest(index: number) {
    const s = suggest;
    if (!s) return;
    s.selected = (index + s.shown.length) % s.shown.length;
    for (const row of suggestList.children) row.setAttribute("aria-selected", String(Number((row as HTMLElement).dataset.index) === s.selected));
    suggestList.children[s.selected]?.scrollIntoView({ block: "nearest" });
    // The declaration and docs of the selected entry, once the selection rests a moment.
    const item = s.shown[s.selected];
    const mine = ++resolveSeq;
    suggestDocs.hidden = true;
    if (!events.resolveCompletion) return;
    setTimeout(async () => {
      if (mine !== resolveSeq) return;
      const info = await details(item);
      if (mine !== resolveSeq || !info || !(info.code || info.docs)) return;
      suggestDocs.innerHTML = tipHtml(info);
      suggestDocs.hidden = false;
      placeSuggest();
    }, 60);
  }

  async function acceptSuggest() {
    const s = suggest;
    const caret = caretPos();
    const item = s?.shown[s.selected];
    closeSuggest();
    if (!s || !caret || !item || !editor) return;
    const from = item.start === undefined ? s.start : item.start - 1;
    // An auto-import's import comes from resolving it (usually done already, for the docs under the list).
    const before = text;
    const extra = item.autoImport ? ((await details(item))?.edits ?? []) : [];
    // Typed on meanwhile: the edit would land in the wrong place.
    if (text !== before || !editor) return;
    const pos = (p: { line: number; column: number }) => ({ line: p.line - 1, character: p.column - 1 });
    applying = true;
    try {
      editor.applyEdits([
        ...extra.map((e) => ({ range: { start: pos(e.start), end: pos(e.end) }, newText: e.text })),
        { range: { start: { line: s.line, character: from }, end: caret }, newText: item.insert },
      ]);
    } finally {
      applying = false;
    }
    // Lines the import added above push the cursor's line down.
    let line = s.line;
    for (const e of extra) if (e.start.line - 1 <= s.line) line += e.text.split("\n").length - 1 - (e.end.line - e.start.line);
    editor.focus({ lineNumber: line + 1, character: from + item.insert.length });
    onMove();
  }

  /** After an edit: open, narrow down or close the list, as what was typed calls for. */
  function onTyped(before: string) {
    if (applying || !events.complete) return;
    const caret = caretPos();
    if (!caret) return closeSuggest();
    const grew = text.length - before.length;
    // One character typed, or two when the editor closes a quote or bracket after it.
    const typed = grew === 1 || grew === 2 ? lineText(caret.line)[caret.character - 1] : undefined;
    if (typed && SIGNATURE_TRIGGERS.has(typed)) void requestSignature(typed);
    if (typed && TRIGGERS.has(typed)) return void requestSuggest(typed);
    if (typed && WORD.test(typed)) {
      if (suggest) return suggest.incomplete ? void requestSuggest() : filterSuggest();
      // The first letter of a word (not a number).
      const start = wordStart(caret.line, caret.character);
      if (caret.character - start === 1 && !/\d/.test(typed)) void requestSuggest();
      return;
    }
    if (!suggest) return;
    if (grew < 0) filterSuggest();
    else closeSuggest();
  }

  // Keys for the open list, before the editor sees them.
  host.addEventListener(
    "keydown",
    (e) => {
      if (!suggest || e.isComposing) return;
      const page = Math.max(1, Math.floor(suggestList.clientHeight / 22) - 1);
      const keys: Record<string, () => void> = {
        ArrowDown: () => selectSuggest(suggest!.selected + 1),
        ArrowUp: () => selectSuggest(suggest!.selected - 1),
        PageDown: () => selectSuggest(Math.min(suggest!.selected + page, suggest!.shown.length - 1)),
        PageUp: () => selectSuggest(Math.max(suggest!.selected - page, 0)),
        Enter: () => void acceptSuggest(),
        Tab: () => void acceptSuggest(),
        Escape: closeSuggest,
      };
      const action = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? keys[e.key] : undefined;
      if (!action) {
        // The cursor leaves the word.
        if (/^(?:Arrow(?:Left|Right)|Home|End)$/.test(e.key)) closeSuggest();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      action();
    },
    { capture: true },
  );
  host.addEventListener("pointerdown", closeSuggest, { capture: true });
  host.addEventListener("wheel", closeSuggest, { capture: true, passive: true });
  host.addEventListener("focusout", (e) => {
    if (!suggestBox.contains(e.relatedTarget as Node | null)) closeSuggest();
  });
  // Clicking an entry accepts it; the editor keeps the focus.
  suggestBox.addEventListener("pointerdown", (e) => e.preventDefault());
  suggestList.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
    if (!row || !suggest) return;
    suggest.selected = Number(row.dataset.index);
    void acceptSuggest();
  });

  // Parameter hints (events.signatureHelp): the signature of the call the cursor is in, above its line. Typing `(`,
  // `,` or `<` (or the shortcut) shows them; while shown, every cursor move asks again, which hides them once the
  // cursor leaves the call. Up and Down pick another overload when there are several.
  const sigBox = document.createElement("div");
  sigBox.className = "editor-hover editor-signature";
  sigBox.setAttribute("role", "tooltip");
  sigBox.hidden = true;
  parent.append(sigBox);
  let signature: { help: EditorSignatureHelp; line: number } | undefined;
  let signatureSeq = 0;

  function hideSignature() {
    signatureSeq++;
    signature = undefined;
    sigBox.hidden = true;
  }

  async function requestSignature(trigger?: string) {
    const caret = caretPos();
    if (!events.signatureHelp || !caret) return hideSignature();
    const mine = ++signatureSeq;
    const at = path;
    const help = await events.signatureHelp(at, caret.line + 1, caret.character + 1, trigger, !!signature).catch(() => null);
    if (mine !== signatureSeq || at !== path) return;
    if (!help) return hideSignature();
    // Keep the overload picked with Up/Down while the same list shows.
    const old = signature?.help;
    if (old && old.signatures.length === help.signatures.length && old.signatures.every((s, i) => s.label === help.signatures[i].label)) help.active = old.active;
    signature = { help, line: caret.line };
    showSignature();
  }

  function showSignature() {
    const caret = caretPos();
    if (!signature || !caret) return hideSignature();
    sigBox.innerHTML = signatureHtml(signature.help);
    sigBox.hidden = false;
    const at = rectAt(caret.line, caret.character);
    if (!at) return hideSignature();
    const { offsetWidth: width, offsetHeight: height } = sigBox;
    const above = at.top - height - 2;
    sigBox.style.top = `${above >= 4 ? above : at.bottom + 2}px`;
    sigBox.style.left = `${Math.max(4, Math.min(at.left - 8, innerWidth - width - 4))}px`;
  }

  host.addEventListener(
    "keydown",
    (e) => {
      // The completion list has these keys while it's open (and took this one if it just closed).
      if (!signature || suggest || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const { help } = signature;
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (e.key === "Escape") hideSignature();
      else if (step && help.signatures.length > 1) {
        help.active = (help.active + step + help.signatures.length) % help.signatures.length;
        showSignature();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true },
  );

  onTheme((next) => {
    if (next === theme) return;
    theme = next;
    if (!view) return;
    view.setOptions({ ...view.options, theme });
    view.onThemeChange();
  });

  function close() {
    hideHover();
    closeSuggest();
    hideSignature();
    finish?.();
    finish = undefined;
    editor = undefined;
    view?.cleanUp();
    view = undefined;
  }

  /** Whether the current editor shows markers (a fresh one shows none). */
  let shown = false;
  /**
   * The editor sets up its text document a few frames after `edit()` and throws on markers before that, so
   * markers wait for it. Clearing markers that aren't shown is skipped.
   */
  function applyMarkers(frames = 30) {
    const current = editor;
    if (!current || (!markers.length && !shown)) return;
    try {
      current.setMarkers(markers);
      shown = markers.length > 0;
    } catch (e) {
      if (!frames) return console.warn("[editor] markers dropped:", e);
      requestAnimationFrame(() => editor === current && applyMarkers(frames - 1));
    }
  }

  function show(nextPath: string, nextText: string | null) {
    close();
    if (nextPath !== path) {
      markers = [];
      events.onDiagnostics?.([]);
    }
    path = nextPath;
    text = nextText ?? "";
    view = new File({
      theme,
      // The tab above already names the file.
      disableFileHeader: true,
      // style.css's thin scrollbars: scrollbar-width doesn't inherit into the shadow root (the color does).
      // The code area fills the pane (style.css stretches the host), so clicks below the last line land in the
      // editor and the horizontal scrollbar sits at the bottom; align-content keeps the line rows from stretching.
      unsafeCSS: `* { scrollbar-width: thin; }
        :host { display: flex; flex-direction: column; }
        pre { flex: 1 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); }
        code { align-self: stretch; align-content: start; }${HOVER_CSS}`,
      onTokenEnter,
      onTokenLeave,
      onEditChange(event) {
        const before = text;
        text = event.file.contents;
        listener(text);
        onMove();
        onTyped(before);
      },
      // The VFS already holds every change from onEditChange; keep the surface showing it.
      onEditComplete: () => "accept",
    });
    view.render({ containerWrapper: host, file: { name: path, contents: nextText ?? "(binary file)" } });
    if (nextText === null || events.readOnly?.()) return;
    editor = new Editor("file");
    shown = false;
    finish = editor.edit(view);
    if (markers.length) applyMarkers();
    onMove();
  }

  return {
    open(nextPath, nextText, onChange) {
      listener = onChange;
      show(nextPath, nextText);
    },
    update(nextText) {
      if (nextText !== text) show(path, nextText);
    },
    setDiagnostics(diagnostics) {
      markers = diagnostics.map((d) => ({
        severity: d.severity,
        message: { html: hoverHtml(d) },
        start: { line: d.line - 1, character: d.column - 1 },
        end: { line: d.line - 1, character: d.column - 1 + Math.max(d.length, 1) },
      }));
      applyMarkers();
      events.onDiagnostics?.(diagnostics);
    },
    showHover() {
      const sel = editor?.getViewState().selections?.[0];
      const caret = sel?.direction === -1 ? sel.start : sel?.end;
      const token = caret && tokenAt(caret.line, caret.character);
      if (token) hoverToken(token, 0);
    },
    showSignatureHelp() {
      if (editor && host.contains(document.activeElement)) void requestSignature();
    },
    suggest() {
      if (editor && host.contains(document.activeElement)) void requestSuggest();
    },
    reveal(line, column) {
      editor?.focus({ lineNumber: line, character: column - 1 });
      onMove();
    },
    getText: () => editor?.getText() ?? text,
    replace(next) {
      const current = editor?.getText();
      if (!editor || current === undefined || next === current) return;
      // Only the span that differs, so the cursor and the lines around it don't move.
      let start = 0;
      while (start < current.length && start < next.length && current[start] === next[start]) start++;
      let end = 0;
      while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++;
      const at = (offset: number) => {
        const before = current.slice(0, offset);
        const line = before.split("\n").length - 1;
        return { line, character: offset - (before.lastIndexOf("\n") + 1) };
      };
      editor.applyEdits([{ range: { start: at(start), end: at(current.length - end) }, newText: next.slice(start, next.length - end) }]);
    },
    clear() {
      close();
      host.replaceChildren();
      path = text = "";
      markers = [];
      listener = () => {};
      events.onDiagnostics?.([]);
      reportCursor();
    },
    destroy() {
      close();
      host.remove();
      tip.remove();
      suggestBox.remove();
      sigBox.remove();
    },
  };
}
