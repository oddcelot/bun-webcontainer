import type { EditorDiagnostic } from "../editors/types";
import { dirname, type FileData, type VFS } from "../vfs";
import type { LspHover } from "./tsrsLs";
import type { LsReply, LsRequest } from "./worker";

// Type errors and hovers from tsrs's language service (see ./worker.ts). The project's files go to it as absolute
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

type Op = { kind: "diagnostics" } | { kind: "hover"; line: number; character: number };

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
function request(vfs: VFS, path: string, text: string, op: Op): Promise<LsReply> {
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

/** Type information at `line`/`column` (1-based, UTF-16) of `path`: LSP hover markdown, or null. */
export async function hover(vfs: VFS, path: string, text: string, line: number, column: number): Promise<LspHover | null> {
  const r = await request(vfs, path, text, { kind: "hover", line: line - 1, character: column - 1 });
  if (r.error) console.warn(`tsrs: ${r.error}`);
  return r.hover ?? null;
}
