import EventEmitter from "events";

type EE = InstanceType<typeof EventEmitter>;
const E: any = EventEmitter;

/** `events.on(emitter, name)`: an async iterator over emitted events. */
function on(emitter: EE, event: string, opts?: { signal?: AbortSignal }): AsyncIterableIterator<unknown[]> {
  const queue: unknown[][] = [];
  const waiting: { resolve(v: IteratorResult<unknown[]>): void; reject(e: unknown): void }[] = [];
  let error: unknown;
  let done = false;
  const handler = (...args: unknown[]) => {
    const w = waiting.shift();
    if (w) w.resolve({ value: args, done: false });
    else queue.push(args);
  };
  const onError = (err: unknown) => {
    const w = waiting.shift();
    if (w) w.reject(err);
    else error = err;
  };
  const stop = () => {
    done = true;
    emitter.off(event, handler);
    emitter.off("error", onError);
    for (const w of waiting.splice(0)) w.resolve({ value: undefined, done: true });
  };
  emitter.on(event, handler);
  if (event !== "error") emitter.on("error", onError);
  opts?.signal?.addEventListener("abort", () => {
    stop();
    onError(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
  });
  return {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
      if (error) {
        const e = error;
        error = undefined;
        return Promise.reject(e);
      }
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    return() {
      stop();
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncIterableIterator<unknown[]>;
}

function once(emitter: EE, event: string, opts?: { signal?: AbortSignal }): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const onEvent = (...args: unknown[]) => {
      emitter.off("error", onError);
      resolve(args);
    };
    const onError = (err: unknown) => {
      emitter.off(event, onEvent);
      reject(err);
    };
    emitter.once(event, onEvent);
    if (event !== "error") emitter.once("error", onError);
    opts?.signal?.addEventListener("abort", () => {
      emitter.off(event, onEvent);
      emitter.off("error", onError);
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
    });
  });
}

E.EventEmitter = EventEmitter;
E.once = once;
E.on = on;
E.errorMonitor ??= Symbol("events.errorMonitor");
E.captureRejectionSymbol ??= Symbol.for("nodejs.rejection");
E.getEventListeners = (e: EE, name: string) => e.listeners(name);
E.setMaxListeners = (n: number, ...targets: EE[]) => {
  if (!targets.length) EventEmitter.defaultMaxListeners = n;
  for (const t of targets) t.setMaxListeners(n);
};
E.listenerCount = (e: EE, name: string) => e.listenerCount(name);

export default EventEmitter;
