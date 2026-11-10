// `mv`: bun/src/runtime/shell/builtin/mv.rs
import type { Command, CommandCtx } from "../interp";
import { basename, missing, normalizeKeepSlash, SysError, toSysError } from "./syserr";
import { err } from "./util";

const USAGE = "usage: mv [-f | -i | -n] [-hv] source target\n       mv [-f | -i | -n] [-v] source ... directory\n";
/** Bun moves the sources in batches of this many, one task each, side by side. */
const BATCH_SIZE = 5;

/** `a/b/` is `a/b`, made absolute against the cwd. */
const abs = (ctx: CommandCtx, p: string) => ctx.path(p);

/**
 * rename(2) over the shell's files, failing as the syscall does. The error carries `src`, as bun_sys's renameat
 * reports it.
 */
function rename(ctx: CommandCtx, src: string, dst: string) {
  const { fs } = ctx;
  const from = abs(ctx, src);
  const to = abs(ctx, dst);
  const st = fs.stat(from);
  if (!st) throw new SysError(missing(ctx, from) ?? "ENOENT", src);
  if (!st.dir && src.endsWith("/")) throw new SysError("ENOTDIR", src);
  const parent = to.slice(0, to.lastIndexOf("/")) || "/";
  const parentWhy = missing(ctx, parent);
  if (parentWhy) throw new SysError(parentWhy, src);
  if (!fs.stat(parent)!.dir) throw new SysError("ENOTDIR", src);
  if (from === to) return;
  const target = fs.stat(to);
  if (st.dir) {
    if (to.startsWith(from + "/") || from === "/") throw new SysError("EINVAL", src);
    if (target && !target.dir) throw new SysError("ENOTDIR", src);
    if (target && fs.readdir(to).length) throw new SysError("ENOTEMPTY", src);
  } else {
    if (target?.dir) throw new SysError("EISDIR", src);
    if (!target && dst.endsWith("/")) throw new SysError("ENOTDIR", src);
  }
  try {
    if (target) fs.remove(to);
    fs.rename(from, to);
  } catch (e) {
    throw toSysError(e, src);
  }
}

/** ShellMvBatchedTask::do_rename: `-n` leaves an existing destination alone (once the source is known to exist). */
function doRename(ctx: CommandCtx, src: string, dst: string, noClobber: boolean) {
  if (noClobber && ctx.fs.stat(abs(ctx, dst))) {
    const from = abs(ctx, src);
    if (!ctx.fs.stat(from)) throw new SysError(missing(ctx, from) ?? "ENOENT", src);
    return;
  }
  rename(ctx, src, dst);
}

/** bun_paths' join of the target and a source's basename, the path errors moving into a directory name. */
function joinShown(target: string, base: string): string {
  const joined = `${target}/${base}`;
  if (joined.startsWith("/")) return normalizeKeepSlash(joined);
  const parts: string[] = [];
  for (const p of joined.split("/")) {
    if (!p || p === ".") continue;
    if (p === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(p);
  }
  return (parts.join("/") || ".") + (joined.endsWith("/") ? "/" : "");
}

function moveInDir(ctx: CommandCtx, target: string, src: string, noClobber: boolean) {
  const base = basename(src);
  const shown = joinShown(target, base);
  try {
    doRename(ctx, src, `${abs(ctx, target)}/${base}`, noClobber);
  } catch (e) {
    const error = toSysError(e, shown);
    error.path = shown;
    throw error;
  }
}

export const mv: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  const fail = async (text: string, code: number) => {
    await err(ctx, text);
    return code;
  };
  if (!args.length) return fail(USAGE, 1);
  let noClobber = false;
  let start = -1;
  parse: for (let idx = 0; idx < args.length; idx++) {
    const flag = args[idx]!;
    if (!flag.startsWith("-")) {
      start = idx;
      break;
    }
    for (const ch of flag.slice(1)) {
      if (ch === "n") noClobber = true;
      else if (ch === "f") noClobber = false;
      else if (ch !== "h" && ch !== "i" && ch !== "v") {
        start = -2;
        break parse;
      }
    }
  }
  if (start === -2) return fail("mv: illegal option -- -\n", 1);
  if (start < 0 || args.length - start < 2) return fail(USAGE, 1);

  const sources = args.slice(start, -1);
  const target = args.at(-1)!;
  // ShellMvCheckTargetTask: open the target as a directory.
  const targetAbs = abs(ctx, target);
  const st = ctx.fs.stat(targetAbs);
  let targetIsDir = false;
  if (st) targetIsDir = st.dir;
  else {
    const why = missing(ctx, targetAbs) ?? "ENOENT";
    if (why === "ENOENT" && sources.length > 1) return fail(`mv: ${target}: No such file or directory\n`, 1);
  }
  if (!targetIsDir && sources.length > 1) return fail(`mv: ${target} is not a directory\n`, 1);

  let error: SysError | undefined;
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE);
    try {
      if (batch.length > 1) {
        for (const src of batch) {
          if (error) break;
          moveInDir(ctx, target, src, noClobber);
        }
      } else if (targetIsDir) moveInDir(ctx, target, batch[0]!, noClobber);
      else {
        try {
          doRename(ctx, batch[0]!, target, noClobber);
        } catch (e) {
          const sys = toSysError(e, batch[0]!);
          if (sys.code === "ENOTDIR") sys.path = target;
          throw sys;
        }
      }
    } catch (e) {
      error ??= toSysError(e, target);
    }
  }
  if (error) return fail(`mv: ${error.path}: ${error.message}\n`, error.errno);
  return 0;
};
