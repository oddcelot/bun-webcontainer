// What vscode-*-languageservice (LSP types) returns, as the editor's hovers and completions: shared by .json files
// (jsonLanguage.ts) and CSS in tagged templates (cssTemplates.ts).
import type { CompletionKind, EditorCompletion, EditorCompletionDetails, EditorCompletions, EditorHover } from "./editors/types";

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Markup = string | { value: string } | { language: string; value: string };
type LspHover = { contents: Markup | Markup[] };
type LspCompletion = {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  /** 2: a snippet. */
  insertTextFormat?: number;
  textEdit?: { newText: string; range: Range } | { newText: string; insert: Range; replace: Range };
};
type LspCompletionList = { items: LspCompletion[]; isIncomplete: boolean };

/** What an item from `toCompletions` keeps for `lspCompletionDetails`. */
type Ref = { lsp: true; docs: string; detail: string };

/** The service's markdown escapes (`\(true\)`): the editor's renderer shows plain text with code spans. */
export const unescape = (md: string) => md.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1");

/** A hover's contents as the editor's docs (null: nothing to show). */
export function toHover(h: LspHover | null | undefined): EditorHover | null {
  if (!h) return null;
  const parts = Array.isArray(h.contents) ? h.contents : [h.contents];
  const docs = unescape(parts.map((p) => (typeof p === "string" ? p : p.value)).filter(Boolean).join("\n\n"));
  return docs ? { code: "", docs } : null;
}

const KINDS: Record<number, CompletionKind> = { 5: "property", 6: "variable", 9: "module", 10: "property", 12: "constant", 13: "enum", 14: "keyword", 15: "keyword", 17: "file", 19: "folder", 20: "enum", 21: "constant" };

/**
 * A snippet (`"${1:name}": ${2}`) as plain text, and the offset of its first stop: the editor inserts text and places
 * the cursor, without tab stops.
 */
function plain(snippet: string): { text: string; cursor?: number } {
  let text = "";
  let cursor: number | undefined;
  let first = Infinity;
  for (let i = 0; i < snippet.length; i++) {
    const c = snippet[i];
    if (c === "\\" && i + 1 < snippet.length) {
      text += snippet[++i];
      continue;
    }
    if (c !== "$") {
      text += c;
      continue;
    }
    const simple = /^\$(\d+)/.exec(snippet.slice(i));
    const braced = /^\$\{(\d+)(?::([^}]*))?\}/.exec(snippet.slice(i));
    const m = braced ?? simple;
    if (!m) {
      text += c;
      continue;
    }
    // $0 is where the cursor ends up last: the first stop otherwise ($1) is where typing goes next.
    const n = Number(m[1]) || Infinity;
    if (n < first) [first, cursor] = [n, text.length];
    else if (n === Infinity && cursor === undefined) cursor = text.length;
    text += (braced?.[2] ?? "").replace(/\\(.)/g, "$1");
    i += m[0].length - 1;
  }
  return { text, cursor };
}

/** A completion list at `at` (zero-based) as the editor's items. */
export function toCompletions(list: LspCompletionList | null | undefined, at: Position): EditorCompletions | null {
  if (!list) return null;
  const items: EditorCompletion[] = [];
  for (const c of list.items) {
    const edit = c.textEdit && ("range" in c.textEdit ? c.textEdit : { newText: c.textEdit.newText, range: c.textEdit.replace });
    // Only edits on the cursor's line: the editor replaces from a column there up to (and just past) the cursor.
    if (edit && (edit.range.start.line !== at.line || edit.range.end.line !== at.line)) continue;
    const raw = edit?.newText ?? c.insertText ?? c.label;
    const { text: insert, cursor } = c.insertTextFormat === 2 ? plain(raw) : { text: raw, cursor: undefined };
    const docs = unescape(typeof c.documentation === "string" ? c.documentation : (c.documentation?.value ?? ""));
    items.push({
      label: c.label,
      kind: KINDS[c.kind ?? 0] ?? "text",
      description: c.detail,
      insert,
      cursor,
      start: edit ? edit.range.start.character + 1 : undefined,
      after: edit && edit.range.end.character > at.character ? edit.range.end.character - at.character : undefined,
      sort: c.sortText ?? c.label,
      filter: c.filterText ?? c.label,
      ref: { lsp: true, docs, detail: c.detail ?? "" } satisfies Ref,
    });
  }
  return { items, incomplete: list.isIncomplete };
}

/** Whether `item` came from `toCompletions` (not from the TypeScript service). */
export const isLspItem = (item: EditorCompletion) => (item.ref as Ref | undefined)?.lsp === true;

/** A completion's documentation, beside the list. */
export function lspCompletionDetails(item: EditorCompletion): EditorCompletionDetails | null {
  const ref = item.ref as Ref | undefined;
  return ref && (ref.docs || ref.detail) ? { code: "", docs: [ref.detail && `\`${ref.detail}\``, ref.docs].filter(Boolean).join("\n\n") } : null;
}
