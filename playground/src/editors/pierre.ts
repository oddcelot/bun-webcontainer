import { File } from "@pierre/diffs";
import { Editor, type Marker } from "@pierre/diffs/edit";
import { onTheme, themeName } from "../theme";
import type { CodeEditor, EditorDiagnostic, EditorEvents, EditorHover } from "./types";

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
    const open = /^(`{3,})/.exec(lines[i]);
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
    out.push(body.some((l) => l.startsWith("```")) ? docsHtml(body.join("\n")) : `<pre>${escapeHtml(body.join("\n"))}</pre>`);
  }
  flush();
  return out.join("");
}

const tipHtml = (h: EditorHover) =>
  (h.code ? `<pre class="editor-hover-code">${escapeHtml(h.code)}</pre>` : "") + (h.docs ? `<div class="editor-hover-docs">${docsHtml(h.docs)}</div>` : "");

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

  onTheme((next) => {
    if (next === theme) return;
    theme = next;
    if (!view) return;
    view.setOptions({ ...view.options, theme });
    view.onThemeChange();
  });

  function close() {
    hideHover();
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
        text = event.file.contents;
        listener(text);
        onMove();
      },
      // The VFS already holds every change from onEditChange; keep the surface showing it.
      onEditComplete: () => "accept",
    });
    view.render({ containerWrapper: host, file: { name: path, contents: nextText ?? "(binary file)" } });
    if (nextText === null) return;
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
    },
  };
}
