// node:worker_threads over the process kernel (../processes.ts): a thread is a child worker on the project's files,
// started like a child process, plus a MessageChannel for postMessage. Its stdout and stderr go to this program's.
// On the channel every message is `[kind, value]`: "m" a message, "o" the thread is up, "e" its uncaught error, "x"
// its last word (it ended, so the "exit" event waits for the messages it sent before).
// Not here: SHARE_ENV (the thread gets a copy of env), resourceLimits, stdin, receiveMessageOnPort, and the Web
// `new Worker(url)` global (still the browser's own).
import EventEmitter from "events";
import process from "./process";
import { Readable } from "./stream";
import { fileURLToPath } from "./url";
import { spawnThread, type Child } from "../processes";
import { hold, release } from "../loop";

const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
/** How long a thread that ended by itself gets for its last messages to arrive before "exit" fires anyway. */
const LAST_WORD_TIMEOUT = 200;

type Transfer = readonly Transferable[] | { transfer?: readonly Transferable[] } | undefined;
const transferOf = (t: Transfer): Transferable[] => [...((Array.isArray(t) ? t : (t as { transfer?: Transferable[] } | undefined)?.transfer) ?? [])];

type WorkerOptions = {
  argv?: unknown[];
  env?: Record<string, string | undefined> | typeof SHARE_ENV;
  eval?: boolean;
  workerData?: unknown;
  transferList?: Transferable[];
  stdout?: boolean;
  stderr?: boolean;
  name?: string;
  execArgv?: string[];
  resourceLimits?: object;
};

/** What a thread is told as it starts (runtime.ts gives it to `setThread`). */
export type ThreadInfo = { threadId: number; workerData: unknown; environmentData: [unknown, unknown][]; pid: number; ppid: number; name: string; eval?: string };

let environmentData = new Map<unknown, unknown>();
let nextThreadId = 1;

class Worker extends EventEmitter {
  readonly threadId: number;
  readonly stdin = null;
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  readonly resourceLimits = {};
  #child: Child;
  #port: MessagePort;
  #status?: number;
  #terminated = false;
  #lastWord = false;
  #exitCode?: number;
  #exited: Promise<number>;
  #settle!: (code: number) => void;
  #holding = true;

  constructor(filename: string | URL, options: WorkerOptions = {}) {
    super();
    const code = options.eval ? String(filename) : undefined;
    const file = code !== undefined ? "[worker eval]" : filename instanceof URL || /^file:/.test(String(filename)) ? fileURLToPath(filename) : String(filename);
    this.threadId = nextThreadId++;
    this.#exited = new Promise((r) => (this.#settle = r));
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    port1.onmessage = (e) => this.#onMessage(e.data as [string, unknown]);
    port1.onmessageerror = (e) => this.emit("messageerror", e);
    const env = !options.env || options.env === SHARE_ENV ? { ...process.env } : { ...options.env };
    const info: ThreadInfo = {
      threadId: this.threadId,
      workerData: options.workerData,
      environmentData: [...environmentData],
      pid: process.pid,
      ppid: process.ppid,
      name: options.name ?? "",
      eval: code,
    };
    this.#child = spawnThread(file, (options.argv ?? []).map(String), { cwd: process.cwd(), env: env as Record<string, string> }, port2, info, options.transferList ?? []);
    // The Worker, not its child, holds this program: its "exit" can come after the child's end (see #end).
    this.#child.unref();
    hold(this);
    this.#child.onData = (fd, data) => {
      const own = fd === 1 ? options.stdout : options.stderr;
      if (own) (fd === 1 ? this.stdout : this.stderr).push(data);
      else (fd === 1 ? process.stdout : process.stderr).write(data);
    };
    this.#child.onExit = (s) => {
      this.#status = this.#terminated ? 1 : s.code;
      if (this.#terminated || this.#lastWord) this.#end();
      else setTimeout(() => this.#end(), LAST_WORD_TIMEOUT);
    };
  }

  #onMessage([kind, value]: [string, unknown]) {
    if (kind === "m") this.emit("message", value);
    else if (kind === "o") this.emit("online");
    else if (kind === "e") this.emit("error", value);
    else if (kind === "x") {
      this.#lastWord = true;
      if (this.#status !== undefined) this.#end();
    }
  }

  /** Once the thread ended and its last messages are in: "exit". */
  #end() {
    if (this.#exitCode !== undefined) return;
    const code = (this.#exitCode = this.#status ?? 1);
    this.#port.close();
    this.stdout.push(null);
    this.stderr.push(null);
    release(this);
    this.#settle(code);
    this.emit("exit", code);
  }

  postMessage(value: unknown, transfer?: Transfer) {
    if (this.#exitCode !== undefined) return;
    this.#port.postMessage(["m", value], transferOf(transfer));
  }

  /** Stops the thread at once; resolves with its exit code (1, as in Bun and Node). */
  terminate(): Promise<number> {
    if (this.#exitCode === undefined && this.#status === undefined) {
      this.#terminated = true;
      this.#child.kill("SIGKILL");
    }
    return this.#exited;
  }

  ref() {
    if (!this.#holding && this.#exitCode === undefined) hold(this);
    this.#holding = true;
  }
  unref() {
    this.#holding = false;
    release(this);
  }
  getHeapSnapshot(): never {
    throw Object.assign(new Error("worker.getHeapSnapshot is not supported in the playground"), { code: "ERR_NOT_SUPPORTED" });
  }
}

/**
 * The thread's end of the channel. Messages wait in the port until a "message" listener is there (the main thread
 * usually posts before the thread's module ran); listening keeps the thread running until `close` or `unref`, as in
 * Node and Bun.
 */
class ParentPort extends EventEmitter {
  #port: MessagePort;
  #started = false;
  #refed = true;
  #closed = false;
  #web = new Map<unknown, (v: unknown) => void>();

  constructor(port: MessagePort) {
    super();
    this.#port = port;
    this.on("newListener", (event: string) => {
      if (event !== "message" || this.#closed) return;
      if (!this.#started) {
        this.#started = true;
        port.onmessage = (e) => {
          const [kind, value] = e.data as [string, unknown];
          if (kind === "m") this.emit("message", value);
        };
        port.onmessageerror = (e) => this.emit("messageerror", e);
      }
      if (this.#refed) hold(this);
    });
    this.on("removeListener", (event: string) => {
      if (event === "message" && !this.listenerCount("message")) release(this);
    });
  }
  postMessage(value: unknown, transfer?: Transfer) {
    if (!this.#closed) this.#port.postMessage(["m", value], transferOf(transfer));
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    release(this);
    this.emit("close");
  }
  start() {}
  ref() {
    this.#refed = true;
    if (this.listenerCount("message") && !this.#closed) hold(this);
  }
  unref() {
    this.#refed = false;
    release(this);
  }
  hasRef() {
    return this.#refed && this.listenerCount("message") > 0 && !this.#closed;
  }
  /** The MessagePort side some code uses: `addEventListener("message", (e) => e.data)`. */
  addEventListener(type: string, fn: (e: { data: unknown }) => void) {
    const wrapped = (v: unknown) => fn(type === "message" ? { data: v } : (v as { data: unknown }));
    this.#web.set(fn, wrapped);
    this.on(type, wrapped);
  }
  removeEventListener(type: string, fn: unknown) {
    const wrapped = this.#web.get(fn);
    if (wrapped) this.off(type, wrapped);
    this.#web.delete(fn);
  }
  set onmessage(fn: ((e: { data: unknown }) => void) | null) {
    this.removeAllListeners("message");
    if (fn) this.addEventListener("message", fn);
  }
}

const api = {
  isMainThread: true,
  parentPort: null as ParentPort | null,
  workerData: null as unknown,
  threadId: 0,
  resourceLimits: {},
  SHARE_ENV,
  Worker,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  receiveMessageOnPort: () => undefined,
  markAsUntransferable() {},
  isMarkedAsUntransferable: () => false,
  moveMessagePortToContext: (port: MessagePort) => port,
  setEnvironmentData(key: unknown, value: unknown) {
    if (value === undefined) environmentData.delete(key);
    else environmentData.set(key, value);
  },
  getEnvironmentData: (key: unknown) => environmentData.get(key),
};

/** The channel to the main thread, once this program is a thread (runtime.ts, before its module runs). */
let threadPort: MessagePort | undefined;

/** Makes this program a thread: its parentPort, workerData and ids, before its module runs. */
export function setThread(port: MessagePort, t: ThreadInfo) {
  threadPort = port;
  environmentData = new Map(t.environmentData);
  Object.assign(api, { isMainThread: false, parentPort: new ParentPort(port), workerData: t.workerData, threadId: t.threadId });
  port.postMessage(["o", undefined]);
}

/** An uncaught error in a thread goes to the Worker's "error" event instead of the console; false outside a thread. */
export function threadError(err: unknown): boolean {
  if (!threadPort) return false;
  try {
    threadPort.postMessage(["e", err]);
  } catch {
    // Not cloneable (it holds a function, say): its name, message and stack.
    const e = err as { name?: string; message?: string; stack?: string } | null;
    threadPort.postMessage(["e", Object.assign(new Error(String(e?.message ?? err)), { name: e?.name ?? "Error", stack: e?.stack })]);
  }
  return true;
}

/** The thread ends: its last word, after every message it sent. */
export function threadEnd() {
  threadPort?.postMessage(["x", undefined]);
}

export default api;
