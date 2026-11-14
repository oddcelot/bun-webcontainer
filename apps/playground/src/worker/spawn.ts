// Bun.spawn over the playground's child processes (processes.ts). stdout is piped by default, stderr inherited (it goes
// where this program's stderr goes), stdin ignored; "pipe" gives a ReadableStream (out) or a FileSink (in), and stdin
// also takes data to feed it (a string, bytes, a Blob or BunFile, a Response, a ReadableStream). Bun.spawnSync blocks
// this worker until the child is done, which needs a cross-origin isolated page (processes.ts spawnChildSync).
import { Buffer } from "./node/buffer";
import process, { env as processEnv } from "./node/process";
import { spawnChild, spawnChildSync, type Child, type ExitStatus } from "./processes";

type Io = "pipe" | "inherit" | "ignore" | null | undefined;
type StdinSource = Io | string | ArrayBuffer | ArrayBufferView | Blob | Response | Request | ReadableStream<Uint8Array>;
type Options = {
  cmd?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: StdinSource;
  stdout?: Io;
  stderr?: Io;
  stdio?: [StdinSource, Io, Io];
  argv0?: string;
  signal?: AbortSignal;
  killSignal?: string | number;
  timeout?: number;
  onExit?: (proc: Subprocess, exitCode: number | null, signalCode: string | null, error?: Error) => void;
};

const enc = new TextEncoder();

/** What `stdin: "pipe"` gives: Bun's FileSink (write, flush, end). */
class FileSink {
  constructor(private child: Child) {}
  write(chunk: string | ArrayBuffer | ArrayBufferView): number {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.child.write(bytes);
    return bytes.byteLength;
  }
  flush(): number {
    return 0;
  }
  end(): number {
    this.child.end();
    return 0;
  }
  ref() {}
  unref() {}
}

/** Bytes as they come, into a stream (a pipe), this program's own stdout/stderr (inherit), or nowhere. */
function sink(io: Io, fd: 1 | 2): { stream?: ReadableStream<Uint8Array>; push(data: Uint8Array): void; close(): void } {
  if (io === "pipe") {
    let c!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const stream = new ReadableStream<Uint8Array>({ start: (ctl) => void (c = ctl), cancel: () => void (open = false) });
    // Output after the reader cancelled goes nowhere, as into a closed pipe.
    return { stream, push: (d) => open && c.enqueue(d), close: () => open && ((open = false), c.close()) };
  }
  if (io === "inherit") return { push: (d) => void (fd === 1 ? process.stdout : process.stderr).write(d), close() {} };
  return { push() {}, close() {} };
}

/** Feeds a stdin source into the child, then closes its stdin. */
async function feed(child: Child, src: Exclude<StdinSource, Io>) {
  try {
    if (typeof src === "string") child.write(enc.encode(src));
    else if (src instanceof ArrayBuffer) child.write(new Uint8Array(src));
    else if (ArrayBuffer.isView(src)) child.write(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
    else {
      const stream = src instanceof ReadableStream ? src : src instanceof Blob ? src.stream() : src.body;
      const reader = stream?.getReader();
      for (;;) {
        const r = await reader?.read();
        if (!r || r.done) break;
        child.write(r.value);
      }
    }
  } finally {
    child.end();
  }
}

export class Subprocess {
  readonly pid: number;
  readonly stdin: FileSink | undefined;
  readonly stdout: ReadableStream<Uint8Array> | undefined;
  readonly stderr: ReadableStream<Uint8Array> | undefined;
  /** The exit code; a child a signal ended resolves with 128 + its number, as in Bun. */
  readonly exited: Promise<number>;
  #child: Child;
  constructor(child: Child, stdin: FileSink | undefined, stdout: ReadableStream<Uint8Array> | undefined, stderr: ReadableStream<Uint8Array> | undefined) {
    this.#child = child;
    this.pid = child.pid;
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exited = child.exited.then((s) => s.code);
  }
  get exitCode(): number | null {
    const s = this.#child.status;
    return s && !s.signal ? s.code : null;
  }
  get signalCode(): string | null {
    return this.#child.status?.signal ?? null;
  }
  get killed(): boolean {
    return this.#child.killed;
  }
  kill(signal?: string | number) {
    this.#child.kill(signal);
  }
  ref() {
    this.#child.ref();
  }
  unref() {
    this.#child.unref();
  }
  get readable() {
    return this.stdout;
  }
  resourceUsage() {
    return undefined;
  }
  send() {
    throw new Error("Bun.spawn's ipc isn't supported in the playground");
  }
  disconnect() {}
  async [Symbol.asyncDispose]() {
    if (!this.#child.status) this.kill();
    await this.exited;
  }
}

/** `Bun.spawn(cmd, options)` or `Bun.spawn({ cmd, ...options })`. */
export function spawn(cmdOrOptions: string[] | Options, maybeOptions: Options = {}): Subprocess {
  const opts: Options = Array.isArray(cmdOrOptions) ? { ...maybeOptions, cmd: cmdOrOptions } : (cmdOrOptions ?? {});
  const cmd = opts.cmd?.map(String) ?? [];
  const [stdinOpt, stdoutOpt, stderrOpt] = opts.stdio ?? [opts.stdin, opts.stdout, opts.stderr];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? processEnv)) if (v !== undefined) env[k] = String(v);
  const child = spawnChild(cmd, { cwd: opts.cwd ?? process.cwd(), env });
  const out = sink(stdoutOpt === undefined ? "pipe" : (stdoutOpt as Io), 1);
  const err = sink(stderrOpt === undefined ? "inherit" : (stderrOpt as Io), 2);
  child.onData = (fd, data) => (fd === 1 ? out : err).push(data);
  let stdin: FileSink | undefined;
  if (stdinOpt === "pipe") stdin = new FileSink(child);
  else if (stdinOpt === "inherit" || stdinOpt === "ignore" || stdinOpt === null || stdinOpt === undefined) child.end();
  else void feed(child, stdinOpt);
  const proc = new Subprocess(child, stdin, out.stream, err.stream);
  const timer = opts.timeout ? setTimeout(() => proc.kill(opts.killSignal), opts.timeout) : undefined;
  const abort = () => proc.kill(opts.killSignal);
  opts.signal?.addEventListener("abort", abort, { once: true });
  child.onExit = (s: ExitStatus) => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
    out.close();
    err.close();
    opts.onExit?.(proc, s.signal ? null : s.code, s.signal);
  };
  if (opts.signal?.aborted) abort();
  return proc;
}

type SyncSpawnOptions = Omit<Options, "stdin" | "stdio" | "onExit" | "signal"> & {
  stdin?: Io | string | ArrayBuffer | ArrayBufferView;
  stdio?: [SyncSpawnOptions["stdin"], Io, Io];
  maxBuffer?: number;
};

/**
 * `Bun.spawnSync(cmd, options)` or `Bun.spawnSync({ cmd, ...options })`: waits for the child, then its output as
 * Buffers (stdout and stderr piped by default). Only on a cross-origin isolated page (processes.ts spawnChildSync).
 */
export function spawnSync(cmdOrOptions: string[] | SyncSpawnOptions, maybeOptions: SyncSpawnOptions = {}) {
  const opts: SyncSpawnOptions = Array.isArray(cmdOrOptions) ? { ...maybeOptions, cmd: cmdOrOptions } : (cmdOrOptions ?? {});
  const cmd = opts.cmd?.map(String) ?? [];
  const [stdinOpt, stdoutOpt = "pipe", stderrOpt = "pipe"] = opts.stdio ?? [opts.stdin, opts.stdout, opts.stderr];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? processEnv)) if (v !== undefined) env[k] = String(v);
  const input = typeof stdinOpt === "string" && !["pipe", "inherit", "ignore"].includes(stdinOpt) ? enc.encode(stdinOpt) : stdinOpt instanceof ArrayBuffer ? new Uint8Array(stdinOpt) : ArrayBuffer.isView(stdinOpt) ? new Uint8Array(stdinOpt.buffer, stdinOpt.byteOffset, stdinOpt.byteLength) : undefined;
  const io = [stdoutOpt, stderrOpt];
  const r = spawnChildSync("Bun.spawnSync", "Bun.spawn and await proc.exited", cmd, {
    cwd: opts.cwd ?? process.cwd(),
    env,
    input,
    timeout: opts.timeout,
    killSignal: opts.killSignal,
    maxBuffer: opts.maxBuffer,
    pass: (fd, data) => {
      const how = io[fd - 1];
      if (how === "pipe") return false;
      if (how === "inherit") (fd === 1 ? process.stdout : process.stderr).write(data);
      return true;
    },
  });
  const signalCode = r.status.signal;
  return {
    exitCode: signalCode ? null : r.status.code,
    ...(signalCode && { signalCode }),
    stdout: stdoutOpt === "pipe" ? Buffer.from(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength) : undefined,
    stderr: stderrOpt === "pipe" ? Buffer.from(r.stderr.buffer, r.stderr.byteOffset, r.stderr.byteLength) : undefined,
    success: !signalCode && r.status.code === 0,
    resourceUsage: undefined,
    pid: r.pid,
    ...(r.timedOut && { exitedDueToTimeout: true as const }),
  };
}
