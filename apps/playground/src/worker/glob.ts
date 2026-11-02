// `Bun.Glob`: Bun's own matcher and walker (bun_glob, in resolve-wasm) over the worker's VFS.
import { globMatch, globScan, GlobScanError } from "../resolver";
import { codeError, fsError } from "./node/errors";
import nodePath from "./node/path";
import process from "./node/process";

type ScanOptions = { cwd?: string; dot?: boolean; absolute?: boolean; onlyFiles?: boolean; followSymlinks?: boolean; throwErrorOnBrokenSymlink?: boolean };

function scan(pattern: string, arg: string | ScanOptions | undefined): string[] {
  const o: ScanOptions = typeof arg === "string" ? { cwd: arg } : (arg ?? {});
  // As Bun's `ScanOpts::parse_cwd`: "" means not given, a relative cwd is taken from the process's.
  const cwd = nodePath.resolve(process.cwd(), o.cwd || ".");
  try {
    return globScan(pattern, cwd, {
      dot: !!o.dot,
      absolute: !!o.absolute,
      onlyFiles: o.onlyFiles ?? true,
      followSymlinks: !!o.followSymlinks,
      throwErrorOnBrokenSymlink: !!o.throwErrorOnBrokenSymlink,
    });
  } catch (e) {
    if (!(e instanceof GlobScanError)) throw e;
    let err: Error;
    try {
      err = fsError(e.code, e.syscall, e.path);
    } catch {
      // A code node/errors.ts has no text for.
      err = Object.assign(new Error(`${e.code}: ${e.syscall} '${e.path}'`), { code: e.code, syscall: e.syscall, path: e.path });
    }
    throw err;
  }
}

export class Glob {
  readonly #pattern: string;

  constructor(pattern: string) {
    if (typeof pattern !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Glob.constructor: first argument is not a string");
    this.#pattern = pattern;
  }

  /** Whether `path` matches. As in Bun, leading dots aren't special here (`dot` only applies to scans). */
  match(path: string): boolean {
    if (typeof path !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Glob.matchString: first argument is not a string");
    return globMatch(this.#pattern, path);
  }

  /** The matching paths under `cwd` (default: the process's), relative to it unless `absolute`. */
  async *scan(options?: string | ScanOptions): AsyncGenerator<string> {
    yield* scan(this.#pattern, options);
  }

  *scanSync(options?: string | ScanOptions): Generator<string> {
    yield* scan(this.#pattern, options);
  }
}
Object.defineProperty(Glob.prototype, Symbol.toStringTag, { value: "Glob" });
