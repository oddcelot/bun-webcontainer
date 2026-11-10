// `cp`: bun/src/runtime/shell/builtin/cp.rs
import type { Command, CommandCtx } from "../interp";
import { missing, SysError, toSysError } from "./errno";
import { basename, resolveOperand } from "./paths";
import { err, out } from "./util";

const USAGE =
  "usage: cp [-R [-H | -L | -P]] [-fi | -n] [-aclpsvXx] source_file target_file\n       cp [-R [-H | -L | -P]] [-fi | -n] [-aclpsvXx] source_file ... target_directory\n";

type Opts = { recursive: boolean; verbose: boolean; noClobber: boolean };

/** What one flag word means (interpreter.rs parse_flags with cp's parse_short). */
function parseFlag(opts: Opts, flag: string): { illegal?: string; unsupported?: string } | "done" | undefined {
  if (!flag.startsWith("-")) return "done";
  if (flag.length === 1) return { illegal: "-" };
  const small = flag.slice(1);
  for (let i = 0; i < small.length; i++) {
    const ch = small[i]!;
    if (ch === "R") opts.recursive = true;
    else if (ch === "v") opts.verbose = true;
    else if (ch === "n") opts.noClobber = true;
    // Only a word's first letter is checked; Bun ignores the letters after it.
    else if (i > 0) continue;
    else if ("fHiLP".includes(ch)) return { unsupported: `-${ch}` };
    else if (ch === "p") return { unsupported: "-P" };
    else return { illegal: small.slice(i) };
  }
  return undefined;
}

type Check = "copy" | "skip" | string;

const hasTrailingSep = (p: string) => p.endsWith("/");
const trimSep = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const dirname = (p: string) => {
  const t = trimSep(p);
  const at = t.lastIndexOf("/");
  return at < 0 ? undefined : at === 0 ? "/" : t.slice(0, at);
};

/** One source (ShellCpTask): its verbose lines and its error. */
class CpTask {
  verbose: string[] = [];
  error: string | undefined;
  private ctx: CommandCtx;
  private opts: Opts;
  private operands: number;
  private srcOperand: string;
  private tgtOperand: string;
  constructor(ctx: CommandCtx, opts: Opts, operands: number, srcOperand: string, tgtOperand: string) {
    this.ctx = ctx;
    this.opts = opts;
    this.operands = operands;
    this.srcOperand = srcOperand;
    this.tgtOperand = tgtOperand;
  }

  private onCopy(src: string, dest: string) {
    if (this.opts.verbose) this.verbose.push(`${src} -> ${dest}\n`);
  }

  private sys(e: unknown, path: string) {
    const error = toSysError(e, path);
    return `${error.message}: ${error.path}`;
  }

  /** ShellCpTask::check_paths: whether to copy `src` (absolute) onto `tgt`, skip it, or why not. */
  private checkPaths(src: string, tgt: string, appended: string | undefined): Check {
    const { fs } = this.ctx;
    const srcShown = this.srcOperand;
    const tgtShown = () => (appended === undefined ? this.tgtOperand : (hasTrailingSep(this.tgtOperand) ? this.tgtOperand : this.tgtOperand + "/") + appended);
    const srcStat = fs.stat(src);
    if (!srcStat) return "copy";
    const tgtStat = fs.stat(tgt);
    if (tgtStat) {
      if (this.opts.noClobber && !srcStat.dir) return "skip";
      if (trimSep(src) === trimSep(tgt)) {
        if (this.opts.noClobber || appended !== undefined || src !== tgt) return "skip";
        return `${srcShown} and ${tgtShown()} are identical (not copied)`;
      }
      if (srcStat.dir && !tgtStat.dir) return `cannot overwrite non-directory ${tgtShown()} with directory ${srcShown}`;
      if (!srcStat.dir && tgtStat.dir) return `cannot overwrite directory ${tgtShown()} with non-directory ${srcShown}`;
    }
    if (!srcStat.dir) return "copy";
    // No symlinks here, so the paths alone say whether the target is inside the source.
    const s = trimSep(src);
    if (tgt.startsWith(s === "/" ? s : s + "/")) return `cannot copy a directory, '${srcShown}', into itself, '${tgtShown()}'`;
    return "copy";
  }

  async run() {
    const { fs } = this.ctx;
    const cwd = this.ctx.shell.cwd;
    const src = resolveOperand(cwd, this.srcOperand);
    let tgt = resolveOperand(cwd, this.tgtOperand);
    const srcStat = fs.stat(src);
    if (!srcStat) return void (this.error = this.sys(new SysError(missing(this.ctx, trimSep(src)) ?? "ENOENT", src), src));
    if (srcStat.dir && !this.opts.recursive) return void (this.error = `${this.srcOperand} is a directory (not copied)`);
    const tgtStat = fs.stat(tgt);
    if (!tgtStat && missing(this.ctx, trimSep(tgt)) !== "ENOENT") return void (this.error = this.sys(new SysError("ENOTDIR", tgt), tgt));
    const tgtExists = !!tgtStat;
    const tgtIsDir = tgtStat ? tgtStat.dir : hasTrailingSep(tgt);

    let appended: string | undefined;
    if (!srcStat.dir && !tgtIsDir && this.operands === 2) {
      // a file onto a file
    } else if (this.opts.recursive) {
      if (tgtExists) {
        appended = basename(src);
        tgt = resolveOperand(tgt, appended);
      } else if (this.operands !== 2) return void (this.error = `directory ${this.tgtOperand} does not exist`);
    } else {
      if (srcStat.dir) return void (this.error = `${this.srcOperand} is a directory (not copied)`);
      if (!tgtExists || !tgtIsDir) return void (this.error = `${this.tgtOperand} is not a directory`);
      appended = basename(src);
      tgt = resolveOperand(tgt, appended);
    }

    const check = this.checkPaths(src, tgt, appended);
    if (check === "skip") return;
    if (check !== "copy") return void (this.error = check);
    try {
      await this.copy(src, tgt);
    } catch (e) {
      this.error ??= this.sys(e, tgt);
    }
  }

  /** node's fs.cp as the shell runs it (node_fs.rs cp_async): -n keeps files that exist. */
  private async copy(src: string, dest: string) {
    const { fs } = this.ctx;
    const st = fs.stat(src)!;
    if (!st.dir) {
      let copied: boolean;
      try {
        copied = await this.copyFile(src, dest);
      } catch (e) {
        this.onCopy(src, dest);
        throw e;
      }
      if (copied) this.onCopy(src, dest);
      return;
    }
    // A breadth-first walk, as cp_async_directory's pending list does it.
    const pending: [string, string][] = [[trimSep(src), trimSep(dest)]];
    for (let next = pending.shift(); next; next = pending.shift()) {
      if (this.ctx.signal.aborted) return;
      const [s, d] = next;
      const existing = fs.stat(d);
      if (existing && !existing.dir) throw new SysError("EEXIST", d);
      if (!existing) {
        const why = missing(this.ctx, d);
        if (why === "ENOTDIR") throw new SysError(why, d);
        fs.mkdir(d);
      }
      this.onCopy(s, d);
      for (const entry of fs.readdir(s)) {
        const from = `${s === "/" ? "" : s}/${entry.name}`;
        const to = `${d === "/" ? "" : d}/${entry.name}`;
        if (entry.dir) pending.push([from, to]);
        else {
          try {
            if (await this.copyFile(from, to)) this.onCopy(from, to);
          } catch (e) {
            this.error ??= this.sys(e, to);
          }
        }
      }
    }
  }

  /** copy_single_file_sync; false when `-n` kept an existing file (EEXIST, which cp ignores). */
  private async copyFile(src: string, dest: string): Promise<boolean> {
    const { fs } = this.ctx;
    const existing = fs.stat(dest);
    if (existing) {
      if (this.opts.noClobber) return false;
      if (existing.dir) throw new SysError("EISDIR", dest);
    } else {
      if (hasTrailingSep(dest)) throw new SysError("EISDIR", dest);
      const why = missing(this.ctx, dest);
      if (why === "ENOTDIR" || fs.stat(dirname(dest) ?? "/") === undefined) throw new SysError(why ?? "ENOENT", dest);
    }
    fs.write(dest, await fs.read(src));
    return true;
  }
}

export const cp: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  const opts: Opts = { recursive: false, verbose: false, noClobber: false };
  let start = -1;
  for (let idx = 0; idx < args.length; idx++) {
    const parsed = parseFlag(opts, args[idx]!);
    if (parsed === "done") {
      start = idx;
      break;
    }
    if (parsed?.illegal !== undefined) {
      await err(ctx, `cp: illegal option -- ${parsed.illegal}\n`);
      return 1;
    }
    if (parsed?.unsupported !== undefined) {
      await err(ctx, `cp: unsupported option, please open a GitHub issue -- ${parsed.unsupported}\n`);
      return 1;
    }
  }
  if (start < 0 || args.length - start < 2) {
    await err(ctx, USAGE);
    return 1;
  }
  const sources = args.slice(start, -1);
  const target = args.at(-1)!;
  let failed = false;
  for (const source of sources) {
    if (ctx.signal.aborted) break;
    const task = new CpTask(ctx, opts, sources.length + 1, source, target);
    await task.run();
    if (task.error !== undefined) {
      failed = true;
      await err(ctx, `cp: ${task.error}\n`);
    }
    if (task.verbose.length) await out(ctx, task.verbose.join(""));
  }
  return failed ? 1 : 0;
};
