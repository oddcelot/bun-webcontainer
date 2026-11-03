// A promise's state isn't readable from JS without waiting. The formatters (`console.log`, `util.inspect`) show
// the states recorded here and `<pending>` for the rest.
//
// Only promises the playground's own APIs return are recorded (fetch, Bun.file reads, Bun.write, Bun.sleep,
// fs.promises, timers/promises): `tracked` hands out a promise of its own that settles with the API's, recording
// the outcome just before. Promises the program makes (`new Promise`, `Promise.resolve`, async functions) can't be
// seen without replacing the global `Promise` or patching its prototype's `then`, which programs would observe
// (`p.constructor === Promise`, V8's fast paths), so they print `<pending>`.

type Settled = { state: "resolved" | "rejected"; value: unknown };
const settled = new WeakMap<Promise<unknown>, Settled>();

/** Records how `p` settled (the first record wins: a promise settles once). */
export function trackPromise(p: Promise<unknown>, state: Settled["state"], value?: unknown) {
  if (!settled.has(p)) settled.set(p, { state, value });
}

export const settledPromise = (p: Promise<unknown>): Settled | undefined => settled.get(p);

const then = Promise.prototype.then;

/**
 * A promise that settles as `inner` does (a tick later), with its state recorded. `inner` gets handlers, so only the
 * returned promise's rejection goes unhandled if the program ignores it, as with Bun's.
 */
export function tracked<T>(inner: Promise<T>): Promise<T> {
  const p: Promise<T> = new Promise<T>((resolve, reject) =>
    then.call(
      inner,
      (v) => {
        trackPromise(p, "resolved", v);
        resolve(v as T);
      },
      (e) => {
        trackPromise(p, "rejected", e);
        reject(e);
      },
    ),
  );
  return p;
}

/** A promise fulfilled with `value` now, recorded: for what Bun's APIs settle before returning (`exists()`). */
export function fulfilled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value);
  trackPromise(p, "resolved", value);
  return p;
}

/** `fn` returning `tracked` promises, with its name and length. */
export function trackedFn<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  const wrapper = { [fn.name]: (...args: A) => tracked(fn(...args)) }[fn.name];
  Object.defineProperty(wrapper, "length", { value: fn.length });
  return wrapper;
}
