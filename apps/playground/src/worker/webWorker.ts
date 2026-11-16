// The Web `Worker` global as Bun has it, on worker_threads' threads (node/worker_threads.ts `Thread`): a file of the
// project (a `file:` URL, or a path relative to the working directory, as Bun resolves it) runs in a thread whose
// `self.postMessage`/`onmessage` talk to this object. Events as in Bun: "open" once it runs, "message", "error" for
// its uncaught error (an ErrorEvent; it isn't printed), then "close" (a CloseEvent with its exit code; 0 after
// `terminate()`). The options Bun adds: `argv`, `env`, `workerData`, `ref`; `smol` and `preload` are ignored here.
import { Thread } from "./node/worker_threads";
import process from "./node/process";

type Options = {
  name?: string;
  type?: "classic" | "module";
  argv?: unknown[];
  env?: Record<string, string | undefined>;
  workerData?: unknown;
  ref?: boolean;
  smol?: boolean;
  preload?: string | string[];
};
type Transfer = Transferable[] | StructuredSerializeOptions;
type HandlerType = "message" | "error" | "messageerror";
type Handler = ((this: WebWorker, e: Event) => unknown) | null;

// The browser's Worker, before the runtime puts this class in its place (runtime.ts imports this module first).
const NativeWorker = globalThis.Worker;
/** Paths (on this origin) of the workers that host packages start (hostPackages.ts): the browser's own runs them. */
const hostWorkers = new Set<string>();
export function allowHostWorker(url: URL) {
  hostWorkers.add(url.pathname);
}

/** `new CloseEvent` where there is one, an Event with its fields otherwise. */
const closeEvent = (code: number) => {
  const init = { code, reason: code === 0 ? "Worker terminated normally" : "Worker exited abnormally", wasClean: code === 0 };
  return typeof CloseEvent === "function" ? new CloseEvent("close", init) : Object.assign(new Event("close"), init);
};

const errorText = (err: unknown) => {
  const e = err as { name?: string; message?: string } | null;
  return e && typeof e === "object" && "message" in e ? `${e.name ?? "Error"}: ${e.message}` : String(err);
};

export class WebWorker extends EventTarget {
  // Set unless the constructor hands back the browser's Worker (allowHostWorker).
  readonly threadId!: number;
  #thread!: Thread;
  #handlers: Record<HandlerType, Handler> = { message: null, error: null, messageerror: null };
  #registered = new Set<HandlerType>();

  constructor(url: string | URL, options: Options = {}) {
    super();
    const href = String(url);
    // A host package's worker (rolldown's WASI threads): the playground's own file, not the project's. Only the
    // listed paths of this origin: a project can't run any other URL this way.
    if (NativeWorker && /^https?:/i.test(href)) {
      const u = new URL(href);
      if (u.origin === location.origin && hostWorkers.has(u.pathname)) return new NativeWorker(u, options) as unknown as WebWorker;
    }
    if (/^[a-z][a-z\d+.-]+:/i.test(href) && !/^file:/i.test(href)) throw new TypeError(`Worker: only the project's files can run in a Worker here, not ${href.slice(0, 60)}`);
    this.#thread = new Thread(href, { argv: options.argv, env: options.env, workerData: options.workerData, name: options.name }, {
      message: (data, ports) => this.dispatchEvent(new MessageEvent("message", { data, ports: [...ports] })),
      messageerror: (e) => this.dispatchEvent(new MessageEvent("messageerror", { data: e.data })),
      online: () => this.dispatchEvent(new Event("open")),
      error: (error) => this.dispatchEvent(new ErrorEvent("error", { message: errorText(error), error: null })),
      data: (fd, data) => (fd === 1 ? process.stdout : process.stderr).write(data),
      exit: (code, terminated) => this.dispatchEvent(closeEvent(terminated ? 0 : code)),
    });
    this.threadId = this.#thread.threadId;
    if (options.ref === false) this.#thread.unref();
  }

  postMessage(value: unknown, transfer?: Transfer) {
    this.#thread.postMessage(value, transfer as Parameters<Thread["postMessage"]>[1]);
  }
  /** Stops the thread; its "close" event follows (code 0). Returns nothing, as in Bun. */
  terminate() {
    void this.#thread.terminate();
  }
  ref() {
    this.#thread.ref();
  }
  unref() {
    this.#thread.unref();
  }

  /** An `on…` handler: a listener from where it was first set, as the Web orders it. */
  #setHandler(type: HandlerType, fn: Handler) {
    const first = !this.#registered.has(type);
    this.#handlers[type] = typeof fn === "function" ? fn : null;
    if (first && this.#handlers[type]) {
      this.#registered.add(type);
      this.addEventListener(type, (e) => this.#handlers[type]?.call(this, e));
    }
  }
  get onmessage() {
    return this.#handlers.message;
  }
  set onmessage(fn: Handler) {
    this.#setHandler("message", fn);
  }
  get onerror() {
    return this.#handlers.error;
  }
  set onerror(fn: Handler) {
    this.#setHandler("error", fn);
  }
  get onmessageerror() {
    return this.#handlers.messageerror;
  }
  set onmessageerror(fn: Handler) {
    this.#setHandler("messageerror", fn);
  }
}
