// `mkdir`: bun/src/runtime/shell/builtin/mkdir.rs
import type { Command, ShellFs } from "../interp";
import { errnoOf, failParse, missingErrno, nameTooLong, parseFlags, sysErrorText } from "./errno";
import { err, out } from "./util";

const USAGE = "usage: mkdir [-pv] [-m mode] directory_name ...\n";

export const mkdir: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  let parents = false;
  let verbose = false;
  const start = parseFlags(args, {
    long(flag) {
      if (flag === "--mode") return { unsupported: "--mode" };
      if (flag === "--parents") return (parents = true), "continue";
      // Bun spells it `--vebose`; `--verbose` falls through to the short flags and is an illegal option.
      if (flag === "--vebose") return (verbose = true), "continue";
    },
    short(ch, rest, i) {
      if (ch === "m") return { unsupported: "-m " };
      if (ch === "p") parents = true;
      else if (ch === "v") verbose = true;
      else return { illegal: rest.slice(i + 1) };
    },
  });
  if (start === null) return failParse(ctx, "mkdir", USAGE, "usage");
  if (typeof start !== "number") return failParse(ctx, "mkdir", USAGE, start);

  let failed = false;
  for (const operand of args.slice(start)) {
    // Bun reports (and with -v prints) the path it operated on: a relative operand joined onto the cwd, an absolute
    // one as written.
    const shown = operand.startsWith("/") ? operand : ctx.path(operand);
    const r = parents ? mkdirParents(ctx.fs, shown, ctx.path(operand)) : mkdirOne(ctx.fs, shown, ctx.path(operand));
    if (typeof r === "string") {
      failed = true;
      await err(ctx, sysErrorText("mkdir", r, shown));
    } else if (verbose && r.length) await out(ctx, r.map((d) => d + "\n").join(""));
  }
  return failed ? 1 : 0;
};

/** The folders made, or the errno name. */
function mkdirOne(fs: ShellFs, shown: string, abs: string): string[] | string {
  if (nameTooLong(shown)) return "ENAMETOOLONG";
  if (fs.stat(abs)) return "EEXIST";
  const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
  if (!fs.stat(parent)?.dir) return missingErrno(fs, abs);
  try {
    fs.mkdir(abs);
  } catch (e) {
    return errnoOf(e);
  }
  return [shown];
}

/** NodeFS mkdir_recursive_impl: each missing folder from the top down; an existing folder is fine, a file isn't. */
function mkdirParents(fs: ShellFs, shown: string, abs: string): string[] | string {
  if (nameTooLong(shown)) return "ENAMETOOLONG";
  const parts = abs.split("/").filter(Boolean);
  const made: string[] = [];
  let at = "";
  for (const [i, part] of parts.entries()) {
    at += "/" + part;
    const st = fs.stat(at);
    if (st?.dir) continue;
    if (st) return i === parts.length - 1 ? "EEXIST" : "ENOTDIR";
    made.push(i === parts.length - 1 ? shown : at);
  }
  if (!made.length) return made;
  try {
    fs.mkdir(abs);
  } catch (e) {
    return errnoOf(e);
  }
  return made;
}
