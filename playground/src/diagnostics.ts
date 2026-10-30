import type { CodeEditor, EditorDiagnostic } from "./editors/types";
import { tsconfigFor } from "./moduleServer";
import { transpile, TranspileError } from "./transpiler";
import { typecheck, TYPED } from "./typecheck";
import type { VFS } from "./vfs";

/** Files whose parse (and type) errors the editor marks as you type. */
export const CHECKED = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_BYTES = 500_000;
const DEBOUNCE_MS = 300;

/** UTF-8 byte offset into `line` -> UTF-16 index. */
function utf16Index(line: string, bytes: number): number {
  let b = 0;
  let i = 0;
  while (i < line.length && b < bytes) {
    const cp = line.codePointAt(i)!;
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

/** Parse errors of `text` (the transpiler's, no resolver) as editor markers; when it parses, type errors for TypeScript. */
export async function diagnose(vfs: VFS, path: string, text: string): Promise<EditorDiagnostic[]> {
  try {
    await transpile(text, path, tsconfigFor(vfs, path));
    return TYPED.test(path) ? await typecheck(vfs, path, text) : [];
  } catch (e) {
    if (!(e instanceof TranspileError)) return [];
    const lines = text.split("\n");
    const out: EditorDiagnostic[] = [];
    for (const d of e.diagnostics) {
      if (!d.line || d.line > lines.length) continue;
      const line = lines[d.line - 1].replace(/\r$/, "");
      const start = utf16Index(line, (d.column ?? 1) - 1);
      const end = utf16Index(line, (d.column ?? 1) - 1 + (d.length ?? 0));
      out.push({ severity: d.severity, message: d.text, line: d.line, column: start + 1, length: end - start, source: "bun" });
    }
    return out;
  }
}

/** Debounced parse- and type-error markers for the file in `editor`; call `check(path, text)` on open and on every edit. */
export function mountDiagnostics(vfs: VFS, editor: CodeEditor) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  return (path: string | null, text: string | null) => {
    clearTimeout(timer);
    const mine = ++seq;
    if (!path || text === null || !CHECKED.test(path) || text.length > MAX_BYTES) return editor.setDiagnostics([]);
    timer = setTimeout(async () => {
      const found = await diagnose(vfs, path, text);
      if (mine === seq) editor.setDiagnostics(found);
    }, DEBOUNCE_MS);
  };
}
