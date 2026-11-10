// `cd`: bun/src/runtime/shell/builtin/cd.rs
// `cd` alone goes to $HOME, `cd -` to the previous directory.
import type { CommandCtx, Command, ShellEnv } from "../interp";
import { err } from "./util";

/** The directory before the last `cd`, per shell (Bun's `__prev_cwd`); a copied env falls back to its OLDPWD. */
const prevCwd = new WeakMap<ShellEnv, string>();

/** Bun's join buffer in change_cwd_impl: a longer path is ENAMETOOLONG. */
const PATH_MAX = 4096;

/** ShellExecEnv::change_cwd_impl: an absolute path is kept as written, a relative one joined and normalized. */
function changeCwd(ctx: CommandCtx, target: string): "ok" | "ENOENT" | "ENAMETOOLONG" {
  const { shell } = ctx;
  const abs = target.startsWith("/");
  if ((abs ? target.length : shell.cwd.length + 1 + target.length) >= PATH_MAX) return "ENAMETOOLONG";
  const next = abs ? target : ctx.path(target);
  if (!ctx.fs.stat(next)?.dir) return "ENOENT";
  prevCwd.set(shell, shell.cwd);
  shell.exported.set("OLDPWD", shell.cwd);
  shell.cwd = next;
  shell.exported.set("PWD", next);
  return "ok";
}

async function fail(ctx: CommandCtx, msg: string) {
  await err(ctx, `cd: ${msg}\n`);
  return 1;
}

export const cd: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  if (args.length > 1) return fail(ctx, "too many arguments");
  let target: string;
  if (!args.length) {
    target = ctx.shell.get("HOME") ?? "";
    if (!target) return fail(ctx, "HOME not set");
  } else if (args[0] === "-") target = prevCwd.get(ctx.shell) ?? ctx.shell.exported.get("OLDPWD") ?? "";
  else target = args[0]!;
  const r = changeCwd(ctx, target);
  if (r === "ENAMETOOLONG") return fail(ctx, "file name too long");
  if (r === "ENOENT") return fail(ctx, `not a directory: ${target}`);
  return 0;
};
