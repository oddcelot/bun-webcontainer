// System errors as Bun's builtins print them (Builtin.rs task_error_to_string, bun_core/result.rs coreutils_error_map)
// and the builtins' shared flag parser (interpreter.rs parse_flags, Builtin.rs fail_parse).
import type { CommandCtx, ShellFs } from "../interp";
import { err } from "./util";

/** The coreutils (glibc strerror) texts Bun prints, for the errnos the shell's files can produce. */
const MESSAGES: Record<string, string> = {
  EPERM: "Operation not permitted",
  ENOENT: "No such file or directory",
  EIO: "Input/output error",
  EBADF: "Bad file descriptor",
  EACCES: "Permission denied",
  EBUSY: "Device or resource busy",
  EEXIST: "File exists",
  EXDEV: "Invalid cross-device link",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EINVAL: "Invalid argument",
  EMFILE: "Too many open files",
  EFBIG: "File too large",
  ENOSPC: "No space left on device",
  EROFS: "Read-only file system",
  EPIPE: "Broken pipe",
  ENAMETOOLONG: "File name too long",
  ENOTEMPTY: "Directory not empty",
  ELOOP: "Too many levels of symbolic links",
};

/** Linux errno numbers: what `cat` exits with when a read fails. */
export const ERRNO: Record<string, number> = {
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  EBADF: 9,
  EACCES: 13,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  EMFILE: 24,
  EFBIG: 27,
  ENOSPC: 28,
  EROFS: 30,
  EPIPE: 32,
  ENAMETOOLONG: 36,
  ENOTEMPTY: 39,
  ELOOP: 40,
};

/** `{kind}: {path}: {message}\n`, or `{kind}: {message}\n` without a path. */
export function sysErrorText(kind: string, code: string, path?: string): string {
  const message = MESSAGES[code];
  if (!message) return `${kind}: unknown error ${ERRNO[code] ?? code}\n`;
  return path ? `${kind}: ${path}: ${message}\n` : `${kind}: ${message}\n`;
}

/** The errno name a thrown error carries (node's fs sets `code`), EIO when it has none. */
export function errnoOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : "EIO";
}

const PATH_MAX = 4096;
const NAME_MAX = 255;
const enc = new TextEncoder();

/** ENAMETOOLONG as the kernel decides it: the whole path, or one of its names, too long. */
export function nameTooLong(path: string): boolean {
  if (enc.encode(path).length >= PATH_MAX) return true;
  return path.split("/").some((name) => enc.encode(name).length > NAME_MAX);
}

/**
 * Why the kernel would fail to reach `abs` (absolute, normalized) when it isn't there: ENOTDIR if a file stands where a
 * folder should be on the way, ENOENT otherwise. The shell's files have no symlinks or permissions, so these two (and
 * ENAMETOOLONG) are what's left.
 */
export function missingErrno(fs: ShellFs, abs: string): string {
  if (nameTooLong(abs)) return "ENAMETOOLONG";
  const parts = abs.split("/").filter(Boolean);
  let at = "";
  for (let i = 0; i < parts.length - 1; i++) {
    at += "/" + parts[i];
    const st = fs.stat(at);
    if (!st) return "ENOENT";
    if (!st.dir) return "ENOTDIR";
  }
  return "ENOENT";
}

export type FlagResult = "continue" | "done" | { illegal: string } | { unsupported: string } | undefined;

export interface FlagParser {
  /** A `--long` flag; undefined to fall through to short parsing (of `-` and the rest). */
  long(flag: string): FlagResult;
  /** One character of a `-abc` cluster; `rest` is the cluster without its `-`. Undefined to keep going. */
  short(ch: string, rest: string, i: number): FlagResult;
}

/**
 * Bun's parse_flags over the arguments after the name: the index of the first operand, null with no arguments at
 * all, or what went wrong (`usage` when every argument was a flag).
 */
export function parseFlags(args: string[], p: FlagParser): number | null | { illegal: string } | { unsupported: string } | "usage" {
  if (!args.length) return null;
  for (let idx = 0; idx < args.length; idx++) {
    const r = parseOne(args[idx]!, p);
    if (r === "done") return idx;
    if (r === "continue" || r === undefined) continue;
    return r;
  }
  return "usage";
}

function parseOne(flag: string, p: FlagParser): FlagResult {
  if (!flag.length || flag[0] !== "-") return "done";
  if (flag.length === 1) return { illegal: "-" };
  if (flag.length > 2 && flag[1] === "-") {
    const r = p.long(flag);
    if (r) return r;
  }
  const small = flag.slice(1);
  for (let i = 0; i < small.length; i++) {
    const r = p.short(small[i]!, small, i);
    if (r) return r;
  }
  return "continue";
}

/** Builtin.rs fail_parse: the message for a parse failure, written to stderr; exit 1. */
export async function failParse(ctx: CommandCtx, kind: string, usage: string, e: { illegal: string } | { unsupported: string } | "usage"): Promise<number> {
  if (e === "usage") await err(ctx, usage);
  else if ("illegal" in e) await err(ctx, `${kind}: illegal option -- ${e.illegal}\n`);
  else await err(ctx, `${kind}: unsupported option, please open a GitHub issue -- ${e.unsupported}\n`);
  return 1;
}
