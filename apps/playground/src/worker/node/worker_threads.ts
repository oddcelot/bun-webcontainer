// node:worker_threads over the process kernel (../processes.ts): a thread is a child worker on the project's files,
// started like a child process, plus a MessageChannel for postMessage. Its stdout and stderr go to this program's.
// On the channel every message is `[kind, value]`: "m" a message, "o" the thread is up, "e" its uncaught error, "x"
// its last word (it ended, so the "exit" event waits for the messages it sent before).
// The Web `Worker` global (../webWorker.ts) runs on the same threads; inside one, `self.postMessage` and `self`'s
// "message" events are the channel too (`setThread`), as `parentPort` is.
// Not here: SHARE_ENV (the thread gets a copy of env), resourceLimits, stdin, receiveMessageOnPort.
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

export type ThreadOptions = {
  argv?: unknown[];
  env?: Record<string, string | undefined> | typeof SHARE_ENV;
  workerData?: unknown;
  transferList?: Transferable[];
  name?: string;
  /** Code to run instead of a file (`eval: true`). */
  eval?: string;
};

/** What a thread reports to the Worker object that started it. */
export type ThreadHooks = {
  message(value: unknown, ports: readonly MessagePort[]): void;
  messageerror(e: MessageEvent): void;
  online(): void;
  error(err: unknown): void;
  /** Its stdout (1) or stderr (2). */
  data(fd: 1 | 2, data: Uint8Array): void;
  /** Once it ended and its last messages are in; `terminated` when `terminate` ended it. */
  exit(code: number, terminated: boolean): void;
};

/**
 * A running thread as both Worker classes drive it (worker_threads' here, the Web `Worker` in ../webWorker.ts): the
 * child, its channel, and when it counts as ended.
 */
export class Thread {
  readonly threadId: number;
  #child: Child;
  #port: MessagePort;
  #hooks: ThreadHooks;
  #status?: number;
  #terminated = false;
  #lastWord = false;
  #exitCode?: number;
  #exited: Promise<number>;
  #settle!: (code: number) => void;
  #holding = true;

  /** `file` is a path (resolved against the working directory) or a `file:` URL; with `eval` it is only a name. */
  constructor(file: string, options: ThreadOptions, hooks: ThreadHooks) {
    this.#hooks = hooks;
    this.threadId = nextThreadId++;
    this.#exited = new Promise((r) => (this.#settle = r));
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    port1.onmessage = (e) => this.#onMessage(e.data as [string, unknown], e.ports);
    port1.onmessageerror = (e) => hooks.messageerror(e);
    const env = !options.env || options.env === SHARE_ENV ? { ...process.env } : { ...options.env };
    const info: ThreadInfo = {
      threadId: this.threadId,
      workerData: options.workerData,
      environmentData: [...environmentData],
      pid: process.pid,
      ppid: process.ppid,
      name: options.name ?? "",
      eval: options.eval,
    };
    const path = options.eval !== undefined ? "[worker eval]" : /^file:/.test(file) ? fileURLToPath(file) : file;
    this.#child = spawnThread(path, (options.argv ?? []).map(String), { cwd: process.cwd(), env: env as Record<string, string> }, port2, info, options.transferList ?? []);
    // The thread, not its child, holds this program: its end can come after the child's (see #end).
    this.#child.unref();
    hold(this);
    this.#child.onData = (fd, data) => hooks.data(fd, data);
    this.#child.onExit = (s) => {
      this.#status = this.#terminated ? 1 : s.code;
      if (this.#terminated || this.#lastWord) this.#end();
      else setTimeout(() => this.#end(), LAST_WORD_TIMEOUT);
    };
  }

  #onMessage([kind, value]: [string, unknown], ports: readonly MessagePort[]) {
    if (kind === "m") this.#hooks.message(value, ports);
    else if (kind === "o") this.#hooks.online();
    else if (kind === "e") this.#hooks.error(value);
    else if (kind === "x") {
      this.#lastWord = true;
      if (this.#status !== undefined) this.#end();
    }
  }

  /** Once the thread ended and its last messages are in. */
  #end() {
    if (this.#exitCode !== undefined) return;
    const code = (this.#exitCode = this.#status ?? 1);
    this.#port.close();
    release(this);
    this.#settle(code);
    this.#hooks.exit(code, this.#terminated);
  }

  postMessage(value: unknown, transfer?: Transfer) {
    if (this.#exitCode !== undefined) return;
    this.#port.postMessage(["m", value], transferOf(transfer));
  }

  /** Stops the thread at once; resolves with its exit code (1). */
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
}

class Worker extends EventEmitter {
  readonly threadId: number;
  readonly stdin = null;
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  readonly resourceLimits = {};
  #thread: Thread;

  constructor(filename: string | URL, options: WorkerOptions = {}) {
    super();
    const code = options.eval ? String(filename) : undefined;
    this.#thread = new Thread(String(filename), { ...options, eval: code }, {
      message: (value) => this.emit("message", value),
      messageerror: (e) => this.emit("messageerror", e),
      online: () => this.emit("online"),
      error: (err) => this.emit("error", err),
      data: (fd, data) => {
        const own = fd === 1 ? options.stdout : options.stderr;
        if (own) (fd === 1 ? this.stdout : this.stderr).push(data);
        else (fd === 1 ? process.stdout : process.stderr).write(data);
      },
      exit: (code) => {
        this.stdout.push(null);
        this.stderr.push(null);
        this.emit("exit", code);
      },
    });
    this.threadId = this.#thread.threadId;
  }

  postMessage(value: unknown, transfer?: Transfer) {
    this.#thread.postMessage(value, transfer);
  }

  /** Stops the thread at once; resolves with its exit code (1, as in Bun and Node). */
  terminate(): Promise<number> {
    return this.#thread.terminate();
  }

  ref() {
    this.#thread.ref();
  }
  unref() {
    this.#thread.unref();
  }
  getHeapSnapshot(): never {
    throw Object.assign(new Error("worker.getHeapSnapshot is not supported in the playground"), { code: "ERR_NOT_SUPPORTED" });
  }
}

/** The channel to the main thread, once this program is a thread (runtime.ts, before its module runs). */
let threadPort: MessagePort | undefined;
/** Where a message from the Worker goes: `parentPort`'s listeners and `self`'s. Set once something listens. */
let started = false;
let parentPortObj: ParentPort | undefined;
let scope: ThreadScope | undefined;

/** Starts taking messages off the channel (until then they wait in it). */
function startPort() {
  if (started || !threadPort) return;
  started = true;
  threadPort.onmessage = (e) => {
    const [kind, value] = e.data as [string, unknown];
    if (kind !== "m") return;
    parentPortObj?.deliver(value);
    scope?.deliver(value, e.ports);
  };
  threadPort.onmessageerror = (e) => {
    parentPortObj?.emit("messageerror", e);
    scope?.target.dispatchEvent(new MessageEvent("messageerror", { data: e.data }));
  };
}

/**
 * The thread's end of the channel. Messages wait in the port until a "message" listener is there (the main thread
 * usually posts before the thread's module ran); listening keeps the thread running until `close` or `unref`, as in
 * Node and Bun.
 */
class ParentPort extends EventEmitter {
  #port: MessagePort;
  #refed = true;
  #closed = false;
  #web = new Map<unknown, (v: unknown) => void>();

  constructor(port: MessagePort) {
    super();
    this.#port = port;
    this.on("newListener", (event: string) => {
      if (event !== "message" || this.#closed) return;
      startPort();
      if (this.#refed) hold(this);
    });
    this.on("removeListener", (event: string) => {
      if (event === "message" && !this.listenerCount("message")) release(this);
    });
  }
  /** @internal A message from the Worker. */
  deliver(value: unknown) {
    if (!this.#closed) this.emit("message", value);
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

type Listener = EventListenerOrEventListenerObject;
type Handler = (e: Event) => unknown;
const call = (fn: Listener, e: Event) => (typeof fn === "function" ? fn.call(globalThis, e) : fn.handleEvent(e));

/**
 * What a thread's own code sees of `self`/`globalThis` (a Web Worker's way to its parent): `postMessage`, `onmessage`,
 * `addEventListener("message" | "messageerror")` and `close()` are the channel to the Worker object, not this worker's
 * channel to the page, which the runtime keeps using (it saved its own references before). A "message" listener keeps
 * the thread running, as in Bun.
 */
class ThreadScope {
  readonly target = new EventTarget();
  #listeners = { message: new Map<Listener, Listener>(), messageerror: new Map<Listener, Listener>() };
  #handlers: { message: Handler | null; messageerror: Handler | null } = { message: null, messageerror: null };

  constructor(port: MessagePort) {
    const g = globalThis as unknown as Record<string, unknown>;
    const add = g.addEventListener as EventTarget["addEventListener"];
    const remove = g.removeEventListener as EventTarget["removeEventListener"];
    const ours = (type: string): type is "message" | "messageerror" => type === "message" || type === "messageerror";
    g.postMessage = (value: unknown, transfer?: Transfer) => port.postMessage(["m", value], transferOf(transfer));
    g.addEventListener = (type: string, fn: Listener | null, opts?: boolean | AddEventListenerOptions) => {
      if (!ours(type)) return add.call(globalThis, type, fn, opts);
      if (!fn || this.#listeners[type].has(fn)) return;
      const once = typeof opts === "object" && opts.once;
      const wrapped: Listener = once ? (e) => (this.#listeners[type].delete(fn), this.#sync(), call(fn, e)) : fn;
      this.#listeners[type].set(fn, wrapped);
      this.target.addEventListener(type, wrapped, opts);
      this.#sync();
    };
    g.removeEventListener = (type: string, fn: Listener | null, opts?: boolean | EventListenerOptions) => {
      if (!ours(type)) return remove.call(globalThis, type, fn, opts);
      const wrapped = fn && this.#listeners[type].get(fn);
      if (!wrapped) return;
      this.#listeners[type].delete(fn);
      this.target.removeEventListener(type, wrapped, opts);
      this.#sync();
    };
    for (const type of ["message", "messageerror"] as const) {
      let registered = false;
      Object.defineProperty(g, `on${type}`, {
        configurable: true,
        get: () => this.#handlers[type],
        set: (fn: unknown) => {
          this.#handlers[type] = typeof fn === "function" ? (fn as Handler) : null;
          // Where it was first set among the listeners, as the Web orders an `on…` handler.
          if (!registered && this.#handlers[type]) {
            registered = true;
            this.target.addEventListener(type, (e) => this.#handlers[type]?.call(globalThis, e));
          }
          this.#sync();
        },
      });
    }
    // Bun 1.4 has no `self.close` in a worker (calling it is a TypeError); the runtime ends the worker by its own copy.
    g.close = undefined;
  }

  /** Listening for messages starts the channel and holds the thread. */
  #sync() {
    if (this.#handlers.message || this.#listeners.message.size) {
      startPort();
      hold(this);
    } else release(this);
  }

  deliver(value: unknown, ports: readonly MessagePort[]) {
    this.target.dispatchEvent(new MessageEvent("message", { data: value, ports: [...ports] }));
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

/**
 * Makes this program a thread: its parentPort, workerData and ids, and its `self` surface (`ThreadScope`), before its
 * module runs.
 */
export function setThread(port: MessagePort, t: ThreadInfo) {
  threadPort = port;
  environmentData = new Map(t.environmentData);
  parentPortObj = new ParentPort(port);
  scope = new ThreadScope(port);
  Object.assign(api, { isMainThread: false, parentPort: parentPortObj, workerData: t.workerData, threadId: t.threadId });
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
