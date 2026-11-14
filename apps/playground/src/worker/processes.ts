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
import { decodeVfs, Part, SyncReader, type VfsOp } from "./syncChannel";

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

/** What `argv` launches and the id its child gets; throws for a command that isn't there or can't run here. */
function prepare(argv: string[], opts: SpawnOptions): { id: number; launch: Launch } {
  if (!argv.length || !argv[0]) throw Object.assign(new TypeError("cmd must be a non-empty array of strings"), { code: "ERR_INVALID_ARG_VALUE" });
  const launch = launchOf(argv, opts.cwd, files.has, files.read);
  if ("error" in launch) {
    if (launch.enoent) throw Object.assign(new Error(`Executable not found in $PATH: "${launch.error}"`), { code: "ENOENT", errno: -2, syscall: "posix_spawn", path: launch.error });
    throw Object.assign(new Error(launch.error), { code: "ENOTSUP", syscall: "posix_spawn", path: argv[0] });
  }
  // Process ids that don't collide with this program's own or another program's children (they show in ps-like output).
  return { id: pid * 100 + ++nextId, launch };
}

/**
 * Starts `argv` as a child process. Throws for a command that isn't there (`code` ENOENT) or can't run here, before
 * anything starts, as Bun.spawn does.
 */
export function spawnChild(argv: string[], opts: SpawnOptions): Child {
  const { id, launch } = prepare(argv, opts);
  const child = new Child(id);
  children.set(id, child);
  post({ type: "spawn", id, launch, cwd: opts.cwd, env: opts.env });
  return child;
}

/** The page's reports about this program's children ("proc" messages). */
export function onProcMessage(m: { id: number; ev: "out"; fd: 1 | 2; data: Uint8Array } | { id: number; ev: "exit"; code: number; signal: string | null }) {
  children.get(m.id)?.report(m);
}

/** A child by its pid, for process.kill. */
export const childByPid = (id: number) => children.get(id);

// --- synchronous children ---------------------------------------------------------------------------------------------
//
// spawnSync, execSync, execFileSync and Bun.spawnSync block this program until the child is done. Its output, its exit
// and the file changes made meanwhile come through shared memory (syncChannel.ts), which only a cross-origin isolated
// page has; elsewhere they throw a NotIsolatedError. The child itself is the same worker an async spawn starts.

/** Whether this program can block on a child: SharedArrayBuffer and Atomics.wait (a cross-origin isolated page). */
export const canBlock = () => typeof SharedArrayBuffer === "function" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

/** Why a synchronous child process can't run here. */
export class NotIsolatedError extends Error {
  override name = "NotIsolatedError";
  readonly code = "ERR_NOT_ISOLATED";
  constructor(api: string, instead: string) {
    super(
      `${api} needs a cross-origin isolated page: it blocks this program until the child ends (SharedArrayBuffer and Atomics.wait), and this page isn't isolated. runbun.dev is; an embed is only when the page around it sends the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers. Use ${instead} instead.`,
    );
  }
}

let applyVfs: (op: VfsOp) => void = () => {};
/** How a file change made while this program waited reaches its copy of the files (runtime.ts). */
export function setSyncVfs(apply: (op: VfsOp) => void) {
  applyVfs = apply;
}

export type SyncOptions = SpawnOptions & {
  /** Bytes for its stdin, which is then closed. */
  input?: Uint8Array;
  /** Ms until it gets `killSignal` (SIGTERM). */
  timeout?: number;
  killSignal?: string | number;
  /** The most stdout or stderr it may write: then it gets `killSignal`, and the output stops there (ENOBUFS). */
  maxBuffer?: number;
  /** Output as it comes, for stdio that isn't collected ("inherit", "ignore"): true when it was taken. */
  pass?: (fd: 1 | 2, data: Uint8Array) => boolean;
};

export type SyncResult = { pid: number; stdout: Uint8Array; stderr: Uint8Array; status: ExitStatus; timedOut: boolean; overflow: boolean };

const concat = (chunks: Uint8Array[]) => {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) all.set(c, at), (at += c.length);
  return all;
};

/**
 * Runs `argv` as a child process and waits for it. `api` and `instead` name the call and its async counterpart for
 * the error on a page that isn't isolated. Throws, like spawnChild, for a command that isn't there.
 */
export function spawnChildSync(api: string, instead: string, argv: string[], opts: SyncOptions): SyncResult {
  if (!canBlock()) throw new NotIsolatedError(api, instead);
  const { id, launch } = prepare(argv, opts);
  const reader = new SyncReader(id, post);
  post({ type: "spawn", id, launch, cwd: opts.cwd, env: opts.env });
  if (opts.input?.length) {
    const copy = opts.input.slice();
    post({ type: "proc-in", id, data: copy }, [copy.buffer]);
  }
  post({ type: "proc-in", id, data: null });
  const out: Uint8Array[][] = [[], []];
  const size = [0, 0];
  const max = opts.maxBuffer ?? Infinity;
  const deadline = opts.timeout && opts.timeout > 0 ? Date.now() + opts.timeout : Infinity;
  let killed = false;
  let timedOut = false;
  let overflow = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    post({ type: "proc-kill", id, signal: signalName(opts.killSignal) ?? "SIGTERM" });
  };
  for (;;) {
    const part = reader.next(killed ? Infinity : deadline);
    if (!part) {
      timedOut = true;
      kill();
      continue;
    }
    if (part.kind === Part.Exit) {
      const { code, signal } = JSON.parse(new TextDecoder().decode(part.bytes)) as ExitStatus;
      return { pid: id, stdout: concat(out[0]!), stderr: concat(out[1]!), status: { code, signal }, timedOut, overflow };
    }
    if (part.kind === Part.Vfs) {
      applyVfs(decodeVfs(part.bytes));
      continue;
    }
    const i = part.kind === Part.Stdout ? 0 : 1;
    if (opts.pass?.(i === 0 ? 1 : 2, part.bytes) || overflow) continue;
    const room = max - size[i]!;
    out[i]!.push(part.bytes.length > room ? part.bytes.subarray(0, room) : part.bytes);
    size[i]! += Math.min(part.bytes.length, room);
    if (part.bytes.length > room) {
      overflow = true;
      kill();
    }
  }
}
