// node:inspector as far as a browser tab can take it: a Session connects and answers `post` as Bun's does for the
// domains that need no profiler or debugger (`Runtime.enable`, `Profiler.enable` and their `disable`), and with
// Bun's "wasn't found" error for the rest. There is no inspector to open: `url()` is undefined, as in Bun before
// `open()`, and `open()` throws.
import EventEmitter from "events";
import { codeError } from "./errors";

type Callback = (err: Error | null, result?: unknown) => void;

const commandError = (message: string) => codeError(Error, "ERR_INSPECTOR_COMMAND", `Inspector error ${message}`);

const ANSWERS: Record<string, true> = { "Runtime.enable": true, "Runtime.disable": true, "Profiler.enable": true, "Profiler.disable": true, "NodeWorker.disable": true, "NodeWorker.detach": true };

export class Session extends EventEmitter {
  #connected = false;
  #profiler = false;
  connect() {
    if (this.#connected) throw codeError(Error, "ERR_INSPECTOR_ALREADY_CONNECTED", "The inspector session is already connected");
    this.#connected = true;
  }
  connectToMainThread() {
    this.connect();
  }
  disconnect() {
    this.#connected = false;
  }
  #answer(method: string): unknown {
    if (method === "Profiler.enable" || method === "Profiler.disable") this.#profiler = method === "Profiler.enable";
    if (ANSWERS[method]) return {};
    if (method.startsWith("Profiler.") && !this.#profiler) return commandError("-32000: Profiler is not enabled");
    if (method.startsWith("Profiler.") || method.startsWith("HeapProfiler.")) return commandError(`-32000: ${method} is not supported in the playground`);
    return commandError(`-32601: '${method}' wasn't found`);
  }
  post(method: string, params?: object | Callback, callback?: Callback) {
    if (typeof method !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "method" argument must be of type string.`);
    if (callback === undefined && typeof params === "function") (callback = params as Callback), (params = undefined);
    if (params !== undefined && params !== null && typeof params !== "object") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "params" argument must be of type object.`);
    if (callback !== undefined && typeof callback !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "callback" argument must be of type function.`);
    if (!this.#connected) {
      const error = codeError(Error, "ERR_INSPECTOR_NOT_CONNECTED", "Session is not connected");
      if (callback) return void queueMicrotask(() => callback(error));
      throw error;
    }
    const result = this.#answer(method);
    if (callback) return void queueMicrotask(() => (result instanceof Error ? callback(result, undefined) : callback(null, result)));
    if (result instanceof Error) throw result;
    return result;
  }
}

/** node:inspector/promises: `post` returns a promise. */
class PromiseSession extends Session {
  override post(method: string, params?: object): Promise<unknown> {
    return new Promise((resolve, reject) => super.post(method, params, (err, result) => (err ? reject(err) : resolve(result))));
  }
}

const console = { ...globalThis.console, context: { console: globalThis.console } };

const inspector = {
  console,
  open() {
    throw new Error("node:inspector.open is not supported in the playground: there is no debugger to connect to");
  },
  close() {},
  url: (): string | undefined => undefined,
  waitForDebugger() {
    throw codeError(Error, "ERR_INSPECTOR_NOT_ACTIVE", "Inspector is not active");
  },
  Session,
};

export const inspectorPromises = { ...inspector, Session: PromiseSession };

export default inspector;
