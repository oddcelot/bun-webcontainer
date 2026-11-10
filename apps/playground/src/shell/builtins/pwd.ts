// `pwd`: bun/src/runtime/shell/builtin/pwd.rs
import type { Command } from "../interp";
import { err, out } from "./util";

export const pwd: Command = async (ctx) => {
  if (ctx.argv.length > 1) {
    await err(ctx, "pwd: too many arguments\n");
    return 1;
  }
  await out(ctx, ctx.shell.cwd + "\n");
  return 0;
};
