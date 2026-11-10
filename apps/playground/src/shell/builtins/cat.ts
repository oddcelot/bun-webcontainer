// `cat`: bun/src/runtime/shell/builtin/cat.rs
import type { Command } from "../interp";
import { ERRNO, errnoOf, failParse, missingErrno, nameTooLong, parseFlags, sysErrorText } from "./errno";
import { err, out } from "./util";

const USAGE = "usage: cat [-belnstuv] [file ...]\n";
const UNSUPPORTED = new Set(["b", "e", "n", "s", "t", "u", "v"]);

export const cat: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  // `cat -` is an illegal option in Bun's parser, like any lone `-` before the first operand.
  const start = parseFlags(args, {
    long: () => undefined,
    short: (ch, rest, i) => (UNSUPPORTED.has(ch) ? { unsupported: `-${ch}` } : { illegal: rest.slice(i + 1) }),
  });
  if (start !== null && typeof start !== "number") return failParse(ctx, "cat", USAGE, start);

  // Exits with the errno of a failed write (EPIPE once nobody reads) or read, like Bun.
  if (start === null || start === args.length) {
    for (let chunk = await ctx.stdin.read(); chunk; chunk = await ctx.stdin.read()) {
      if (!(await out(ctx, chunk))) {
        ctx.stdin.close();
        return ERRNO.EPIPE!;
      }
      if (ctx.signal.aborted) return 130;
    }
    return 0;
  }

  for (const operand of args.slice(start)) {
    const abs = ctx.path(operand);
    const st = nameTooLong(abs) ? undefined : ctx.fs.stat(abs);
    if (!st) {
      await err(ctx, sysErrorText("cat", missingErrno(ctx.fs, abs), operand));
      return 1;
    }
    // A folder opens but can't be read: Bun ends with EISDIR as the exit code and prints nothing.
    if (st.dir) return ERRNO.EISDIR!;
    let bytes: Uint8Array;
    try {
      bytes = await ctx.fs.read(abs);
    } catch (e) {
      return ERRNO[errnoOf(e)] ?? 1;
    }
    if (bytes.length && !(await out(ctx, bytes))) return ERRNO.EPIPE!;
  }
  return 0;
};
