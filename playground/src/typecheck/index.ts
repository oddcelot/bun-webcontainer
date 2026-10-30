import type { Diagnostic } from "@tsrs/wasm";
import type { EditorDiagnostic } from "../editors/types";
import { dirname, type VFS } from "../vfs";
import type { CheckReply, CheckRequest } from "./worker";

// Type errors from tsrs (see ./worker.ts). The project's files go to the checker as absolute paths ("/" + VFS path);
// from node_modules only declarations, package.json and tsconfig files (for `extends`), which is what type
// resolution reads. The worker adds Bun's own types where node_modules lacks them.

/** Files the type checker looks at. */
export const TYPED = /\.(?:[cm]?ts|tsx)$/;
const PROJECT = /\.(?:[cm]?[jt]sx?|json)$/;
const DECLARATIONS = /(?:\.d\.[cm]?ts|\.d\.[^/.]+\.ts|\/package\.json|\/tsconfig[^/]*\.json|\/tsconfigs\/[^/]+\.json)$/;

/** Without tsconfig.json: what `bun init` writes plus Bun's types, with the DOM libs for code that runs in the preview. */
const DEFAULTS = [
  "--strict",
  "--target", "esnext",
  "--module", "preserve",
  "--moduleResolution", "bundler",
  "--moduleDetection", "force",
  "--allowImportingTsExtensions",
  "--allowJs",
  "--jsx", "react-jsx",
  "--lib", "esnext,dom,dom.iterable",
  "--skipLibCheck",
  "--types", "bun",
];

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, (r: CheckReply) => void>();

function run(args: string[], files: CheckRequest["files"]): Promise<CheckReply> {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<CheckReply>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
  }
  const id = ++nextId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker!.postMessage({ id, args, files } satisfies CheckRequest);
  });
}

function nearestTsconfig(vfs: VFS, path: string): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const p = dir ? `${dir}/tsconfig.json` : "tsconfig.json";
    if (vfs.files.has(p)) return p;
    if (!dir) return undefined;
  }
}

function message(d: Diagnostic, depth = 0): string {
  return ["  ".repeat(depth) + d.text, ...(d.messageChain ?? []).map((c) => message(c, depth + 1))].join("\n");
}

/** Type errors in `path`, with `text` as its contents (unsaved edits included). */
export async function typecheck(vfs: VFS, path: string, text: string): Promise<EditorDiagnostic[]> {
  const files: CheckRequest["files"] = {};
  for (const [p, data] of vfs.files) {
    if (p.startsWith("node_modules/") || p.includes("/node_modules/") ? DECLARATIONS.test(p) : PROJECT.test(p)) files["/" + p] = data;
  }
  files["/" + path] = text;
  const tsconfig = nearestTsconfig(vfs, path);
  const args = tsconfig ? ["-p", "/" + tsconfig, "--noEmit"] : ["/" + path, "--noEmit", ...DEFAULTS];
  const r = await run(args, files);
  if (r.exitCode === 5) console.warn(`tsrs: ${r.stderr}`);
  const out: EditorDiagnostic[] = [];
  for (const d of r.diagnostics) {
    if (d.fileName !== "/" + path || !d.startPosition || (d.category !== 0 && d.category !== 1)) continue;
    const { line, character } = d.startPosition;
    const sameLine = d.endPosition?.line === line;
    out.push({
      severity: d.category === 1 ? "error" : "warning",
      message: `${message(d)} (TS${d.code})`,
      line: line + 1,
      column: character + 1,
      length: sameLine ? d.endPosition!.character - character : 0,
    });
  }
  return out;
}
