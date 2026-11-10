// The errors rm, mv and cp report, as bun_sys gives them: Linux errno numbers (wasm uses that table) and the
// coreutils texts (bun/src/bun_core/result.rs, coreutils_error_map).
import type { CommandCtx } from "../interp";

const ERRNOS = {
  EPERM: [1, "Operation not permitted"],
  ENOENT: [2, "No such file or directory"],
  EIO: [5, "Input/output error"],
  EACCES: [13, "Permission denied"],
  EBUSY: [16, "Device or resource busy"],
  EEXIST: [17, "File exists"],
  EXDEV: [18, "Invalid cross-device link"],
  ENOTDIR: [20, "Not a directory"],
  EISDIR: [21, "Is a directory"],
  EINVAL: [22, "Invalid argument"],
  ENOSPC: [28, "No space left on device"],
  EROFS: [30, "Read-only file system"],
  ENAMETOOLONG: [36, "File name too long"],
  ENOTEMPTY: [39, "Directory not empty"],
  ELOOP: [40, "Too many levels of symbolic links"],
} as const;

export type Errno = keyof typeof ERRNOS;

export class SysError extends Error {
  code: Errno;
  path: string;
  constructor(code: Errno, path: string) {
    super(ERRNOS[code][1]);
    this.code = code;
    this.path = path;
  }
  get errno(): number {
    return ERRNOS[this.code][0];
  }
}

/** An error the files threw (node's fs in the conformance run carries `code`), as a SysError on `path`. */
export function toSysError(e: unknown, path: string): SysError {
  if (e instanceof SysError) return e;
  const code = (e as { code?: string } | undefined)?.code;
  return new SysError(code && code in ERRNOS ? (code as Errno) : "EIO", path);
}

/**
 * Why `path` (absolute) doesn't exist: ENOTDIR when one of its parents is a file, else ENOENT. `undefined` if it does
 * exist.
 */
export function missing(ctx: CommandCtx, path: string): Errno | undefined {
  if (ctx.fs.stat(path)) return undefined;
  for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
    const st = ctx.fs.stat(path.slice(0, at));
    if (st) return st.dir ? "ENOENT" : "ENOTDIR";
  }
  return "ENOENT";
}

/** node's path.normalize for absolute paths: `.` and `..` resolved, a trailing `/` kept. */
export function normalizeKeepSlash(path: string): string {
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  const out = "/" + parts.join("/");
  return path.endsWith("/") && parts.length ? out + "/" : out;
}

/** `operand` against the cwd, normalized the way bun_paths' join does (node's path.join). */
export function resolveOperand(cwd: string, operand: string): string {
  return normalizeKeepSlash(operand.startsWith("/") ? operand : `${cwd}/${operand}`);
}

/** The last component, trailing `/`s ignored (bun_paths basename). */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || (path.startsWith("/") ? "/" : "");
}
