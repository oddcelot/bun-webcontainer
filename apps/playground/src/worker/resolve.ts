// `Bun.resolveSync`, `Bun.resolve` and `import.meta.resolve` over the VFS, with Bun's resolver (resolve-wasm, loaded by
// runtime.ts). Paths are VFS paths with a leading `/`, as `import.meta.path` has them.
import { resolve } from "../resolver";
import { builtins } from "./node";
import nodePath from "./node/path";
import process from "./node/process";
import { fileURLToPath, pathToFileURL } from "./node/url";

/** Bun's `ResolveMessage` (an Error): what the resolver throws when nothing matches. */
export class ResolveMessage extends Error {
  readonly code = "ERR_MODULE_NOT_FOUND";
  readonly level = "error";
  readonly position = null;
  readonly importKind = "import-statement";
  constructor(
    readonly specifier: string,
    readonly referrer: string,
  ) {
    // Bun says "package" for a bare specifier, "module" for a path.
    super(`Cannot find ${isPath(specifier) ? "module" : "package"} '${specifier}' imported from ${referrer}`);
    this.name = "ResolveMessage";
  }
}

const isPath = (spec: string) => /^(\.\.?(\/|$)|\/|file:)/.test(spec);

/** `fs` -> `node:fs`, `bun:sqlite`, `bun`: what Bun resolves a built-in to, or undefined. */
function builtin(spec: string): string | undefined {
  const name = spec.replace(/^node:/, "");
  if (!(name in builtins)) return undefined;
  return name === "bun" || name.startsWith("bun:") ? name : `node:${name}`;
}

/** The VFS path (leading `/`) `spec` resolves to from directory `dir` (absolute), or null. */
function resolvePath(spec: string, dir: string): string | null {
  if (spec.startsWith("file:")) spec = fileURLToPath(spec);
  const r = resolve(spec, nodePath.resolve(dir).slice(1), "import", "bun");
  return r === null ? null : `/${r}`;
}

/**
 * `Bun.resolveSync(specifier, from)`: `from` is the directory to resolve from (a file path is taken as a directory
 * too, as in Bun), relative to the cwd if not absolute, or a `file:` URL.
 */
export function resolveSync(specifier: string, from: string | URL): string {
  const spec = String(specifier);
  const b = builtin(spec);
  if (b) return b;
  const referrer = from instanceof URL || String(from).startsWith("file:") ? fileURLToPath(from) : String(from);
  const r = resolvePath(spec, nodePath.resolve(process.cwd(), referrer));
  if (r === null) throw new ResolveMessage(spec, referrer);
  return r;
}

/**
 * `import.meta.resolve(specifier)` in the module at `file` (moduleServer.ts's rewriteMeta binds `file`), as Bun answers:
 * a path or `file:` URL is joined to the module's URL as written (no extension or index lookup, existing or not),
 * a package resolves to its file's `file:` URL (or throws), a built-in to its `node:` specifier.
 */
export function importMetaResolve(file: string, specifier: string): string {
  const spec = String(specifier);
  const b = builtin(spec);
  if (b) return b;
  if (isPath(spec)) return new URL(spec, pathToFileURL(file)).href;
  if (/^[a-z][a-z\d+.-]*:/i.test(spec)) return spec;
  const r = resolvePath(spec, nodePath.dirname(file));
  if (r === null) throw new ResolveMessage(spec, file);
  return pathToFileURL(r).href;
}
