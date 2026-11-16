import { hold, held, release } from "../loop";
import { tracked } from "../promises";
import { bindContext } from "./asyncHooks";

const native = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

type Fn = (...a: unknown[]) => void;

/** Live timers by id, so `clearTimeout(id)` with the number (`+timeout`) lets go of the program too. */
const live = new Map<number, Timeout>();

/** A Node timer: it holds the program (loop.ts) until it fires (an interval, until cleared), unless `unref`'d. */
class Timeout {
  id = 0;
  #refed = true;
  constructor(
    private fn: Fn,
    private ms: number | undefined,
    private args: unknown[],
    private repeat: boolean,
  ) {
    this.#start();
  }
  /** A timer runs in the context that set it (also after `refresh`). */
  #bound: Fn | undefined;
  #start() {
    const { args } = this;
    const fn = (this.#bound ??= bindContext(this.fn));
    const run = () => {
      if (!this.repeat) this.#end();
      // Called as a plain function, so an error's stack doesn't show it as a Timeout method.
      fn(...args);
    };
    this.id = (this.repeat ? native.setInterval(run, this.ms) : native.setTimeout(run, this.ms)) as unknown as number;
    live.set(this.id, this);
    if (this.#refed) hold(this);
  }
  #end() {
    live.delete(this.id);
    release(this);
  }
  ref() {
    this.#refed = true;
    if (live.get(this.id) === this) hold(this);
    return this;
  }
  unref() {
    this.#refed = false;
    release(this);
    return this;
  }
  hasRef() {
    return held(this);
  }
  refresh() {
    if (live.get(this.id) !== this) return this;
    this.close();
    this.#start();
    return this;
  }
  close() {
    native.clearTimeout(this.id);
    native.clearInterval(this.id);
    this.#end();
    return this;
  }
  [Symbol.toPrimitive]() {
    return this.id;
  }
}

const setTimeout = (fn: Fn, ms?: number, ...args: unknown[]) => new Timeout(fn, ms, args, false);
const setInterval = (fn: Fn, ms?: number, ...args: unknown[]) => new Timeout(fn, ms, args, true);
const clear = (t: unknown) => {
  if (t instanceof Timeout) return void t.close();
  const id = Number(t);
  const timer = live.get(id);
  if (timer) return void timer.close();
  native.clearTimeout(id);
  native.clearInterval(id);
};
const setImmediate = (fn: Fn, ...args: unknown[]) => new Timeout(fn, 0, args, false);

const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });

/** Its promise shows its state in console.log once settled (promises.ts). */
function sleep<T>(ms?: number, value?: T, opts?: { signal?: AbortSignal }): Promise<T> {
  return tracked(new Promise((resolve, reject) => {
    if (opts?.signal?.aborted) return reject(abortError());
    const t = native.setTimeout(() => resolve(value as T), ms);
    opts?.signal?.addEventListener("abort", () => (native.clearTimeout(t), reject(abortError())));
  }));
}

export const promises = {
  setTimeout: sleep,
  setImmediate: <T>(value?: T, opts?: { signal?: AbortSignal }) => sleep(0, value, opts),
  async *setInterval<T>(ms?: number, value?: T, opts?: { signal?: AbortSignal }) {
    for (;;) yield await sleep(ms, value, opts);
  },
  scheduler: { wait: (ms: number, opts?: { signal?: AbortSignal }) => sleep(ms, undefined, opts), yield: () => sleep(0) },
};

/** Node's timers as globals: timeouts are objects with ref/unref, and setImmediate exists. */
export function installTimers() {
  Object.assign(globalThis, { setTimeout, setInterval, setImmediate, clearTimeout: clear, clearInterval: clear, clearImmediate: clear });
}

export default { setTimeout, clearTimeout: clear, setInterval, clearInterval: clear, setImmediate, clearImmediate: clear, promises };
