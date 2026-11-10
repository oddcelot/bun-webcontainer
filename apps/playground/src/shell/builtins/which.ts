// `which`: bun/src/runtime/shell/builtin/which.rs
// One path per argument; any not found makes the exit code 1, after all of them are looked up.
import type { Command, CommandCtx } from "../interp";
import { out } from "./util";

/** bun_which's MAX_PATH_BYTES (macOS's; Linux allows 4096). */
const MAX_PATH_BYTES = 1024;

/** The VFS has no permission bits: any file counts as executable. */
const isFile = (ctx: CommandCtx, p: string) => p.length + 1 <= MAX_PATH_BYTES && ctx.fs.stat(p)?.dir === false;

/** bun_which::which over the shell's files: absolute as is, a name with `/` from the cwd, a bare name in $PATH. */
function search(ctx: CommandCtx, bin: string): string | undefined {
  if (!bin || bin.length >= MAX_PATH_BYTES) return undefined;
  if (bin.startsWith("/")) return isFile(ctx, bin) ? bin : undefined;
  const cwd = ctx.shell.cwd.length > 1 ? ctx.shell.cwd.replace(/\/+$/, "") || "/" : ctx.shell.cwd;
  const join = (...parts: string[]) => parts.filter(Boolean).map((p, i, all) => (i < all.length - 1 && !p.endsWith("/") ? p + "/" : p)).join("");
  if (bin.includes("/")) {
    const p = join(cwd, bin.startsWith("./") ? bin.slice(2) : bin);
    return isFile(ctx, p) ? p : undefined;
  }
  for (const segment of (ctx.shell.exported.get("PATH") ?? "").split(":")) {
    if (!segment) continue;
    const p = join(segment.startsWith("/") ? "" : cwd, segment, bin);
    if (isFile(ctx, p)) return p;
  }
  // No binaries in the browser: a builtin or one of the host's commands is found by its name.
  return ctx.known(bin) ? bin : undefined;
}

export const which: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  if (!args.length) {
    await out(ctx, "\n");
    return 1;
  }
  let notFound = false;
  for (const arg of args) {
    const found = search(ctx, arg);
    if (found === undefined) notFound = true;
    // Bun's form for stdout on a terminal or a plain `$`; with `.quiet()` or in `$(…)` it says `which: NAME not found`.
    if (!(await out(ctx, found !== undefined ? `${found}\n` : `${arg} not found\n`))) return 1;
  }
  return notFound ? 1 : 0;
};
