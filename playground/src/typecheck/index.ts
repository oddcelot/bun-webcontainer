import type { CompletionKind, EditorCompletion, EditorCompletions, EditorDiagnostic, EditorHover, EditorSignatureHelp } from "../editors/types";
import { dirname, type FileData, type VFS } from "../vfs";
import type { LspCompletionItem } from "./tsrsLs";
import type { LsOp, LsReply, LsRequest } from "./worker";

// Type errors, hovers, completions and signature help from tsrs's language service (see ./worker.ts). The project's files go to it as absolute
// paths ("/" + VFS path); from node_modules only declarations and JSON (package.json, configs a tsconfig `extends`,
// JSON imports), which is what type resolution reads. The worker adds Bun's own types where node_modules lacks them.

/** Files the type checker looks at. */
export const TYPED = /\.(?:[cm]?ts|tsx)$/;
const PROJECT = /\.(?:[cm]?[jt]sx?|json)$/;
const DECLARATIONS = /(?:\.d\.[cm]?ts|\.d\.[^/.]+\.ts|\.json)$/;

/** Where the config for a project without tsconfig.json goes: a folder of its own, so it shadows none of the project's files. */
const DEFAULT_CONFIG = "/.runbun/tsconfig.json";
/** Without tsconfig.json: what `bun init` writes plus Bun's types, with the DOM libs for code that runs in the preview. */
const DEFAULT_OPTIONS = {
  strict: true,
  target: "esnext",
  module: "preserve",
  moduleResolution: "bundler",
  moduleDetection: "force",
  allowImportingTsExtensions: true,
  allowJs: true,
  jsx: "react-jsx",
  lib: ["esnext", "dom", "dom.iterable"],
  skipLibCheck: true,
  noEmit: true,
  types: ["bun"],
};

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, (r: LsReply) => void>();
// What the worker holds, so each request sends only the files that changed (VFS writes replace the data).
const sent = new Map<string, FileData>();

function nearestTsconfig(vfs: VFS, path: string): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const p = dir ? `${dir}/tsconfig.json` : "tsconfig.json";
    if (vfs.files.has(p)) return p;
    if (!dir) return undefined;
  }
}

/** Sends `op` for `path` (contents `text`, unsaved edits included) with what changed in the project since the last request. */
function request(vfs: VFS, path: string, text: string, op: LsOp): Promise<LsReply> {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<LsReply>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
  }
  const files = new Map<string, FileData>();
  for (const [p, data] of vfs.files) {
    if (p.startsWith("node_modules/") || p.includes("/node_modules/") ? DECLARATIONS.test(p) : PROJECT.test(p)) files.set("/" + p, data);
  }
  files.set("/" + path, text);
  const tsconfig = nearestTsconfig(vfs, path);
  const config = tsconfig ? "/" + tsconfig : DEFAULT_CONFIG;
  if (!tsconfig) files.set(DEFAULT_CONFIG, JSON.stringify({ compilerOptions: DEFAULT_OPTIONS, files: ["../" + path] }));

  const changed: LsRequest["changed"] = {};
  for (const [p, data] of files) {
    if (sent.get(p) !== data) changed[p] = data;
    sent.set(p, data);
  }
  const removed = [...sent.keys()].filter((p) => !files.has(p));
  for (const p of removed) sent.delete(p);
  const id = ++nextId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker!.postMessage({ id, changed, removed, config, path: "/" + path, ...op } satisfies LsRequest);
  });
}

// One type check at a time; of those asked for meanwhile, only the newest runs.
let inFlight: Promise<unknown> = Promise.resolve();
let latest = 0;

/** Type errors in `path`, with `text` as its contents (unsaved edits included). */
export async function typecheck(vfs: VFS, path: string, text: string): Promise<EditorDiagnostic[]> {
  const mine = ++latest;
  await inFlight;
  // Superseded: the caller has asked again since, and drops this result.
  if (mine !== latest) return [];
  const running = request(vfs, path, text, { kind: "diagnostics" });
  inFlight = running;
  const r = await running;
  if (r.error) console.warn(`tsrs: ${r.error}`);
  const out: EditorDiagnostic[] = [];
  for (const d of r.diagnostics ?? []) {
    if (d.severity !== 1 && d.severity !== 2) continue;
    const { start, end } = d.range;
    out.push({
      severity: d.severity === 1 ? "error" : "warning",
      message: d.message,
      source: `ts(${d.code})`,
      line: start.line + 1,
      column: start.character + 1,
      length: end.line === start.line ? end.character - start.character : 0,
    });
  }
  return out;
}

/** Type information at `line`/`column` (1-based, UTF-16) of `path`, or null. */
export async function hover(vfs: VFS, path: string, text: string, line: number, column: number): Promise<EditorHover | null> {
  const r = await request(vfs, path, text, { kind: "hover", line: line - 1, character: column - 1 });
  if (r.error) console.warn(`tsrs: ${r.error}`);
  const value = r.hover?.contents.value;
  if (!value) return null;
  // The language service's markdown: the declaration in a ```typescript block, then the JSDoc.
  const m = /^```\w*\n([\s\S]*?)\n```\n?([\s\S]*)$/.exec(value);
  return m ? { code: m[1], docs: m[2].trim() } : { code: "", docs: value.trim() };
}

/** LSP's CompletionItemKind, by number. */
const KINDS: Record<number, CompletionKind> = {
  2: "function",
  3: "function",
  4: "function",
  5: "property",
  6: "variable",
  7: "class",
  8: "interface",
  9: "module",
  10: "property",
  13: "enum",
  14: "keyword",
  17: "file",
  19: "folder",
  20: "constant",
  21: "constant",
  22: "class",
  23: "property",
  25: "type",
};

/** The completions at `line`/`column` (1-based, UTF-16) of `path`; `trigger` is the character just typed, if that's what asked. */
export async function complete(vfs: VFS, path: string, text: string, line: number, column: number, trigger = ""): Promise<EditorCompletions | null> {
  const r = await request(vfs, path, text, { kind: "completion", line: line - 1, character: column - 1, trigger });
  if (r.error) console.warn(`tsrs: ${r.error}`);
  if (!r.completion) return null;
  // DEFAULT_CONFIG's folder isn't the project's.
  const items = r.completion.items.filter((i) => i.label !== ".runbun").map((i): EditorCompletion => {
    const edit = i.textEdit;
    const range = edit && ("range" in edit ? edit.range : edit.insert);
    return {
      label: i.label,
      kind: KINDS[i.kind ?? 1] ?? "text",
      description: i.labelDetails?.description,
      insert: edit?.newText ?? i.insertText ?? i.label,
      start: range && range.start.line === line - 1 ? range.start.character + 1 : undefined,
      sort: i.sortText ?? i.label,
      filter: i.filterText ?? i.label,
      ref: i,
    };
  });
  return { items, incomplete: r.completion.isIncomplete };
}

/** The declaration and documentation of `item` (from `complete` for `path`), or null. */
export async function resolveCompletion(vfs: VFS, path: string, text: string, item: EditorCompletion): Promise<EditorHover | null> {
  const r = await request(vfs, path, text, { kind: "resolve", item: item.ref as LspCompletionItem });
  if (r.error) console.warn(`tsrs: ${r.error}`);
  const doc = r.item?.documentation;
  const docs = (typeof doc === "string" ? doc : doc?.value ?? "").trim();
  // A path's detail is its name again.
  const code = r.item?.detail === item.label ? "" : (r.item?.detail ?? "");
  return code || docs ? { code, docs } : null;
}

const markdown = (doc: string | { value: string } | undefined) => (typeof doc === "string" ? doc : (doc?.value ?? "")).trim();

/** The signatures of the call around `line`/`column` (1-based, UTF-16) of `path`, or null; `retrigger` while they're showing. */
export async function signatureHelp(vfs: VFS, path: string, text: string, line: number, column: number, trigger = "", retrigger = false): Promise<EditorSignatureHelp | null> {
  const r = await request(vfs, path, text, { kind: "signature", line: line - 1, character: column - 1, trigger, retrigger });
  if (r.error) console.warn(`tsrs: ${r.error}`);
  const help = r.signature;
  if (!help?.signatures.length) return null;
  const active = Math.min(help.activeSignature ?? 0, help.signatures.length - 1);
  const signatures = help.signatures.map((sig) => {
    // A parameter given as text is the next place that text appears, after the opening parenthesis.
    let from = sig.label.indexOf("(") + 1;
    const params = (sig.parameters ?? []).map((p) => {
      let [start, end] = typeof p.label === "string" ? [sig.label.indexOf(p.label, from), 0] : p.label;
      if (typeof p.label === "string") end = start + p.label.length;
      if (start >= 0) from = end;
      return { start, end, docs: markdown(p.documentation) };
    });
    return { label: sig.label, params, docs: markdown(sig.documentation) };
  });
  const param = help.signatures[active].activeParameter;
  return { signatures, active, param: param ?? undefined };
}
