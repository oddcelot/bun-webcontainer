// `exit`: bun/src/runtime/shell/builtin/exit.rs
import type { Command } from "../interp";
import { err } from "./util";

/** bun_core::fmt::parse_decimal::<u64>: an optional sign, digits with `_` between them, within u64. */
function parseU64(s: string): bigint | undefined {
  const m = /^([+-]?)([0-9](?:[0-9_]*[0-9])?)$/.exec(s);
  if (!m) return undefined;
  const n = BigInt(m[2]!.replaceAll("_", ""));
  if (m[1] === "-" ? n !== 0n : n > 0xffff_ffff_ffff_ffffn) return undefined;
  return n;
}

// Like Bun's, `exit` ends only its own command (the script goes on, with its code as `$?`): Bun's tests expect
// `(exit; echo reached)` to print `reached`, so this returns rather than throwing ExitSignal.
export const exit: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  if (args.length > 1) {
    await err(ctx, "exit: too many arguments\n");
    return 1;
  }
  if (!args.length) return 0;
  const n = parseU64(args[0]!);
  if (n === undefined) {
    await err(ctx, "exit: numeric argument required\n");
    return 1;
  }
  return Number(n % 256n);
};
