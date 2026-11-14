// The program's child processes. Each runs in a worker of its own, which the page starts and wires up (runner.ts):
// the child's stdout and stderr come back as bytes, its exit as a code (or a signal), and stdin and kill go to it.
// What a command line runs is decided here, over this worker's copy of the project, so a missing command fails as
// the call is made, as it does in Bun: `bun <file>`, `bun run <script|file>`, `node <file>`, an installed package's
// bin, `sh -c <line>` and the shell's builtins (a shell process). Bun.spawn (spawn.ts), node:child_process
// (node/child_process.ts) and Bun.$'s commands sit on top.
import { escape } from "../shell/dollar";
import { builtins as shellBuiltins } from "../shell/builtins";
import { normalize } from "../shell/interp";
import { binFile, type Has, type Pkg, type Read } from "../scripts";
import { hold, release } from "./loop";

/** What a child runs: a file (as `bun <file> ...args`), or a line in Bun's shell. */
export type Launch = { entry: string; args: string[] } | { script: string; args: string[] };

/** How a child ended: its code, or the signal that ended it (and the code a shell sees, 128 + its number). */
export type ExitStatus = { code: number; signal: string | null };

export const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 };

/** A signal by name or number, as its name; undefined for one there isn't. */
export function signalName(sig: string | number | undefined): string | undefined {
  if (sig === undefined || sig === null) return "SIGTERM";
  if (typeof sig === "number") return sig === 0 ? "0" : Object.keys(SIGNALS).find((k) => SIGNALS[k] === sig);
  const name = sig.toUpperCase().startsWith("SIG") ? sig.toUpperCase() : `SIG${sig.toUpperCase()}`;
  return name in SIGNALS ? name : undefined;
}

const parse = <T>(text: string | undefined): T | undefined => {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as T);
  } catch {}
};

const SCRIPT = /\.[cm]?[jt]sx?$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
/** Bun's subcommands, which a spawned `bun` can't run here (a file or script of that name still runs). */
const SUBCOMMANDS = new Set(["install", "i", "add", "a", "remove", "rm", "update", "link", "unlink", "pm", "test", "build", "init", "create", "upgrade", "x", "repl", "exec", "publish", "outdated", "audit", "info", "why", "patch", "fmt", "check"]);

/** Where the files live, relative to the project root as the VFS names them (`src/a.ts`). */
const projectPath = (cwd: string, p: string) => normalize(p.startsWith("/") ? p : `${cwd}/${p}`).slice(1);

/**
 * What `argv` runs in `cwd`: a Launch, or why it can't (`ENOENT` for a command that isn't there, a message otherwise).
 * Like Bun, `bun <name>` runs a file of that name, else a package.json script.
 */
export function launchOf(argv: string[], cwd: string, has: Has, read: Read): Launch | { error: string; enoent?: true } {
  const [name = "", ...rest] = argv;
  const base = name.split("/").pop()!;
  const file = (p: string) => {
    const path = projectPath(cwd, p);
    return has(path) ? path : undefined;
  };
  const script = (s: string, args: string[]): Launch => ({ script: [s, ...args.map(escape)].join(" "), args: [] });
  if (base === "bun" || base === "node" || base === "bunx") {
    // Flags before the file (`bun --watch a.ts`, `node --enable-source-maps a.js`) don't change what runs here.
    let i = 0;
    while (i < rest.length && rest[i]!.startsWith("-")) {
      if (/^(-e|--eval|-p|--print)$/.test(rest[i]!)) return { error: `${base} ${rest[i]}: evaluating code from the command line isn't supported here` };
      i++;
    }
    let target = rest[i];
    let args = rest.slice(i + 1);
    if (base === "bunx" || (base === "bun" && target === "x")) {
      const [pkg, ...more] = base === "bunx" ? rest.slice(i) : args;
      const bin = pkg && binFile(pkg.replace(/@[^/]*$/, ""), has, read);
      return bin ? { entry: bin, args: more } : { error: `${base}: ${pkg ?? "a package"} isn't installed (installing from a spawned process isn't supported here)` };
    }
    if (base === "bun" && target === "run") {
      while (i + 1 < rest.length && rest[i + 1]!.startsWith("-")) i++;
      target = rest[i + 1];
      args = rest.slice(i + 2);
    }
    if (!target) return { error: `${base}: a spawned ${base} needs a file to run` };
    const entry = file(target);
    if (entry) return { entry, args };
    if (base === "bun") {
      const s = parse<Pkg>(read(projectPath(cwd, "package.json")))?.scripts?.[target];
      if (s !== undefined) return script(s, args);
      if (SUBCOMMANDS.has(target)) return { error: `bun ${target} can't run from a spawned process here` };
      const bin = binFile(target, has, read);
      if (bin) return { entry: bin, args };
    }
    return { error: `${base}: Module not found "${target}"` };
  }
  if (SHELLS.has(base)) {
    const c = rest.indexOf("-c");
    if (c < 0 || rest[c + 1] === undefined) return { error: `${base}: only \`${base} -c <command>\` is supported here` };
    return { script: rest[c + 1]!, args: rest.slice(c + 2) };
  }
  if (Object.hasOwn(shellBuiltins, base) && !name.includes("/")) return script(argv.map(escape).join(" "), []);
  if (name.includes("/")) {
    const path = file(name);
    if (path && SCRIPT.test(path)) return { entry: path, args: rest };
    return path ? { error: `${name}: only JavaScript and TypeScript files can be executed here` } : { error: name, enoent: true };
  }
  const bin = binFile(base, has, read);
  if (bin) return { entry: bin, args: rest };
  return { error: name, enoent: true };
}

type Post = (msg: unknown, transfer?: Transferable[]) => void;
let post: Post = () => {
  throw new Error("child processes aren't available here");
};
let pid = 1;
let files: { has: Has; read: Read } = { has: () => false, read: () => undefined };
/** The worker's way to the page (runtime.ts), this process's own id, and its copy of the project's files. */
export function setKernel(p: Post, ownPid: number, has: Has, read: Read) {
  post = p;
  pid = ownPid;
  files = { has, read };
}

export type SpawnOptions = { cwd: string; env: Record<string, string> };

/** A running (or ended) child as the page reports it. */
export class Child {
  readonly pid: number;
  /** Bytes it wrote to stdout (1) or stderr (2), as they arrive. */
  onData: (fd: 1 | 2, data: Uint8Array) => void = () => {};
  /** Once, when it ended; after its last output. */
  onExit: (status: ExitStatus) => void = () => {};
  status?: ExitStatus;
  /** Whether `kill` sent it a signal. */
  killed = false;
  readonly exited: Promise<ExitStatus>;
  private settle!: (s: ExitStatus) => void;
  private stdinClosed = false;
  private holding = true;

  constructor(id: number) {
    this.pid = id;
    this.exited = new Promise((r) => (this.settle = r));
    hold(this);
  }
  /** Bytes to its stdin; false once that is closed or it ended. */
  write(data: Uint8Array): boolean {
    if (this.stdinClosed || this.status) return false;
    const copy = data.slice();
    post({ type: "proc-in", id: this.pid, data: copy }, [copy.buffer]);
    return true;
  }
  /** Closes its stdin (it reads the end). */
  end() {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    if (!this.status) post({ type: "proc-in", id: this.pid, data: null });
  }
  /** Sends it a signal (SIGTERM by default): false for one that isn't, or a child that already ended. */
  kill(signal: string | number = "SIGTERM"): boolean {
    const name = signalName(signal);
    if (!name) throw Object.assign(new TypeError(`Unknown signal: ${signal}`), { code: "ERR_UNKNOWN_SIGNAL" });
    if (this.status) return false;
    if (name === "0") return true;
    this.killed = true;
    post({ type: "proc-kill", id: this.pid, signal: name });
    return true;
  }
  /** Whether it keeps the program running (`unref` lets the program end without waiting for it). */
  ref() {
    if (!this.holding && !this.status) hold(this);
    this.holding = true;
  }
  unref() {
    this.holding = false;
    release(this);
  }
  /** @internal The page's report. */
  report(m: { ev: "out"; fd: 1 | 2; data: Uint8Array } | { ev: "exit"; code: number; signal: string | null }) {
    if (this.status) return;
    if (m.ev === "out") return this.onData(m.fd, m.data);
    this.status = { code: m.code, signal: m.signal };
    children.delete(this.pid);
    // Its exit is handled before the program may count as idle (the release schedules that check).
    try {
      this.onExit(this.status);
    } finally {
      this.settle(this.status);
      release(this);
    }
  }
}

const children = new Map<number, Child>();
let nextId = 0;

/**
 * Starts `argv` as a child process. Throws for a command that isn't there (`code` ENOENT) or can't run here, before
 * anything starts, as Bun.spawn does.
 */
export function spawnChild(argv: string[], opts: SpawnOptions): Child {
  if (!argv.length || !argv[0]) throw Object.assign(new TypeError("cmd must be a non-empty array of strings"), { code: "ERR_INVALID_ARG_VALUE" });
  const launch = launchOf(argv, opts.cwd, files.has, files.read);
  if ("error" in launch) {
    if (launch.enoent) throw Object.assign(new Error(`Executable not found in $PATH: "${launch.error}"`), { code: "ENOENT", errno: -2, syscall: "posix_spawn", path: launch.error });
    throw Object.assign(new Error(launch.error), { code: "ENOTSUP", syscall: "posix_spawn", path: argv[0] });
  }
  // Process ids that don't collide with this program's own or another program's children (they show in ps-like output).
  const id = pid * 100 + ++nextId;
  const child = new Child(id);
  children.set(id, child);
  post({ type: "spawn", id, launch, cwd: opts.cwd, env: opts.env });
  return child;
}

/**
 * Starts a worker_threads thread (node/worker_threads.ts): a child running `file` (resolved against `opts.cwd`) that
 * gets `port` and `thread` as it starts. A file that isn't there fails in the thread, as its "error" event.
 */
export function spawnThread(file: string, args: string[], opts: SpawnOptions, port: MessagePort, thread: object, transfer: Transferable[] = []): Child {
  const id = pid * 100 + ++nextId;
  const child = new Child(id);
  children.set(id, child);
  post({ type: "spawn", id, launch: { entry: projectPath(opts.cwd, file), args }, cwd: opts.cwd, env: opts.env, thread, port }, [port, ...transfer]);
  return child;
}

/** The page's reports about this program's children ("proc" messages). */
export function onProcMessage(m: { id: number; ev: "out"; fd: 1 | 2; data: Uint8Array } | { id: number; ev: "exit"; code: number; signal: string | null }) {
  children.get(m.id)?.report(m);
}

/** A child by its pid, for process.kill. */
export const childByPid = (id: number) => children.get(id);
