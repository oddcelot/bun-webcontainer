const native = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

class Timeout {
  constructor(readonly id: number) {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  hasRef() {
    return true;
  }
  refresh() {
    return this;
  }
  close() {
    native.clearTimeout(this.id);
    native.clearInterval(this.id);
    return this;
  }
  [Symbol.toPrimitive]() {
    return this.id;
  }
}

type Fn = (...a: unknown[]) => void;
const setTimeout = (fn: Fn, ms?: number, ...args: unknown[]) => new Timeout(native.setTimeout(fn, ms, ...args) as unknown as number);
const setInterval = (fn: Fn, ms?: number, ...args: unknown[]) => new Timeout(native.setInterval(fn, ms, ...args) as unknown as number);
const clear = (t: unknown) => {
  const id = (typeof t === "object" && t !== null ? (t as Timeout).id : t) as number;
  native.clearTimeout(id);
  native.clearInterval(id);
};
const setImmediate = (fn: Fn, ...args: unknown[]) => new Timeout(native.setTimeout(fn, 0, ...args) as unknown as number);

const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });

function sleep<T>(ms?: number, value?: T, opts?: { signal?: AbortSignal }): Promise<T> {
  return new Promise((resolve, reject) => {
    if (opts?.signal?.aborted) return reject(abortError());
    const t = native.setTimeout(() => resolve(value as T), ms);
    opts?.signal?.addEventListener("abort", () => (native.clearTimeout(t), reject(abortError())));
  });
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
