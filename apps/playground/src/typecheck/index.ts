import type { CompletionKind, EditorCompletion, EditorCompletionDetails, EditorCompletions, EditorDiagnostic, EditorHover, EditorLocation, EditorSignatureHelp } from "../editors/types";
import type { FileContents, VFS } from "@runbun/vfs";
import { nearestTsconfig } from "../tsconfig";
import { projectRx, RX, RxView, rxView } from "./rx";
import type { LspCompletionItem } from "./tsrsLs";
import type { LsOp, LsRead, LsReply, LsRequest } from "./worker";

// Type errors, hovers, completions, signature help and definitions from tsrs's language service (see ./worker.ts). The project's files go to it as absolute
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

/** The project's scripts, for DEFAULT_CONFIG's `files`. */
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, (r: LsReply) => void>();
// What the worker holds, so each request sends only the files that changed (VFS writes replace the data).
const sent = new Map<string, FileContents>();

function lsWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<LsReply>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
  }
  return worker;
}

/** An answer, and for a ReactiveScript module the projection it was asked of (./rx.ts). */
type Reply = LsReply & { view?: RxView };
/** A request at a position: null where a ReactiveScript module has nothing the type checker knows. */
type OpAt = (at: { line: number; character: number }) => LsOp;

/** `op` at a 1-based line and UTF-16 column of the file the request is for; in a ReactiveScript module, at the same text in its projection. */
const at = (line: number, column: number, op: OpAt) => (view: RxView | undefined, rx: boolean) => {
  const position = rx ? view?.toProjection(line, column) : { line: line - 1, character: column - 1 };
  return position ? op(position) : null;
};

/**
 * Sends `op` for `path` (contents `text`, unsaved edits included) with what changed in the project since the last
 * request. A ReactiveScript module is asked about through its projection, `<path>.tsx`.
 */
async function request(vfs: VFS, path: string, text: string, op: LsOp | ((view: RxView | undefined, rx: boolean) => LsOp | null)): Promise<Reply> {
  lsWorker();
  const wanted = [...vfs.files.keys()].filter((p) => (p.startsWith("node_modules/") || p.includes("/node_modules/") ? DECLARATIONS.test(p) : PROJECT.test(p)));
  // Installs keep declarations in memory; this only matters if one was left in the package store.
  await vfs.ensure(wanted);
  const files = new Map<string, FileContents>();
  for (const p of wanted) {
    const data = vfs.data(p);
    if (data !== undefined) files.set("/" + p, data);
  }
  const rx = RX.test(path);
  if (!rx) files.set("/" + path, text);
  // The project's .rx modules, as the TSX the type checker reads; without the compiler they go unchecked.
  await projectRx(vfs, files, path, text).catch((e) => console.warn(`rxc: ${e}`));
  const view = rx ? rxView(path) : undefined;
  const asked = typeof op === "function" ? op(view, rx) : op;
  if (!asked || (rx && !view)) return { id: 0 };
  // The config the transpiler reads too (moduleServer.ts); tsrs parses it itself, `extends` and jsconfig.json's
  // defaults included, so the project's compilerOptions (JSX among them) apply as they would in `tsc`.
  const tsconfig = nearestTsconfig(vfs, path);
  const config = tsconfig ? "/" + tsconfig : DEFAULT_CONFIG;
  // Every script of the project, as `tsc` would see it, so completions can import from any of them and switching tabs
  // keeps the program (errors are still asked for one file at a time). Listed: tsrs matches no `include` pattern
  // that climbs out of the config's folder.
  if (!tsconfig) {
    const scripts = [...files.keys()].filter((p) => SCRIPT.test(p) && !p.includes("/node_modules/")).sort();
    files.set(DEFAULT_CONFIG, JSON.stringify({ compilerOptions: DEFAULT_OPTIONS, files: scripts.map((p) => ".." + p) }));
  }

  const changed: LsRequest["changed"] = {};
  for (const [p, data] of files) {
    if (sent.get(p) !== data) changed[p] = data;
    sent.set(p, data);
  }
  const removed = [...sent.keys()].filter((p) => !files.has(p));
  for (const p of removed) sent.delete(p);
  const id = ++nextId;
  return new Promise((resolve) => {
    waiting.set(id, (r) => resolve({ ...r, view }));
    worker!.postMessage({ id, changed, removed, config, path: "/" + path + (rx ? ".tsx" : ""), ...asked } satisfies LsRequest);
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
  // A ReactiveScript module: the compiler's own errors first, then the type errors where they are in the module.
  const out: EditorDiagnostic[] = r.view?.diagnostics() ?? [];
  for (const d of r.diagnostics ?? []) {
    if (d.severity !== 1 && d.severity !== 2) continue;
    if (r.view && RxView.ignores(d.code)) continue;
    const { start, end } = d.range;
    const where = r.view
      ? r.view.toModule(d.range)
      : { line: start.line + 1, column: start.character + 1, length: end.line === start.line ? end.character - start.character : 0 };
    if (!where) continue;
    out.push({ severity: d.severity === 1 ? "error" : "warning", message: d.message, source: `ts(${d.code})`, ...where });
  }
  return out;
}

/** Type information at `line`/`column` (1-based, UTF-16) of `path`, or null. */
export async function hover(vfs: VFS, path: string, text: string, line: number, column: number): Promise<EditorHover | null> {
  const r = await request(vfs, path, text, at(line, column, (p) => ({ kind: "hover", ...p })));
  if (r.error) console.warn(`tsrs: ${r.error}`);
  const value = r.hover?.contents.value;
  if (!value) return null;
  // The language service's markdown: the declaration in a ```typescript block, then the JSDoc.
  const m = /^```\w*\n([\s\S]*?)\n```\n?([\s\S]*)$/.exec(value);
  return m ? { code: m[1], docs: m[2].trim() } : { code: "", docs: value.trim() };
}

/**
 * Where the name at `line`/`column` (1-based, UTF-16) of `path` is declared: 1-based positions of the declarations'
 * names, in VFS paths, or `readOnly` in a declaration file the project doesn't have: one of TypeScript's libs
 * (`bundled:///libs/lib.es5.d.ts`) or Bun's types bundled with the playground (`/node_modules/@types/bun/…`), whose
 * text `readTypes` gives.
 */
export async function definition(vfs: VFS, path: string, text: string, line: number, column: number): Promise<EditorLocation[]> {
  const r = await request(vfs, path, text, at(line, column, (p) => ({ kind: "definition", ...p })));
  if (r.error) console.warn(`tsrs: ${r.error}`);
  const d = r.definition;
  const all = !d ? [] : Array.isArray(d) ? d : [d];
  const out: EditorLocation[] = [];
  for (const l of all) {
    const [uri, range] = "targetUri" in l ? [l.targetUri, l.targetSelectionRange] : [l.uri, l.range];
    const at = { line: range.start.line + 1, column: range.start.character + 1 };
    if (uri.startsWith("bundled:///")) out.push({ path: uri, ...at, readOnly: true });
    if (!uri.startsWith("file:///")) continue;
    const file = decodeURIComponent(uri.slice("file:///".length));
    // A declaration in a ReactiveScript module's projection is at the same name in the module.
    const module = file.endsWith(".rx.tsx") ? file.slice(0, -".tsx".length) : undefined;
    const declared = module === undefined ? undefined : rxView(module)?.toModule(range);
    if (module !== undefined) {
      if (declared) out.push({ path: module, line: declared.line, column: declared.column });
      continue;
    }
    if (vfs.files.has(file)) out.push({ path: file, ...at });
    else if (file.startsWith("node_modules/")) out.push({ path: "/" + file, ...at, readOnly: true });
  }
  return out;
}

/** The text of a read-only declaration file a definition pointed into (see `definition`), or null. */
export function readTypes(path: string): Promise<string | null> {
  const id = ++nextId;
  return new Promise((resolve) => {
    waiting.set(id, (r) => resolve(r.text ?? null));
    lsWorker().postMessage({ id, kind: "read", path } satisfies LsRead);
  });
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
      autoImport: !!i.data?.autoImport,
      ref: i,
    };
  });
  return { items, incomplete: r.completion.isIncomplete };
}

/** The declaration and documentation of `item` (from `complete` for `path`) and the import it adds, or null. */
export async function resolveCompletion(vfs: VFS, path: string, text: string, item: EditorCompletion): Promise<EditorCompletionDetails | null> {
  const r = await request(vfs, path, text, { kind: "resolve", item: item.ref as LspCompletionItem });
  if (r.error) console.warn(`tsrs: ${r.error}`);
  const doc = r.item?.documentation;
  const docs = (typeof doc === "string" ? doc : doc?.value ?? "").trim();
  // A path's detail is its name again.
  const code = r.item?.detail === item.label ? "" : (r.item?.detail ?? "");
  const edits = r.item?.additionalTextEdits?.map(({ range: { start, end }, newText }) => ({
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
    text: newText,
  }));
  return code || docs || edits?.length ? { code, docs, edits } : null;
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
