// Runs the AST Bun's shell parser gives (parse.ts) the way Bun's interpreter does (bun/src/runtime/shell/states/):
// statements, && and ||, pipelines (each stage concurrent, joined by pipes), subshells, if, [[ ]], one redirect per
// command, and word expansion ($VAR, $0-$9, ~, $(…), {a,b}, * and **). Commands are the builtins (builtins.ts) and
// whatever the host adds (the console's bun and git, a program's child processes); everything else is `command not found`.
import type { VFS } from "@runbun/vfs";
import type { Assign, Atom, CondExpr, Expr, If, PipelineItem, Redirect, RedirectFlags, Script, SimpleAtom, Stmt, Subshell } from "./ast";
import type { ShellWasm } from "./parse";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── streams ──

export interface Reader {
  /** The next chunk, or null at the end. */
  read(): Promise<Uint8Array | null>;
  /** Done reading: a writer still writing into it sees the pipe closed. */
  close(): void;
}

export interface Writer {
  /** False once nobody reads any more (EPIPE) or the target is full: a command stops writing then. */
  write(chunk: Uint8Array | string): Promise<boolean>;
  /** Why the last write failed, when it did for a reason a command reports (`ENOSPC`: a full buffer). */
  error?: string;
}

export const EMPTY: Reader = { read: async () => null, close() {} };
export const DISCARD: Writer = { write: async () => true };

/** Bytes in memory: what `$(…)`, a redirect into a file or a buffer, and `Bun.$` collect. */
export class Collect implements Writer {
  chunks: Uint8Array[] = [];
  async write(chunk: Uint8Array | string) {
    this.chunks.push(typeof chunk === "string" ? enc.encode(chunk) : chunk.slice());
    return true;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
  text() {
    return dec.decode(this.bytes());
  }
}

/** A template buffer as a redirect target (`> ${buf}`): written as output arrives, up to its length as it is now. */
export class BufferSink implements Writer {
  private at = 0;
  error?: string;
  private view: () => Uint8Array;
  constructor(view: () => Uint8Array) {
    this.view = view;
  }
  async write(chunk: Uint8Array | string) {
    const c = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    const v = this.view();
    const n = Math.max(0, Math.min(c.length, v.length - this.at));
    v.set(c.subarray(0, n), this.at);
    this.at += n;
    if (n < c.length) {
      this.error = "ENOSPC";
      return false;
    }
    return true;
  }
}

/** A buffer-like template value's bytes, as they are now (a resized or detached buffer: fewer, or none). */
export function viewOf(value: ArrayBufferLike | ArrayBufferView): Uint8Array {
  try {
    return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
  } catch {
    return new Uint8Array();
  }
}

/** A reader over bytes already in hand (a file for `<`, a buffer from the template). */
export function readerOf(bytes: Uint8Array): Reader {
  let done = false;
  return {
    read: async () => (done || !bytes.length ? null : ((done = true), bytes)),
    close: () => void (done = true),
  };
}

/** A pipe between two stages: the writer waits while 64 KiB are unread, and learns when the reader is gone. */
export function pipe(): { reader: Reader; writer: Writer; end(): void } {
  const queue: Uint8Array[] = [];
  let queued = 0;
  let ended = false;
  let closed = false;
  let wakeReader: (() => void) | undefined;
  let wakeWriter: (() => void) | undefined;
  const wake = (w: (() => void) | undefined) => w?.();
  return {
    reader: {
      async read() {
        while (!queue.length && !ended && !closed) await new Promise<void>((r) => (wakeReader = r));
        const c = queue.shift();
        if (!c) return null;
        queued -= c.length;
        wake(wakeWriter);
        return c;
      },
      close() {
        closed = true;
        queue.length = 0;
        wake(wakeWriter);
      },
    },
    writer: {
      async write(chunk) {
        if (closed) return false;
        const c = typeof chunk === "string" ? enc.encode(chunk) : chunk.slice();
        if (!c.length) return true;
        queue.push(c);
        queued += c.length;
        wake(wakeReader);
        while (queued > 65536 && !closed) await new Promise<void>((r) => (wakeWriter = r));
        return !closed;
      },
    },
    end() {
      ended = true;
      wake(wakeReader);
    },
  };
}

/** Everything a reader gives, joined. */
export async function readAll(r: Reader): Promise<Uint8Array> {
  const c = new Collect();
  for (let chunk = await r.read(); chunk; chunk = await r.read()) c.chunks.push(chunk);
  return c.bytes();
}

// ── files ──

/** The files the shell works on, by absolute path (`/` is the project's root in the playground). */
export interface ShellFs {
  stat(path: string): { dir: boolean; size: number; mtime: number } | undefined;
  /** A folder's entries, sorted by name. */
  readdir(path: string): { name: string; dir: boolean }[];
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array | string): void;
  /** Makes the folder and its parents. */
  mkdir(path: string): void;
  /** A file, or a folder with everything in it. */
  remove(path: string): void;
  rename(from: string, to: string): void;
  /** Sets a file's modification time (touch). */
  touch?(path: string, time: number): void;
}

/** The project's VFS as the shell's files: `/src/a.ts` is `src/a.ts`. */
export function vfsFs(vfs: VFS): ShellFs {
  const p = (path: string) => path.replace(/^\/+/, "");
  return {
    stat(path) {
      const k = p(path);
      if (vfs.isDir(k)) return { dir: true, size: 0, mtime: vfs.mtimes.get(k) ?? 0 };
      const size = vfs.size(k);
      return size === undefined ? undefined : { dir: false, size, mtime: vfs.mtimes.get(k) ?? 0 };
    },
    readdir: (path) => vfs.readdir(p(path)),
    async read(path) {
      await vfs.ensure([p(path)]);
      return vfs.readBytes(p(path)) ?? new Uint8Array();
    },
    write: (path, data) => vfs.write(p(path), data),
    mkdir: (path) => vfs.mkdir(p(path)),
    remove: (path) => vfs.remove(p(path)),
    rename: (from, to) => vfs.rename(p(from), p(to)),
    touch: (path, time) => void vfs.mtimes.set(p(path), time),
  };
}

// ── state ──

export type Io = { stdin: Reader; stdout: Writer; stderr: Writer };

/** The shell's environment: what a subshell copies and `cd`, `export` and `x=1` change. */
export class ShellEnv {
  /** Absolute, `/` being the project's root. */
  cwd: string;
  /** `x=1`: the shell's own variables. */
  vars: Map<string, string>;
  /** `export x=1` (and the process's env): what commands see. */
  exported: Map<string, string>;
  /** `$0`…`$9`. */
  argv: string[];
  constructor(cwd = "/", vars = new Map<string, string>(), exported = new Map<string, string>(), argv: string[] = []) {
    this.cwd = cwd;
    this.vars = vars;
    this.exported = exported;
    this.argv = argv;
  }
  get(name: string): string | undefined {
    // $PWD is the shell's folder, whatever the process's env said.
    if (name === "PWD") return this.cwd;
    return this.vars.get(name) ?? this.exported.get(name);
  }
  copy() {
    return new ShellEnv(this.cwd, new Map(this.vars), new Map(this.exported), this.argv);
  }
}

/** What a command gets: its words, its streams, the shell's env, and the project's files. */
export type CommandCtx = Io & {
  argv: string[];
  shell: ShellEnv;
  /** The exported variables plus this command's `x=1` prefix. */
  env: Record<string, string>;
  fs: ShellFs;
  /** A path resolved against the cwd: absolute and normalized. */
  path(p: string): string;
  /** Whether a name is a builtin, or one of the host's commands (the console's bun and git): `which`. */
  known(name: string): "builtin" | "command" | undefined;
  signal: AbortSignal;
};

export type Command = (ctx: CommandCtx) => Promise<number>;

/** `exit [n]`: ends the script (or the subshell it's in). */
export class ExitSignal {
  code: number;
  constructor(code: number) {
    this.code = code;
  }
}

class ExpansionError extends Error {}

export type ShellOptions = {
  fs: ShellFs;
  wasm: ShellWasm;
  builtins: Record<string, Command>;
  /** The host's commands (the console's bun, git, help…), after the builtins. */
  commands?: Record<string, Command>;
  /** Any other command the host can start in `cwd` with `PATH` (a program's child process, worker/processes.ts); undefined: not found. */
  external?: (name: string, cwd: string, PATH?: string) => Command | undefined;
  home?: string;
  signal?: AbortSignal;
};

/** `/a/b/../c` to `/a/c`. */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export const resolvePath = (cwd: string, p: string) => normalize(p.startsWith("/") ? p : `${cwd}/${p}`);

// ── globs ──

type Glob = { pattern: string; meta: Set<number> };

/**
 * The pattern's matches, walking folders from where its first `*` is; `*` and `**` only where the script wrote them,
 * and neither matches a name starting with a dot. Relative patterns give paths relative to the cwd.
 */
function globMatch(fs: ShellFs, cwd: string, { pattern, meta }: Glob): string[] {
  const first = [...meta].sort((x, y) => x - y)[0] ?? pattern.length;
  const baseEnd = pattern.lastIndexOf("/", first);
  const prefix = baseEnd < 0 ? "" : pattern.slice(0, baseEnd + 1);
  const root = resolvePath(cwd, prefix || ".");
  let re = "";
  for (let i = baseEnd + 1; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && meta.has(i)) {
      if (pattern[i + 1] === "*" && meta.has(i + 1)) {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:[^/.][^/]*/)*";
        } else re += "(?:[^/.][^/]*(?:/[^/.][^/]*)*)?";
      } else re += pattern[i - 1] === "/" || i === baseEnd + 1 ? "(?:[^/.][^/]*)?" : "[^/]*";
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const matcher = new RegExp(`^${re}$`);
  const deep = /\*\*/.test(pattern.slice(baseEnd + 1));
  const depth = pattern.slice(baseEnd + 1).split("/").length;
  const out: string[] = [];
  const walk = (dir: string, rel: string, level: number) => {
    let entries: { name: string; dir: boolean }[];
    try {
      entries = fs.readdir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel + e.name;
      if (matcher.test(r)) out.push(prefix + r);
      if (e.dir && (deep || level < depth) && !e.name.startsWith(".") && e.name !== "node_modules") walk(`${dir === "/" ? "" : dir}/${e.name}`, r + "/", level + 1);
    }
  };
  if (fs.stat(root)?.dir) walk(root, "", 1);
  return out.sort();
}

// ── the interpreter ──

export class Shell {
  private opts: ShellOptions;
  constructor(opts: ShellOptions) {
    this.opts = opts;
  }

  /** Runs a script; the exit code of its last command. `objs` are the template's values (`> ${buffer}`). */
  async run(script: Script, io: Io, env: ShellEnv, objs: unknown[] = []): Promise<number> {
    try {
      return await this.script(script, io, env, objs);
    } catch (e) {
      if (e instanceof ExitSignal) return e.code;
      throw e;
    }
  }

  private get signal() {
    return this.opts.signal ?? new AbortController().signal;
  }

  private async script(script: Script, io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    let code = 0;
    for (const stmt of script.stmts) code = await this.stmt(stmt, io, env, objs);
    return code;
  }

  private async stmts(list: Stmt[], io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    let code = 0;
    for (const stmt of list) code = await this.stmt(stmt, io, env, objs);
    return code;
  }

  private async stmt(stmt: Stmt, io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    let code = 0;
    for (const expr of stmt.exprs) {
      if (this.signal.aborted) return 130;
      code = await this.expr(expr, io, env, objs);
    }
    return code;
  }

  private async expr(expr: Expr, io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    if ("cmd" in expr) return this.cmd(expr.cmd, io, env, objs);
    if ("assign" in expr) return this.assign(expr.assign, io, env, objs);
    if ("binary" in expr) {
      const { op, left, right } = expr.binary;
      const l = await this.expr(left, io, env, objs);
      if ((op === "And" && l !== 0) || (op === "Or" && l === 0)) return l;
      return this.expr(right, io, env, objs);
    }
    if ("pipeline" in expr) return this.pipeline(expr.pipeline.items, io, env, objs);
    if ("subshell" in expr) return this.subshell(expr.subshell, io, env, objs);
    if ("if" in expr) return this.if(expr.if, io, env, objs);
    return this.cond(expr.condexpr, io, env, objs);
  }

  private item(item: PipelineItem, io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    if ("cmd" in item) return this.cmd(item.cmd, io, env, objs);
    if ("assigns" in item) return this.assign(item.assigns, io, env, objs);
    if ("subshell" in item) return this.subshell(item.subshell, io, env, objs);
    if ("if" in item) return this.if(item.if, io, env, objs);
    return this.cond(item.condexpr, io, env, objs);
  }

  /** Every stage at once, each one's stdout the next one's stdin; the last one's exit code. Each runs in a copy of the env. */
  private async pipeline(items: PipelineItem[], io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    const pipes = items.slice(1).map(() => pipe());
    const runs = items.map(async (item, i) => {
      const stdin = i === 0 ? io.stdin : pipes[i - 1]!.reader;
      const stdout = i === items.length - 1 ? io.stdout : pipes[i]!.writer;
      try {
        return await this.item(item, { stdin, stdout, stderr: io.stderr }, env.copy(), objs);
      } catch (e) {
        if (e instanceof ExitSignal) return e.code;
        throw e;
      } finally {
        if (i < items.length - 1) pipes[i]!.end();
        if (i > 0) pipes[i - 1]!.reader.close();
      }
    });
    const codes = await Promise.all(runs);
    return codes.at(-1)!;
  }

  private async subshell(sub: Subshell, io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    const redirected = await this.redirect(sub.redirect_flags, sub.redirect, io, env, objs);
    if (typeof redirected === "number") return redirected;
    try {
      return await this.script(sub.script, redirected.io, env.copy(), objs);
    } catch (e) {
      if (e instanceof ExitSignal) return e.code;
      throw e;
    } finally {
      await redirected.done();
    }
  }

  private async if(node: If, io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    if ((await this.stmts(node.cond, io, env, objs)) === 0) return this.stmts(node.then, io, env, objs);
    const parts = node.else_parts;
    // elif cond, then, … then a lone else.
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if ((await this.stmts(parts[i]!, io, env, objs)) === 0) return this.stmts(parts[i + 1]!, io, env, objs);
    }
    return parts.length % 2 ? this.stmts(parts.at(-1)!, io, env, objs) : 0;
  }

  /** `[[ … ]]` with Bun's operators: -c -d -f -z -n == !=. */
  private async cond(node: CondExpr, io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    let args: string[];
    try {
      args = [];
      for (const a of node.args) args.push(...(await this.expand(a, io, env, objs)).words);
    } catch (e) {
      return this.fail(io, e);
    }
    const [a = "", b = ""] = args;
    switch (node.op) {
      case "-f":
      case "-d":
      case "-c": {
        const st = this.opts.fs.stat(resolvePath(env.cwd, a));
        if (node.op === "-c") return 1;
        return (node.op === "-d" ? st?.dir : st && !st.dir) ? 0 : 1;
      }
      case "-z":
        return a === "" ? 0 : 1;
      case "-n":
        return a !== "" ? 0 : 1;
      case "==":
        return a === b ? 0 : 1;
      case "!=":
        return a !== b ? 0 : 1;
    }
    await io.stderr.write(`bun: unsupported conditional expression: ${node.op}\n`);
    return 1;
  }

  /** `x=1 y=2` alone: the shell's variables (expanded without splitting). */
  private async assign(list: Assign[], io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    try {
      for (const a of list) env.vars.set(a.label, (await this.expand(a.value, io, env, objs, true)).words.join(" "));
      return 0;
    } catch (e) {
      return this.fail(io, e);
    }
  }

  private async fail(io: Io, e: unknown): Promise<number> {
    if (!(e instanceof ExpansionError)) throw e;
    await io.stderr.write(`bun: ${e.message}\n`);
    return 1;
  }

  /** The command's redirect applied to its streams; `done` writes a file it filled. A number: it failed (stderr said why). */
  private async redirect(flags: RedirectFlags, target: Redirect | null, io: Io, env: ShellEnv, objs: unknown[], name = ""): Promise<{ io: Io; done(): Promise<void> } | number> {
    const out = { ...io };
    if (!target) {
      // `2>&1` (stdout + duplicate): stderr goes where stdout does; `1>&2` the other way.
      if (flags.duplicate_out) {
        if (flags.stdout) out.stderr = io.stdout;
        if (flags.stderr) out.stdout = io.stderr;
      }
      return { io: out, done: async () => {} };
    }
    if ("jsbuf" in target) {
      const value = objs[target.jsbuf.idx];
      if (flags.stdin) {
        out.stdin = readerOf(await bytesOf(value));
        return { io: out, done: async () => {} };
      }
      if (!isBufferLike(value)) {
        await io.stderr.write("bun: redirecting output to this kind of value is not supported\n");
        return 1;
      }
      const sink = new BufferSink(() => viewOf(value as ArrayBufferLike | ArrayBufferView));
      if (flags.stdout) out.stdout = sink;
      if (flags.stderr) out.stderr = sink;
      return { io: out, done: async () => {} };
    }
    let words: string[];
    try {
      words = (await this.expand(target.atom, io, env, objs)).words;
    } catch (e) {
      return this.fail(io, e);
    }
    if (words.length !== 1) {
      // Bun names the command, not the words.
      await io.stderr.write(`bun: ambiguous redirect: at \`${name}\`\n`);
      return 1;
    }
    const file = resolvePath(env.cwd, words[0]!);
    // The devices a shell script expects, which the project's files don't have.
    const device = { "/dev/null": DISCARD, "/dev/stdout": io.stdout, "/dev/stderr": io.stderr }[file];
    if (device) {
      if (flags.stdin) out.stdin = file === "/dev/null" ? EMPTY : io.stdin;
      else {
        if (flags.stdout) out.stdout = device;
        if (flags.stderr) out.stderr = device;
      }
      return { io: out, done: async () => {} };
    }
    const { fs } = this.opts;
    const st = fs.stat(file);
    if (flags.stdin) {
      if (!st || st.dir) {
        await io.stderr.write(`bun: ${st?.dir ? "Is a directory" : "No such file or directory"}: ${words[0]}\n`);
        return 1;
      }
      out.stdin = readerOf(await fs.read(file));
      return { io: out, done: async () => {} };
    }
    if (st?.dir) {
      await io.stderr.write(`bun: Is a directory: ${words[0]}\n`);
      return 1;
    }
    const sink = new Collect();
    if (flags.stdout) out.stdout = sink;
    if (flags.stderr) out.stderr = sink;
    // Opened (and truncated) up front, as the shell's open() does.
    if (!flags.append || !st) fs.write(file, "");
    return {
      io: out,
      done: async () => {
        const bytes = sink.bytes();
        if (flags.append) {
          const before = await fs.read(file);
          const joined = new Uint8Array(before.length + bytes.length);
          joined.set(before);
          joined.set(bytes, before.length);
          fs.write(file, joined);
        } else fs.write(file, bytes);
      },
    };
  }

  private async cmd(node: import("./ast").Cmd, io: Io, env: ShellEnv, objs: unknown[]): Promise<number> {
    const local: Record<string, string> = {};
    const argv: string[] = [];
    let substExit: number | undefined;
    try {
      for (const a of node.assigns) local[a.label] = (await this.expand(a.value, io, env, objs, true)).words.join(" ");
      for (const [i, atom] of node.name_and_args.entries()) {
        // `export NAME=$(…)`: a literal `NAME=` word expands as an assignment does (no field splitting).
        const first = "simple" in atom ? atom.simple : atom.compound.atoms[0];
        const assignWord = i > 0 && argv[0] === "export" && !!first && "Text" in first && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.Text);
        const r = await this.expand(atom, io, env, objs, assignWord);
        if (i === 0 && r.exitCode) substExit = r.exitCode;
        argv.push(...r.words);
      }
    } catch (e) {
      return this.fail(io, e);
    }
    // `$(false)` as the whole command: its exit code.
    if (!argv.length) return substExit ?? 0;
    const name = argv[0]!;
    const redirected = await this.redirect(node.redirect, node.redirect_file, io, env, objs, name);
    if (typeof redirected === "number") return redirected;
    const run = this.opts.builtins[name] ?? this.opts.commands?.[name] ?? this.opts.external?.(name, env.cwd, local.PATH ?? env.get("PATH"));
    try {
      if (!run) {
        await redirected.io.stderr.write(`bun: command not found: ${name}\n`);
        return 1;
      }
      const ctx: CommandCtx = {
        ...redirected.io,
        argv,
        shell: env,
        env: { ...Object.fromEntries(env.exported), ...local },
        fs: this.opts.fs,
        path: (p) => resolvePath(env.cwd, p),
        known: (n) => (Object.hasOwn(this.opts.builtins, n) ? "builtin" : (this.opts.commands && Object.hasOwn(this.opts.commands, n)) || this.opts.external?.(n, env.cwd, env.get("PATH")) ? "command" : undefined),
        signal: this.signal,
      };
      return await run(ctx);
    } finally {
      await redirected.done();
    }
  }

  /**
   * A word's expansion (Expansion.rs): its pieces joined, then braces, then globs. `$(…)` output splits at whitespace
   * unless quoted or in an assignment; variables never split.
   */
  private async expand(atom: Atom, io: Io, env: ShellEnv, objs: unknown[], assign = false): Promise<{ words: string[]; exitCode?: number }> {
    const atoms: SimpleAtom[] = "simple" in atom ? [atom.simple] : atom.compound.atoms;
    const braceHint = "compound" in atom && atom.compound.brace_expansion_hint;
    const globHint = atoms.some((a) => "asterisk" in a || "double_asterisk" in a);
    const words: string[] = [];
    let cur = "";
    let quotedEmpty = false;
    let exitCode: number | undefined;
    /** Offsets in `cur` of the `{ , } *` the script wrote (not ones that came from a variable or a value). */
    let meta = new Set<number>();
    const flush = () => {
      words.push(cur);
      cur = "";
      meta = new Set();
    };
    const leadingTilde = atoms.length > 1 && "tilde" in atoms[0]!;
    // ~ is $HOME as the shell has it now (empty when it's empty).
    const home = env.get("HOME") ?? this.opts.home ?? "";
    for (const [i, a] of atoms.entries()) {
      if (i === 0 && leadingTilde) continue;
      if ("Text" in a) cur += a.Text;
      else if ("Var" in a) cur += env.get(a.Var) ?? "";
      else if ("VarArgv" in a) cur += env.argv[a.VarArgv] ?? "";
      else if ("quoted_empty" in a) quotedEmpty = true;
      else if ("asterisk" in a) meta.add(cur.length), (cur += "*");
      else if ("double_asterisk" in a) meta.add(cur.length).add(cur.length + 1), (cur += "**");
      else if ("brace_begin" in a) meta.add(cur.length), (cur += "{");
      else if ("brace_end" in a) meta.add(cur.length), (cur += "}");
      else if ("comma" in a) meta.add(cur.length), (cur += ",");
      else if ("tilde" in a) cur += home;
      else if ("cmd_subst" in a) {
        const sink = new Collect();
        const code = await this.run(a.cmd_subst.script, { stdin: io.stdin, stdout: sink, stderr: io.stderr }, env.copy(), objs);
        if (code && atoms.length === 1) exitCode = code;
        let out = sink.text().replaceAll("\0", "");
        if (a.cmd_subst.quoted || assign) {
          cur += out.replace(/[ \n\r\t]+$/, "");
          if (!out && a.cmd_subst.quoted) quotedEmpty = true;
        } else {
          if (out.endsWith("\n")) out = out.slice(0, -1);
          const parts = out.replaceAll("\n", " ").replace(/^[ \n\r\t]+|[ \n\r\t]+$/g, "").split(/ +/).filter(Boolean);
          for (const [j, p] of parts.entries()) {
            cur += p;
            if (j < parts.length - 1) flush();
          }
        }
      }
    }
    if (leadingTilde) {
      if (cur.startsWith("/")) {
        cur = home + cur;
        meta = new Set([...meta].map((m) => m + home.length));
      } else if (cur) {
        cur = "~" + cur;
        meta = new Set([...meta].map((m) => m + 1));
      } else if (quotedEmpty) cur = home;
    }
    const pending: Glob[] = [];
    if (braceHint) {
      // Only the script's own `{ , }` expand: the rest is escaped for the brace lexer.
      let escaped = "";
      for (let i = 0; i < cur.length; i++) {
        const c = cur[i]!;
        if (!meta.has(i) && "{},\\".includes(c)) escaped += "\\";
        escaped += c;
      }
      let variants: string[];
      try {
        variants = this.opts.wasm.braces(escaped);
      } catch (e) {
        throw new ExpansionError((e as Error).message);
      }
      // A glob in a variant: its `*`s are where the script wrote them (a rough map, as `{}` only changes lengths).
      for (const v of variants) {
        if (globHint && v.includes("*")) pending.push({ pattern: v, meta: new Set([...v].flatMap((c, i) => (c === "*" ? [i] : []))) });
        else words.push(v);
      }
    } else if (globHint) pending.push({ pattern: cur, meta });
    else if (cur || quotedEmpty || words.length) words.push(cur);
    for (const g of pending) {
      const found = globMatch(this.opts.fs, env.cwd, g);
      if (!found.length) {
        if (assign) words.push(g.pattern);
        else throw new ExpansionError(`no matches found: ${g.pattern}`);
      }
      words.push(...found);
    }
    return { words, exitCode };
  }
}

export const isBufferLike = (v: unknown): v is ArrayBufferLike | ArrayBufferView =>
  v instanceof ArrayBuffer || ArrayBuffer.isView(v) || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer);

/** A template value redirected into stdin (`< ${x}`): a copy of its bytes, as they are when the command starts. */
async function bytesOf(value: unknown): Promise<Uint8Array> {
  if (isBufferLike(value)) return viewOf(value).slice();
  if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (typeof Response !== "undefined" && value instanceof Response) return new Uint8Array(await value.arrayBuffer());
  return enc.encode(String(value));
}
