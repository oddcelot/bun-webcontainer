// tsrs (TypeScript 7's compiler ported to Rust, as wasm32) runs here and not on the page: the checker recurses
// deeply, and a run blocks until it is done once the module is instantiated.
import { loadModule, tsc, type Diagnostic } from "@tsrs/wasm";
import wasmUrl from "@tsrs/wasm/tsrs.wasm?url";

export type CheckRequest = { id: number; args: string[]; files: Record<string, string | Uint8Array> };
export type CheckReply = { id: number; diagnostics: Diagnostic[]; exitCode: number; stderr: string; ms: number };

const PACKAGE = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

/** Bundled packages (./bunTypes.ts) the project doesn't have in its own node_modules. */
async function withBunTypes(files: CheckRequest["files"]): Promise<CheckRequest["files"]> {
  const { bunTypes } = await import("./bunTypes");
  const own = new Set<string>();
  for (const p of Object.keys(files)) {
    const m = PACKAGE.exec(p);
    if (m) own.add(m[1]);
  }
  const out = { ...files };
  for (const [p, text] of Object.entries(bunTypes)) {
    if (!own.has(PACKAGE.exec(p)![1])) out[p] = text;
  }
  return out;
}

self.onmessage = async (e: MessageEvent<CheckRequest>) => {
  const { id, args } = e.data;
  const start = performance.now();
  try {
    const files = await withBunTypes(e.data.files);
    const r = await tsc(args, { files, diagnostics: "json", module: await loadModule(wasmUrl) });
    const reply: CheckReply = { id, diagnostics: r.diagnostics ?? [], exitCode: r.exitCode, stderr: r.stderr, ms: performance.now() - start };
    postMessage(reply);
  } catch (err) {
    postMessage({ id, diagnostics: [], exitCode: 5, stderr: String(err), ms: performance.now() - start } satisfies CheckReply);
  }
};
