// Completions, hovers and errors for .json files in the editor, from a JSON schema: vscode-json-languageservice (what
// VS Code's JSON support runs on), loaded on first use. runbun.json gets its schema (src/schema/runbun.json) bundled,
// whether or not it says `$schema`; another file's own `$schema` URL is fetched (https only). JSONC (comments, trailing
// commas) for runbun.json and tsconfig/jsconfig, strict JSON elsewhere.
import type { EditorCompletion, EditorCompletionDetails, EditorCompletions, EditorDiagnostic, EditorHover, CompletionKind } from "./editors/types";
import runbunSchema from "./schema/runbun.json";
import { CONFIG_FILE } from "./projectConfig";

export const JSON_FILE = /\.json$/;
const RUNBUN_SCHEMA = "https://runbun.dev/schema/runbun.json";
/** Files whose readers allow comments and trailing commas. */
const JSONC = /(^|\/)(runbun|tsconfig(\.[\w-]+)?|jsconfig)\.json$/;

type Service = typeof import("vscode-json-languageservice");
let loading: Promise<{ m: Service; ls: ReturnType<Service["getLanguageService"]> }> | undefined;

function service() {
  return (loading ??= import("vscode-json-languageservice").then((m) => {
    const ls = m.getLanguageService({
      // A schema a file names by URL. Ours is bundled (below), so this only runs for other ones.
      schemaRequestService: async (uri) => {
        if (!uri.startsWith("https://")) throw new Error(`not fetched: ${uri}`);
        const res = await fetch(uri);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      },
      clientCapabilities: m.ClientCapabilities.LATEST,
    });
    ls.configure({ validate: true, allowComments: true, schemas: [{ uri: RUNBUN_SCHEMA, fileMatch: [`**/${CONFIG_FILE}`], schema: runbunSchema }] });
    return { m, ls };
  }));
}

async function documentOf(path: string, text: string) {
  const { m, ls } = await service();
  const doc = m.TextDocument.create(`file:///${path}`, JSONC.test(path) ? "jsonc" : "json", 1, text);
  return { m, ls, doc, json: ls.parseJSONDocument(doc) };
}

/** Schema errors and syntax errors (comments and trailing commas only where the file allows them). */
export async function jsonDiagnostics(path: string, text: string): Promise<EditorDiagnostic[]> {
  const { m, ls, doc, json } = await documentOf(path, text);
  const loose = JSONC.test(path);
  const found = await ls.doValidation(doc, json, { comments: loose ? "ignore" : "error", trailingCommas: loose ? "ignore" : "error", schemaValidation: "warning" });
  const lines = text.split("\n");
  return found.map((d) => {
    const { start, end } = d.range;
    const length = start.line === end.line ? end.character - start.character : (lines[start.line]?.length ?? 0) - start.character;
    return {
      severity: d.severity === m.DiagnosticSeverity.Error ? "error" : "warning",
      message: typeof d.message === "string" ? d.message : d.message.value,
      line: start.line + 1,
      column: start.character + 1,
      length: Math.max(length, 0),
      source: "json",
    };
  });
}

/** What the schema says about the property or value under the pointer. */
export async function jsonHover(path: string, text: string, line: number, column: number): Promise<EditorHover | null> {
  const { ls, doc, json } = await documentOf(path, text);
  const h = await ls.doHover(doc, { line: line - 1, character: column - 1 }, json);
  if (!h) return null;
  const parts = Array.isArray(h.contents) ? h.contents : [h.contents];
  const docs = unescape(parts.map((p) => (typeof p === "string" ? p : "value" in p ? p.value : "")).filter(Boolean).join("\n\n"));
  return docs ? { code: "", docs } : null;
}

/** The service's markdown escapes (`\(true\)`): the editor's renderer shows plain text with code spans. */
const unescape = (md: string) => md.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1");

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

/** Property names, values and snippets the schema allows at the cursor. */
export async function jsonComplete(path: string, text: string, line: number, column: number): Promise<EditorCompletions | null> {
  const { m, ls, doc, json } = await documentOf(path, text);
  const at = { line: line - 1, character: column - 1 };
  const list = await ls.doComplete(doc, at, json);
  if (!list) return null;
  const items: EditorCompletion[] = [];
  for (const c of list.items) {
    const edit = c.textEdit && ("range" in c.textEdit ? c.textEdit : { newText: c.textEdit.newText, range: c.textEdit.replace });
    // Only edits on the cursor's line: the editor replaces from a column there up to (and just past) the cursor.
    if (edit && (edit.range.start.line !== at.line || edit.range.end.line !== at.line)) continue;
    const raw = edit?.newText ?? c.insertText ?? c.label;
    const { text: insert, cursor } = c.insertTextFormat === m.InsertTextFormat.Snippet ? plain(raw) : { text: raw, cursor: undefined };
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
      ref: { docs, detail: c.detail ?? "" },
    });
  }
  return { items, incomplete: list.isIncomplete };
}

/** A completion's documentation, beside the list. */
export function jsonCompletionDetails(item: EditorCompletion): EditorCompletionDetails | null {
  const ref = item.ref as { docs: string; detail: string } | undefined;
  return ref && (ref.docs || ref.detail) ? { code: "", docs: [ref.detail && `\`${ref.detail}\``, ref.docs].filter(Boolean).join("\n\n") } : null;
}
