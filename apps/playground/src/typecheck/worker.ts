// tsrs's language service runs here and not on the page: the checker recurses deeply, and a request blocks until it
// is answered. The instance keeps the project's files between requests and is replaced once its memory (which never
// shrinks) passes MEMORY_LIMIT.
import { TsrsLs, type LspCompletionItem, type LspCompletionList, type LspDefinition, type LspDiagnostic, type LspHover, type LspSignatureHelp } from "./tsrsLs";

type Files = Record<string, string | Uint8Array>;
/** Every request carries the files that changed since the last one (the worker keeps the rest). */
type Sync = { id: number; changed: Files; removed: string[]; config: string; path: string };
export type LsOp =
  | { kind: "diagnostics" }
  | { kind: "hover"; line: number; character: number }
  | { kind: "completion"; line: number; character: number; trigger: string }
  | { kind: "resolve"; item: LspCompletionItem }
  | { kind: "definition"; line: number; character: number }
  | { kind: "signature"; line: number; character: number; trigger: string; retrigger: boolean };
export type LsRequest = Sync & LsOp;
export type LsReply = {
  id: number;
  diagnostics?: LspDiagnostic[];
  hover?: LspHover | null;
  completion?: LspCompletionList | null;
  item?: LspCompletionItem | null;
  signature?: LspSignatureHelp | null;
  definition?: LspDefinition;
  error?: string;
};

const MEMORY_LIMIT = 1.5 * 2 ** 30;
const PACKAGE = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

const project = new Map<string, string | Uint8Array>();
let ls: Promise<TsrsLs> | undefined;
/** Bundled type files (./bunTypes.ts) the instance has, for packages the project's node_modules lacks. */
let bunShown = new Set<string>();

async function instance(): Promise<{ ls: TsrsLs; fresh: boolean }> {
  if (ls) return { ls: await ls, fresh: false };
  ls = TsrsLs.create();
  ls.catch(() => (ls = undefined));
  bunShown = new Set();
  return { ls: await ls, fresh: true };
}

async function sync({ changed, removed }: Sync) {
  const { bunTypes } = await import("./bunTypes");
  // Kept as they came: installed files are the page's bytes (shared, no copy), pushed into tsrs as they are.
  for (const [p, data] of Object.entries(changed)) project.set(p, data);
  for (const p of removed) project.delete(p);
  const own = new Set<string>();
  for (const p of project.keys()) {
    const m = PACKAGE.exec(p);
    if (m) own.add(m[1]);
  }
  const bun = new Set(Object.keys(bunTypes).filter((p) => !own.has(PACKAGE.exec(p)![1])));

  const { ls, fresh } = await instance();
  if (fresh) {
    ls.setFiles(project);
  } else {
    // Bundled files the project now has its own copy of go first (same paths), then the project's changes.
    ls.removeFiles([...bunShown].filter((p) => !bun.has(p) && !project.has(p)));
    ls.removeFiles(removed.filter((p) => !bun.has(p)));
    ls.setFiles(Object.keys(changed).map((p) => [p, project.get(p)!]));
  }
  ls.setFiles([...bun].filter((p) => fresh || !bunShown.has(p)).map((p) => [p, bunTypes[p]]));
  bunShown = bun;
  return ls;
}

self.onmessage = async (e: MessageEvent<LsRequest>) => {
  const req = e.data;
  let reply: LsReply;
  try {
    const service = await sync(req);
    reply =
      req.kind === "hover"
        ? { id: req.id, hover: service.hover(req.config, req.path, req.line, req.character) }
        : req.kind === "completion"
          ? { id: req.id, completion: service.completion(req.config, req.path, req.line, req.character, req.trigger) }
          : req.kind === "resolve"
            ? { id: req.id, item: service.resolveCompletion(req.config, req.item) }
            : req.kind === "signature"
              ? { id: req.id, signature: service.signatureHelp(req.config, req.path, req.line, req.character, req.trigger, req.retrigger) }
              : req.kind === "definition"
                ? { id: req.id, definition: service.definition(req.config, req.path, req.line, req.character) }
                : { id: req.id, diagnostics: service.diagnostics(req.config, req.path) };
    if (service.memoryBytes > MEMORY_LIMIT) ls = undefined;
  } catch (err) {
    // A trap (stack overflow, out of memory) leaves the instance unusable: the next request makes a new one.
    ls = undefined;
    reply = { id: req.id, error: String(err) };
  }
  postMessage(reply);
};
