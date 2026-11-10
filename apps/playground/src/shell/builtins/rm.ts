// `rm`: bun/src/runtime/shell/builtin/rm.rs
import type { Command, CommandCtx } from "../interp";
import { basename, missing, normalizeKeepSlash, SysError, toSysError } from "./syserr";
import { err, out } from "./util";

const USAGE = "usage: rm [-f | -i] [-dIPRrvWx] file ...\n       unlink [--] file\n";

type Opts = {
  force: boolean;
  prompt: "never" | "once" | "always";
  recursive: boolean;
  verbose: boolean;
  /** `-d`: empty directories without `-r`. */
  dirs: boolean;
};

type Parsed = "continue" | "done" | "illegal" | "illegal-flag";

function parseFlag(opts: Opts, flag: string): Parsed {
  if (!flag.startsWith("-")) return "done";
  if (flag.length > 2 && flag[1] === "-") {
    switch (flag) {
      case "--preserve-root":
      case "--no-preserve-root":
        return "continue";
      case "--recursive":
        opts.recursive = true;
        return "continue";
      case "--verbose":
        opts.verbose = true;
        return "continue";
      case "--dir":
        opts.dirs = true;
        return "continue";
      case "--interactive=never":
        opts.prompt = "never";
        return "continue";
      case "--interactive=once":
        opts.prompt = "once";
        return "continue";
      case "--interactive=always":
        opts.prompt = "always";
        return "continue";
      default:
        return "illegal";
    }
  }
  for (const ch of flag.slice(1)) {
    if (ch === "f") {
      opts.force = true;
      opts.prompt = "never";
    } else if (ch === "r" || ch === "R") opts.recursive = true;
    else if (ch === "v") opts.verbose = true;
    else if (ch === "d") opts.dirs = true;
    else if (ch === "i") opts.prompt = "once";
    else if (ch === "I") opts.prompt = "always";
    else return "illegal-flag";
  }
  return "continue";
}

/** bun_paths' normalizing join for an entry in a directory: `./a/` + `b` is `a/b`, as node's path.join gives. */
function joinNormalized(dir: string, name: string): string {
  const joined = `${dir}/${name}`;
  if (joined.startsWith("/")) return normalizeKeepSlash(joined);
  const parts: string[] = [];
  for (const p of joined.split("/")) {
    if (!p || p === ".") continue;
    if (p === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/") || ".";
}

/** The plain join rm.rs uses for subdirectories of a relative operand: only the separator between them collapses. */
function joinPlain(dir: string, name: string): string {
  if (dir.startsWith("/")) return normalizeKeepSlash(`${dir}/${name}`);
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

/**
 * One operand (ShellRmTask). Bun walks a tree on its thread pool, each directory a DirTask that buffers the paths it
 * deleted and writes them once it and its subdirectories are gone; this walks depth first with the same buffers, so
 * the output comes in one of the orders Bun's can.
 */
class RmTask {
  error: SysError | undefined;
  private ctx: CommandCtx;
  private opts: Opts;
  constructor(ctx: CommandCtx, opts: Opts) {
    this.ctx = ctx;
    this.opts = opts;
  }

  private deleted(buf: string[], path: string) {
    if (this.opts.verbose) buf.push(path + "\n");
  }

  private async flush(buf: string[]) {
    if (buf.length) await out(this.ctx, buf.join(""));
  }

  private fail(e: unknown, path: string) {
    this.error ??= toSysError(e, path);
  }

  async run(root: string): Promise<SysError | undefined> {
    const buf: string[] = [];
    try {
      await this.removeRoot(root, buf);
    } catch (e) {
      this.fail(e, root);
    }
    await this.flush(buf);
    return this.error;
  }

  private async removeRoot(path: string, buf: string[]) {
    const { fs } = this.ctx;
    const abs = this.ctx.path(path);
    const st = fs.stat(abs);
    if (!st) {
      const code = missing(this.ctx, abs) ?? "ENOENT";
      if (code === "ENOENT" && this.opts.force) return this.deleted(buf, path);
      throw new SysError(code, path);
    }
    if (!st.dir) {
      if (path.endsWith("/")) throw new SysError("ENOTDIR", path);
      fs.remove(abs);
      return this.deleted(buf, path);
    }
    if (!this.opts.recursive && !this.opts.dirs) throw new SysError("EISDIR", path);
    // rmdir(2) refuses `.` and `..`; Linux empties `.` first, macOS (and this) leaves it alone.
    const base = basename(path);
    if (base === "." || base === "..") throw new SysError("EINVAL", path);
    if (!this.opts.recursive) {
      if (fs.readdir(abs).length) throw new SysError("ENOTEMPTY", path);
      fs.remove(abs);
      return this.deleted(buf, path);
    }
    await this.removeDir(path, buf);
  }

  /** A directory and everything in it; `buf` is its own list of deleted paths. */
  private async removeDir(path: string, buf: string[]) {
    const { fs } = this.ctx;
    const abs = this.ctx.path(path);
    let entries: { name: string; dir: boolean }[];
    try {
      entries = fs.readdir(abs);
    } catch (e) {
      if (!fs.stat(abs) && this.opts.force) return this.deleted(buf, path);
      return this.fail(e, path);
    }
    for (const entry of entries) {
      if (this.error || this.ctx.signal.aborted) return;
      if (entry.dir) {
        const sub: string[] = [];
        await this.removeDir(joinPlain(path, entry.name), sub);
        await this.flush(sub);
        continue;
      }
      const file = joinNormalized(path, entry.name);
      try {
        fs.remove(this.ctx.path(file));
        this.deleted(buf, file);
      } catch (e) {
        if (fs.stat(this.ctx.path(file))) return this.fail(e, file);
        if (this.opts.force) this.deleted(buf, file);
        else return this.fail(new SysError("ENOENT", file), file);
      }
    }
    if (this.error || this.ctx.signal.aborted) return;
    try {
      fs.remove(abs);
      this.deleted(buf, path);
    } catch (e) {
      this.fail(e, path);
    }
  }
}

export const rm: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  const opts: Opts = { force: false, prompt: "never", recursive: false, verbose: false, dirs: false };
  let idx = 0;
  for (; ; idx++) {
    if (idx >= args.length) {
      await err(ctx, USAGE);
      return 1;
    }
    const parsed = parseFlag(opts, args[idx]!);
    if (parsed === "continue") continue;
    if (parsed === "illegal") {
      await err(ctx, "rm: illegal option -- -\n");
      return 1;
    }
    if (parsed === "illegal-flag") {
      await err(ctx, `rm: illegal option -- ${args[idx]!.slice(1)}\n`);
      return 1;
    }
    break;
  }
  if (opts.recursive) opts.dirs = true;
  if (opts.prompt !== "never") {
    await err(ctx, 'rm: "-i" is not supported yet');
    return 1;
  }
  const operands = args.slice(idx);
  for (const path of operands) {
    const resolved = path.startsWith("/") ? path : normalizeKeepSlash(`${ctx.shell.cwd}/${path}`);
    if (normalizeKeepSlash(resolved) === "/") {
      await err(ctx, `rm: "${resolved}" may not be removed\n`);
      return 1;
    }
  }
  let failed = false;
  for (const path of operands) {
    if (ctx.signal.aborted) break;
    const error = await new RmTask(ctx, opts).run(path);
    if (error) {
      failed = true;
      await err(ctx, `rm: ${error.path}: ${error.message}\n`);
    }
  }
  return failed ? 1 : 0;
};
