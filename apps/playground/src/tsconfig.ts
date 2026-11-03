// The tsconfig.json lookup the transpiler's options come from: the module server's, the type checker's and the
// worker's (CommonJS it loads at run time). Plain VFS reads, so the worker can import it.
import { dirname, norm, type VFS } from "@runbun/vfs";
import type { TsconfigFlags } from "./transpiler";

/** The nearest tsconfig.json (or, in the same folder, jsconfig.json) above `path`, as Bun and TypeScript look for it. */
export function nearestTsconfig(vfs: VFS, path: string): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const file = dir ? `${dir}/${name}` : name;
      if (vfs.readText(file) !== undefined) return file;
    }
    if (!dir) return undefined;
  }
}

/** `compilerOptions` of the nearest tsconfig.json (or jsconfig.json) above `path` (comments and trailing commas allowed), with `extends`. */
export function tsconfigFor(vfs: VFS, path: string): TsconfigFlags {
  const file = nearestTsconfig(vfs, path);
  return file ? compilerOptions(vfs, file, new Set()) : {};
}

/**
 * `file`'s `compilerOptions` over those of the config it `extends`. As Bun's resolver: `extends` is a path relative to
 * the file, taken as written (no `.json` added, no packages); a config that is missing or not JSON ends the chain.
 */
function compilerOptions(vfs: VFS, file: string, seen: Set<string>): TsconfigFlags {
  const text = vfs.readText(file);
  if (text === undefined || seen.has(file)) return {};
  seen.add(file);
  let config: { extends?: unknown; compilerOptions?: TsconfigFlags };
  try {
    config = JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "$1").replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return {};
  }
  if (typeof config !== "object" || config === null) return {};
  const base = typeof config.extends === "string" && !config.extends.startsWith("/") ? compilerOptions(vfs, norm(`${dirname(file)}/${config.extends}`), seen) : {};
  return { ...base, ...config.compilerOptions };
}
