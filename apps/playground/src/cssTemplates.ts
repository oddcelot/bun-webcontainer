// Hovers, completions and errors for the CSS in css`…` tagged templates (Lit, styled-components) of a JS/TS file:
// vscode-css-languageservice (what VS Code's CSS support runs on), loaded once a file has such a template. The service
// reads one template at a time as a stylesheet the length of the whole file, everything else blanked out, so its lines
// and columns are the file's. A `${…}` in it reads as a name (`_____`), or as nothing where a rule could start.
import type { EditorCompletions, EditorDiagnostic, EditorHover } from "./editors/types";
import { literalRanges } from "./literals";
import { toCompletions, toHover } from "./lspItems";

/** The text of a template between its delimiters (the backticks, `${` and `}`), as `[start, end)` offsets. */
type Template = [number, number][];

/** A `css` tag right before a template's backtick (`css`, `lit.css`). */
const CSS_TAG = /(?:^|[^\w$])css\s*$/;

/** The file's css`…` templates, outermost first. */
export function cssTemplates(code: string): Template[] {
  const found: Template[] = [];
  // Templates whose `${` is open, innermost last: a `}` piece continues the one on top.
  const open: (Template | null)[] = [];
  const add = (t: Template | null, start: number, end: number) => {
    const resumes = code.startsWith("${", end - 2);
    if (resumes) open.push(t);
    t?.push([start, resumes ? end - 2 : code[end - 1] === "`" && end - 1 >= start ? end - 1 : end]);
  };
  for (const [from, to] of literalRanges(code)) {
    if (code[from] === "`") {
      const t = CSS_TAG.test(code.slice(Math.max(0, from - 32), from)) ? [] : null;
      if (t) found.push(t);
      add(t, from + 1, to);
    } else if (code[from] === "}") add(open.pop() ?? null, from + 1, to);
  }
  return found;
}

/** The template whose text holds `offset` (its end included, where typing goes). */
const templateAt = (templates: Template[], offset: number) => templates.find((t) => t.some(([s, e]) => s <= offset && offset <= e));

const blank = (s: string) => s.replace(/[^\r\n]/g, " ");

/** `t` as a stylesheet the length of `code`: the rest blanked, each `${…}` a name or blank (see the top). */
function stylesheet(code: string, t: Template): string {
  let out = blank(code.slice(0, t[0][0]));
  let dropSemicolon = false;
  for (let i = 0; i < t.length; i++) {
    let piece = code.slice(t[i][0], t[i][1]);
    // `${shared};` where a rule could start: the `;` would be a stray one.
    if (dropSemicolon) piece = piece.replace(/^(\s*);/, "$1 ");
    out += piece;
    const next = t[i + 1];
    if (!next) break;
    const gap = code.slice(t[i][1], next[0]);
    const rule = /(?:^|[;{}])$/.test(out.trimEnd()) && !/^\s*\{/.test(code.slice(next[0]));
    out += rule ? blank(gap) : gap.replace(/[^\r\n]/g, "_");
    dropSemicolon = rule;
  }
  return out + blank(code.slice(t.at(-1)![1]));
}

type Service = typeof import("vscode-css-languageservice");
let loading: Promise<{ m: Service; ls: ReturnType<Service["getCSSLanguageService"]> }> | undefined;

function service() {
  // A failed load (offline, a dev server that re-optimized) isn't kept: the next hover or keystroke tries again.
  return (loading ??= import("vscode-css-languageservice")
    .catch((e) => {
      loading = undefined;
      throw e;
    })
    .then((m) => ({ m, ls: m.getCSSLanguageService() })));
}

async function documentOf(code: string, t: Template) {
  const { m, ls } = await service();
  const doc = m.TextDocument.create("file:///template.css", "css", 1, stylesheet(code, t));
  return { m, ls, doc, sheet: ls.parseStylesheet(doc) };
}

/** UTF-16 offset of a 1-based line and column. */
function offsetOf(code: string, line: number, column: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const nl = code.indexOf("\n", at);
    if (nl < 0) return code.length;
    at = nl + 1;
  }
  return at + column - 1;
}

/** The css`…` template at a 1-based line and column, if the position is in its text (not in a `${…}`). */
export function cssTemplateAt(code: string, line: number, column: number): Template | undefined {
  return code.includes("css") ? templateAt(cssTemplates(code), offsetOf(code, line, column)) : undefined;
}

/**
 * The service's docs for the editor's renderer, which escapes HTML and shows no images: the Baseline icon (a data: URL
 * before "Widely available…") goes, and `&lt;display-inside&gt;` reads as `<display-inside>`.
 */
const tidy = (md: string) =>
  md
    .replace(/!\[[^\]]*\]\([^)]*\)\s*/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** What the CSS service says about the property, value or selector under the pointer. */
export async function cssHover(code: string, t: Template, line: number, column: number): Promise<EditorHover | null> {
  const { ls, doc, sheet } = await documentOf(code, t);
  const h = toHover(ls.doHover(doc, { line: line - 1, character: column - 1 }, sheet));
  return h && { ...h, docs: tidy(h.docs) };
}

/** Properties, values, pseudo-classes and at-rules at the cursor. */
export async function cssComplete(code: string, t: Template, line: number, column: number): Promise<EditorCompletions | null> {
  const { ls, doc, sheet } = await documentOf(code, t);
  const at = { line: line - 1, character: column - 1 };
  const list = toCompletions(ls.doComplete(doc, at, sheet), at);
  for (const item of list?.items ?? []) {
    const ref = item.ref as { docs: string };
    ref.docs = tidy(ref.docs);
  }
  return list;
}

/** Syntax errors and lint warnings (unknown properties, empty rules) in every css`…` template of the file. */
export async function cssDiagnostics(code: string): Promise<EditorDiagnostic[]> {
  if (!code.includes("css")) return [];
  const templates = cssTemplates(code);
  const out: EditorDiagnostic[] = [];
  for (const t of templates) {
    const { m, ls, doc, sheet } = await documentOf(code, t);
    for (const d of ls.doValidation(doc, sheet)) {
      const start = doc.offsetAt(d.range.start);
      // Not one about a `${…}` stand-in.
      if (!t.some(([s, e]) => s <= start && start < e)) continue;
      const { line, character } = d.range.start;
      const end = d.range.end;
      out.push({
        severity: d.severity === m.DiagnosticSeverity.Error ? "error" : "warning",
        message: d.message,
        line: line + 1,
        column: character + 1,
        length: end.line === line ? Math.max(end.character - character, 0) : 0,
        source: "css",
      });
    }
  }
  return out;
}
