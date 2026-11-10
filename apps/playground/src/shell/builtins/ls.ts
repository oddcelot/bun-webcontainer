// `ls`: bun/src/runtime/shell/builtin/ls.rs
import type { Command, CommandCtx, ShellFs } from "../interp";
import { errnoOf, missingErrno, nameTooLong, sysErrorText } from "./errno";
import { err, out } from "./util";

type Dotfiles = "hide" | "almost-all" | "all";
type Opts = { dotfiles: Dotfiles; listDirectories: boolean; long: boolean; recursive: boolean };

// Recognized, and ignored like in Bun.
const NO_OP = new Set("r1bBcCDfFgGhHiIkLmnNopqQsStTuUvwxXZ");

export const ls: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  const opts: Opts = { dotfiles: "hide", listDirectories: false, long: false, recursive: false };
  let start: number | undefined;
  for (let idx = 0; idx < args.length && start === undefined; idx++) {
    const flag = args[idx]!;
    if (!flag.length || flag[0] !== "-") {
      start = idx;
      break;
    }
    // Bun names the first character after the `-` as the illegal one, whichever it was.
    if (flag.length === 1) return illegal(ctx, "-");
    for (const ch of flag.slice(1)) {
      if (ch === "a") opts.dotfiles = "all";
      else if (ch === "A") opts.dotfiles = "almost-all";
      else if (ch === "d") opts.listDirectories = true;
      else if (ch === "l") opts.long = true;
      else if (ch === "R") opts.recursive = true;
      else if (!NO_OP.has(ch)) return illegal(ctx, flag[1]!);
    }
  }

  const operands = start === undefined ? ["."] : args.slice(start);
  const lister = new Lister(ctx, opts);
  for (const operand of operands) {
    await lister.list(operand, operands.length > 1);
    if (ctx.signal.aborted) break;
  }
  return lister.failed ? 1 : 0;
};

async function illegal(ctx: CommandCtx, opt: string) {
  await err(ctx, `ls: illegal option -- ${opt}\n`);
  return 1;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SIX_MONTHS_SECS = 180 * 24 * 60 * 60;

class Lister {
  failed = false;
  private now = Math.floor(Date.now() / 1000);
  private ctx: CommandCtx;
  private opts: Opts;
  constructor(ctx: CommandCtx, opts: Opts) {
    this.ctx = ctx;
    this.opts = opts;
  }

  /**
   * One ShellLsTask: a folder's entries (after `path:` when asked to), else the operand itself. Bun runs the
   * subfolders of -R as tasks of their own, each printing when done; here they follow their parent in order.
   */
  async list(path: string, printDirectory: boolean): Promise<void> {
    const { ctx, opts } = this;
    const abs = ctx.path(path);
    const st = nameTooLong(abs) ? undefined : ctx.fs.stat(abs);
    if (!st) return this.fail(missingErrno(ctx.fs, abs), path);
    if (!st.dir) return void (await out(ctx, this.entry(path, abs)));
    if (opts.listDirectories) return void (await out(ctx, path + "\n"));

    let entries: { name: string; dir: boolean }[];
    try {
      entries = ctx.fs.readdir(abs);
    } catch (e) {
      return this.fail(errnoOf(e), path);
    }
    let text = printDirectory ? `${path}:\n` : "";
    if (!this.skip(".")) text += this.entry(".", abs);
    if (!this.skip("..")) text += this.entry("..", abs.slice(0, abs.lastIndexOf("/")) || "/");
    const subdirs: string[] = [];
    for (const e of entries) {
      if (!this.skip(e.name)) text += this.entry(e.name, abs === "/" ? `/${e.name}` : `${abs}/${e.name}`);
      // Bun descends into every folder, hidden ones too, whether or not it lists them.
      if (e.dir && opts.recursive) subdirs.push(path.endsWith("/") ? path + e.name : `${path}/${e.name}`);
    }
    if (!(await out(ctx, text))) return;
    for (const sub of subdirs) {
      if (ctx.signal.aborted) return;
      await this.list(sub, true);
    }
  }

  private async fail(code: string, path: string) {
    this.failed = true;
    await err(this.ctx, sysErrorText("ls", code, path));
  }

  private skip(name: string) {
    if (this.opts.dotfiles === "all") return false;
    if (this.opts.dotfiles === "almost-all") return name === "." || name === "..";
    return name.startsWith(".");
  }

  private entry(name: string, abs: string): string {
    if (!this.opts.long) return name + "\n";
    const st = this.ctx.fs.stat(abs);
    if (!st) return `?????????? ? ? ? ?            ? ${name}\n`;
    // The shell's files have no modes, owners or link counts: what a fresh folder or file gets under umask 022, a
    // folder's links counted from its subfolders, and uid/gid 0.
    const perms = st.dir ? "drwxr-xr-x" : "-rw-r--r--";
    const nlink = st.dir ? 2 + this.subdirCount(abs) : 1;
    const time = formatTime(Math.floor(st.mtime / 1000), this.now);
    return `${perms} ${pad(nlink, 3)} ${pad(0, 5)} ${pad(0, 5)} ${pad(st.size, 8)} ${time} ${name}\n`;
  }

  private subdirCount(abs: string) {
    try {
      return this.ctx.fs.readdir(abs).filter((e) => e.dir).length;
    } catch {
      return 0;
    }
  }
}

const pad = (n: number, width: number) => String(n).padStart(width);
const two = (n: number) => String(n).padStart(2, "0");

/** `Mon DD HH:MM` within six months of now, else `Mon DD  YYYY`; in UTC, like Bun. */
function formatTime(timestamp: number, now: number): string {
  const secs = Math.max(0, timestamp);
  const d = new Date(secs * 1000);
  const month = MONTHS[d.getUTCMonth()]!;
  const recent = secs > Math.max(0, now - SIX_MONTHS_SECS) && secs <= now + SIX_MONTHS_SECS;
  return recent
    ? `${month} ${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
    : `${month} ${two(d.getUTCDate())}  ${String(d.getUTCFullYear()).padStart(4)}`;
}
