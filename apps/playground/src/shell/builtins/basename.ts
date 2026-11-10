// `basename`: bun/src/runtime/shell/builtin/basename.rs
import type { Command } from "../interp";
import { err, out } from "./util";

const isSep = (c: string) => c === "/" || c === "\\";

/** bun_paths::resolve_path::basename: either slash separates, trailing ones are dropped, all slashes is `/`. */
function basenameOf(path: string): string {
  if (!path) return "";
  let end = path.length - 1;
  while (isSep(path[end]!)) {
    if (end === 0) return "/";
    end--;
  }
  let start = end;
  end++;
  while (!isSep(path[start]!)) {
    if (start === 0) return path.slice(0, end);
    start--;
  }
  return path.slice(start + 1, end);
}

export const basename: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  if (!args.length) {
    await err(ctx, "usage: basename string\n");
    return 1;
  }
  await out(ctx, args.map((a) => basenameOf(a) + "\n").join(""));
  return 0;
};
