// `dirname`: bun/src/runtime/shell/builtin/dirname.rs
import type { Command } from "../interp";
import { err, out } from "./util";

/** bun_paths::resolve_path::dirname::<Posix>: "" when there is no `/`. */
function posixDirname(p: string): string {
  const sep = p.lastIndexOf("/");
  if (sep < 0) return "";
  if (sep === 0) return "/";
  if (sep === p.length - 1) return posixDirname(p.slice(0, -1));
  return p.slice(0, sep);
}

export const dirname: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  if (!args.length) {
    await err(ctx, "usage: dirname string\n");
    return 1;
  }
  await out(ctx, args.map((a) => (posixDirname(a) || ".") + "\n").join(""));
  return 0;
};
