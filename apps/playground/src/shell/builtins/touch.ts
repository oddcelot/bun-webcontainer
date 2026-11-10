// `touch`: bun/src/runtime/shell/builtin/touch.rs
import type { Command, ShellFs } from "../interp";
import { errnoOf, failParse, missingErrno, nameTooLong, parseFlags, sysErrorText } from "./errno";
import { err } from "./util";

const USAGE =
  "usage: touch [-A [-][[hh]mm]SS] [-achm] [-r file] [-t [[CC]YY]MMDDhhmm[.SS]]\n       [-d YYYY-MM-DDThh:mm:SS[.frac][tz]] file ...\n";
const UNSUPPORTED_LONG: Record<string, string> = {
  "--no-create": "--no-create",
  "--date": "--date",
  "--reference": "--reference=FILE",
  "--time": "--reference=FILE",
};
const UNSUPPORTED_SHORT = new Set(["a", "c", "d", "h", "m", "r", "t"]);

export const touch: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  const start = parseFlags(args, {
    long: (flag) => (Object.hasOwn(UNSUPPORTED_LONG, flag) ? { unsupported: UNSUPPORTED_LONG[flag]! } : undefined),
    short: (ch, rest, i) => (UNSUPPORTED_SHORT.has(ch) ? { unsupported: `-${ch}` } : { illegal: rest.slice(i + 1) }),
  });
  if (start === null) return failParse(ctx, "touch", USAGE, "usage");
  if (typeof start !== "number") return failParse(ctx, "touch", USAGE, start);

  let failed = false;
  for (const operand of args.slice(start)) {
    // Bun reports the path it operated on: the operand joined onto the cwd.
    const abs = ctx.path(operand);
    const code = touchOne(ctx.fs, abs);
    if (code) {
      failed = true;
      await err(ctx, sysErrorText("touch", code, abs));
    }
  }
  return failed ? 1 : 0;
};

/** utimes() the path to now, creating an empty file when it isn't there; the errno name on failure. */
function touchOne(fs: ShellFs, abs: string): string | undefined {
  if (nameTooLong(abs)) return "ENAMETOOLONG";
  try {
    if (fs.stat(abs)) {
      fs.touch?.(abs, Date.now());
      return;
    }
    const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
    if (!fs.stat(parent)?.dir) return missingErrno(fs, abs);
    fs.write(abs, new Uint8Array());
  } catch (e) {
    return errnoOf(e);
  }
}
