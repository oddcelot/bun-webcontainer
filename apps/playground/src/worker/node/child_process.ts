// node:child_process over the playground's child processes (../processes.ts): spawn, exec and execFile, with stdio as
// streams; spawnSync, execSync and execFileSync, which block this worker until the child is done (only on a
// cross-origin isolated page: elsewhere they throw a NotIsolatedError). fork needs an IPC channel to the child: it throws.
import EventEmitter from "events";
import { Readable, Writable } from "./stream";
import { Buffer } from "./buffer";
import process, { env as processEnv } from "./process";
import { NotIsolatedError, spawnChild, spawnChildSync, type Child } from "../processes";

type ReadStream = InstanceType<typeof Readable>;
type WriteStream = InstanceType<typeof Writable>;
type Stdio = "pipe" | "inherit" | "ignore" | "overlapped" | null | undefined;
type SpawnOptions = {
  cwd?: string | URL;
  env?: Record<string, string | undefined>;
  argv0?: string;
  stdio?: Stdio | Stdio[];
  shell?: boolean | string;
  signal?: AbortSignal;
  timeout?: number;
  killSignal?: string | number;
  detached?: boolean;
  windowsHide?: boolean;
};
type ExecOptions = SpawnOptions & { encoding?: BufferEncoding | "buffer" | null; maxBuffer?: number };
type ExecCallback = (error: ExecError | null, stdout: string | Buffer, stderr: string | Buffer) => void;
type ExecError = Error & { code?: number | string; killed?: boolean; signal?: string | null; cmd?: string; stdout?: string | Buffer; stderr?: string | Buffer };

const unsupported = (name: string, why: string) =>
  function () {
    throw Object.assign(new Error(`node:child_process.${name} is not supported in the playground: ${why}`), { code: "ERR_NOT_SUPPORTED" });
  };

export class ChildProcess extends EventEmitter {
  pid: number | undefined;
  stdin: WriteStream | null = null;
  stdout: ReadStream | null = null;
  stderr: ReadStream | null = null;
  stdio: (ReadStream | WriteStream | null)[] = [null, null, null];
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  connected = false;
  spawnfile = "";
  spawnargs: string[] = [];
  /** @internal */
  _child?: Child;

  kill(signal?: string | number): boolean {
    if (!this._child) return false;
    const sent = this._child.kill(signal);
    if (sent) this.killed = true;
    return sent;
  }
  ref() {
    this._child?.ref();
  }
  unref() {
    this._child?.unref();
  }
  send(): boolean {
    throw Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
  }
  disconnect() {}
  [Symbol.dispose]() {
    if (this.exitCode === null && this.signalCode === null) this.kill();
  }
}

/** `options.shell`: the command line runs in Bun's shell (`sh -c`); its words become one line. */
function argvOf(file: string, args: readonly string[], shell: SpawnOptions["shell"]): string[] {
  if (!shell) return [file, ...args];
  return [typeof shell === "string" ? shell : "sh", "-c", [file, ...args].join(" ")];
}

const stdioOf = (s: SpawnOptions["stdio"]): Stdio[] => (Array.isArray(s) ? [s[0], s[1], s[2]] : [s, s, s]);

/** Node's spawn: a ChildProcess whose `error` event reports a command that isn't there. */
export function spawn(file: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
  if (!Array.isArray(args)) {
    options = args as SpawnOptions | undefined;
    args = [];
  }
  const opts = options ?? {};
  if (typeof file !== "string" || !file) throw Object.assign(new TypeError(`The "file" argument must be of type string and not empty. Received ${JSON.stringify(file)}`), { code: "ERR_INVALID_ARG_TYPE" });
  const argv = argvOf(file, args as string[], opts.shell);
  const cp = new ChildProcess();
  cp.spawnfile = argv[0]!;
  cp.spawnargs = argv;
  const [inIo, outIo, errIo] = stdioOf(opts.stdio);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? processEnv)) if (v !== undefined) env[k] = String(v);
  const cwd = opts.cwd instanceof URL ? decodeURIComponent(opts.cwd.pathname) : (opts.cwd ?? process.cwd());
  let child: Child;
  try {
    child = spawnChild(argv, { cwd, env });
  } catch (e) {
    const err = e as Error & { code?: string };
    // Reported through the `error` event, after spawn returned (with Bun's message, not Node's `spawn x ENOENT`).
    const error = Object.assign(new Error(err.message), { errno: err.code === "ENOENT" ? -2 : undefined, code: err.code, syscall: `spawn ${file}`, path: file, spawnargs: argv.slice(1) });
    process.nextTick(() => {
      cp.emit("error", error);
      cp.emit("close", -2, null);
    });
    return cp;
  }
  cp._child = child;
  cp.pid = child.pid;
  const piped = (io: Stdio) => io === undefined || io === null || io === "pipe" || io === "overlapped";
  const out = piped(outIo) ? new Readable({ read() {} }) : null;
  const err = piped(errIo) ? new Readable({ read() {} }) : null;
  cp.stdout = out;
  cp.stderr = err;
  if (piped(inIo)) {
    cp.stdin = new Writable({
      write(chunk: Uint8Array | string, _enc: string, cb: (e?: Error | null) => void) {
        child.write(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        cb();
      },
      final(cb: (e?: Error | null) => void) {
        child.end();
        cb();
      },
    });
  } else child.end();
  cp.stdio = [cp.stdin, out, err];
  child.onData = (fd, data) => {
    const target = fd === 1 ? out : err;
    const io = fd === 1 ? outIo : errIo;
    if (target) target.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    else if (io === "inherit") (fd === 1 ? process.stdout : process.stderr).write(data);
  };
  const timer = opts.timeout ? setTimeout(() => cp.kill(opts.killSignal), opts.timeout) : undefined;
  const abort = () => {
    cp.kill(opts.killSignal);
    cp.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  child.onExit = (s) => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
    cp.exitCode = s.signal ? null : s.code;
    cp.signalCode = s.signal;
    cp.emit("exit", cp.exitCode, cp.signalCode);
    out?.push(null);
    err?.push(null);
    // `close` once the output streams have ended too (a reader that never reads still gets it).
    const streams = [out, err].filter((r): r is ReadStream => !!r && !r.readableEnded);
    let left = streams.length;
    const close = () => cp.emit("close", cp.exitCode, cp.signalCode);
    if (!left) return void process.nextTick(close);
    for (const r of streams) {
      r.once("end", () => --left || close());
      // Output nobody reads is drained, as Node's pipes are once the child is gone.
      if (r.readableFlowing === null) r.resume();
    }
  };
  process.nextTick(() => cp.emit("spawn"));
  if (opts.signal?.aborted) process.nextTick(abort);
  return cp;
}

/** Collects a child's output for exec/execFile's callback (strings in `encoding`, Buffers for "buffer"). */
function collect(cp: ChildProcess, cmd: string, opts: ExecOptions, cb?: ExecCallback) {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  cp.stdout?.on("data", (c: Buffer) => out.push(c));
  cp.stderr?.on("data", (c: Buffer) => err.push(c));
  const enc = opts.encoding === "buffer" || opts.encoding === null ? undefined : (opts.encoding ?? "utf8");
  const text = (chunks: Buffer[]) => (enc ? Buffer.concat(chunks).toString(enc) : Buffer.concat(chunks));
  let done = false;
  cp.on("error", (e: ExecError) => {
    if (done) return;
    done = true;
    cb?.(Object.assign(e, { cmd }), text(out), text(err));
  });
  cp.on("close", (code: number | null, signal: string | null) => {
    if (done) return;
    done = true;
    const stdout = text(out);
    const stderr = text(err);
    if (code === 0 && !signal) return cb?.(null, stdout, stderr);
    const e: ExecError = Object.assign(new Error(`Command failed: ${cmd}\n${String(stderr)}`), { code: code ?? undefined, killed: cp.killed, signal, cmd, stdout, stderr });
    cb?.(e, stdout, stderr);
  });
}

function execArgs(options?: ExecOptions | ExecCallback | null, callback?: ExecCallback): [ExecOptions, ExecCallback | undefined] {
  if (typeof options === "function") return [{}, options];
  return [options ?? {}, callback];
}

export function exec(command: string, options?: ExecOptions | ExecCallback | null, callback?: ExecCallback): ChildProcess {
  const [opts, cb] = execArgs(options, callback);
  const cp = spawn(command, [], { ...opts, shell: opts.shell || true });
  collect(cp, command, opts, cb);
  return cp;
}

export function execFile(file: string, args?: readonly string[] | ExecOptions | ExecCallback | null, options?: ExecOptions | ExecCallback | null, callback?: ExecCallback): ChildProcess {
  if (typeof args === "function") [args, options, callback] = [[], {}, args];
  else if (!Array.isArray(args)) [args, options, callback] = [[], args as ExecOptions | null, options as ExecCallback | undefined];
  const [opts, cb] = execArgs(options, callback);
  const cp = spawn(file, args as string[], opts);
  collect(cp, [file, ...(args as string[])].join(" "), opts, cb);
  return cp;
}

// util.promisify(exec) / promisify(execFile) resolve with { stdout, stderr } (and reject with them on the error).
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
const promised =
  (fn: (...a: never[]) => ChildProcess) =>
  (...args: unknown[]) => {
    let child!: ChildProcess;
    const p = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((resolve, reject) => {
      child = (fn as (...a: unknown[]) => ChildProcess)(...args, (e: ExecError | null, stdout: string | Buffer, stderr: string | Buffer) => (e ? reject(Object.assign(e, { stdout, stderr })) : resolve({ stdout, stderr })));
    });
    return Object.assign(p, { child });
  };
Object.defineProperty(exec, promisifyCustom, { value: promised(exec as never) });
Object.defineProperty(execFile, promisifyCustom, { value: promised(execFile as never) });

type SyncOptions = ExecOptions & { input?: string | ArrayBufferView };
type SpawnSyncResult = {
  pid: number;
  output: (string | Buffer | null)[];
  stdout: string | Buffer | null;
  stderr: string | Buffer | null;
  status: number | null;
  signal: string | null;
  error?: ExecError;
};

/** Node's spawnSync over processes.ts spawnChildSync: output in `encoding`, a failure to start or a timeout in `error`. */
function runSync(api: string, instead: string, file: string, args: readonly string[], opts: SyncOptions, stdio: Stdio[]): SpawnSyncResult {
  const argv = argvOf(file, args, opts.shell);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? processEnv)) if (v !== undefined) env[k] = String(v);
  const cwd = opts.cwd instanceof URL ? decodeURIComponent(opts.cwd.pathname) : (opts.cwd ?? process.cwd());
  const input = typeof opts.input === "string" ? Buffer.from(opts.input) : opts.input && new Uint8Array(opts.input.buffer, opts.input.byteOffset, opts.input.byteLength);
  const piped = (io: Stdio) => io === undefined || io === null || io === "pipe" || io === "overlapped";
  const enc = opts.encoding === "buffer" || opts.encoding === null ? undefined : opts.encoding;
  const text = (b: Uint8Array, io: Stdio) => (piped(io) ? (enc ? Buffer.from(b).toString(enc) : Buffer.from(b.buffer, b.byteOffset, b.byteLength)) : null);
  let r;
  try {
    r = spawnChildSync(api, instead, argv, {
      cwd,
      env,
      input: piped(stdio[0]) ? input : undefined,
      timeout: opts.timeout,
      killSignal: opts.killSignal,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      pass: (fd, data) => {
        const io = stdio[fd];
        if (piped(io)) return false;
        if (io === "inherit") (fd === 1 ? process.stdout : process.stderr).write(data);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof NotIsolatedError) throw e;
    const err = e as ExecError;
    const error: ExecError = Object.assign(new Error(err.message), { errno: err.code === "ENOENT" ? -2 : undefined, code: err.code, syscall: `spawnSync ${file}`, path: file, spawnargs: argv.slice(1) });
    const none = (io: Stdio) => (piped(io) ? text(new Uint8Array(), io) : null);
    return { pid: 0, output: [null, none(stdio[1]), none(stdio[2])], stdout: none(stdio[1]), stderr: none(stdio[2]), status: null, signal: null, error };
  }
  const stdout = text(r.stdout, stdio[1]);
  const stderr = text(r.stderr, stdio[2]);
  const signal = r.status.signal;
  const res: SpawnSyncResult = { pid: r.pid, output: [null, stdout, stderr], stdout, stderr, status: signal ? null : r.status.code, signal };
  const fail = (code: string, errno: number, why: string) =>
    (res.error = Object.assign(new Error(`spawnSync ${argv[0]} ${code}${why}`), { code, errno, syscall: `spawnSync ${argv[0]}`, path: argv[0], spawnargs: argv.slice(1) }));
  if (r.overflow) fail("ENOBUFS", -55, " (stdout or stderr buffer reached maxBuffer size limit)");
  else if (r.timedOut) fail("ETIMEDOUT", -60, "");
  return res;
}

const syncArgs = (args?: readonly string[] | SyncOptions | null, options?: SyncOptions | null): [readonly string[], SyncOptions] =>
  Array.isArray(args) ? [args, options ?? {}] : [[], (args as SyncOptions | null | undefined) ?? options ?? {}];

export function spawnSync(file: string, args?: readonly string[] | SyncOptions | null, options?: SyncOptions | null): SpawnSyncResult {
  const [argv, opts] = syncArgs(args, options);
  return runSync("child_process.spawnSync", "spawn", file, argv, opts, stdioOf(opts.stdio));
}

/** execSync and execFileSync: stdout, or a throw for a child that failed (stderr goes to ours unless `stdio` says). */
function execOf(api: string, instead: string, file: string, args: readonly string[], opts: SyncOptions, cmd: string): string | Buffer | null {
  const stdio = opts.stdio === undefined ? (["pipe", "pipe", "inherit"] as Stdio[]) : stdioOf(opts.stdio);
  const r = runSync(api, instead, file, args, opts, stdio);
  if (r.error) throw Object.assign(r.error, { status: r.status, signal: r.signal, output: r.output, pid: r.pid, stdout: r.stdout, stderr: r.stderr });
  if (r.status !== 0) {
    const msg = `Command failed: ${cmd}${r.stderr?.length ? `\n${String(r.stderr)}` : ""}`;
    throw Object.assign(new Error(msg), { status: r.status, signal: r.signal, output: r.output, pid: r.pid, stdout: r.stdout, stderr: r.stderr });
  }
  return r.stdout;
}

export function execSync(command: string, options?: SyncOptions | null): string | Buffer | null {
  const opts = options ?? {};
  return execOf("child_process.execSync", "exec", command, [], { ...opts, shell: opts.shell || true }, command);
}

export function execFileSync(file: string, args?: readonly string[] | SyncOptions | null, options?: SyncOptions | null): string | Buffer | null {
  const [argv, opts] = syncArgs(args, options);
  return execOf("child_process.execFileSync", "execFile", file, argv, opts, [file, ...argv].join(" "));
}

export default {
  ChildProcess,
  spawn,
  exec,
  execFile,
  fork: unsupported("fork", "it needs an IPC channel to the child; use spawn"),
  spawnSync,
  execSync,
  execFileSync,
  _forkChild: unsupported("_forkChild", "no IPC"),
};
