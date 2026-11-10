// Small helpers the builtins share.
import type { CommandCtx, Command } from "../interp";

/** Writes text to stdout; false once the reader is gone. */
export const out = (ctx: CommandCtx, text: string | Uint8Array) => ctx.stdout.write(text);
/** Writes text to stderr. */
export const err = (ctx: CommandCtx, text: string | Uint8Array) => ctx.stderr.write(text);

/** A builtin not ported yet. */
export const notYet =
  (name: string): Command =>
  async (ctx) => {
    await err(ctx, `${name}: not available in the playground yet\n`);
    return 1;
  };
