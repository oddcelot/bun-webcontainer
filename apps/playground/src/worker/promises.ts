// A promise's state isn't readable from JS without waiting. The formatters (`console.log`, `util.inspect`) show
// the states recorded here and `<pending>` for the rest.
//
// trackPromises() records what can be known without changing what programs observe:
// - `new Promise(executor)`: the executor gets resolve/reject wrappers, so a promise settled by the executor (or
//   later through them) is known. A resolve with a thenable stays pending (adoption isn't observable without a
//   handler, and adding one would mark a rejection handled).
// - `Promise.resolve(value)`, `Promise.reject(reason)`, `Promise.withResolvers()`.
// - any promise once something calls its `.then` (also `.catch`, `.finally`): a reaction that records the
//   outcome runs just before the caller's own. Reactions are pure and FIFO, so other callbacks keep their order.
// Not known: async functions' results and promises from builtins (fetch, combinators) nobody called `.then` on;
// `await` reads the state natively. `Promise` is a Proxy of the intrinsic after this, so `p.constructor ===
// Promise` is false (`instanceof Promise` still holds).

type Settled = { state: "resolved" | "rejected"; value: unknown };
const settled = new WeakMap<Promise<unknown>, Settled>();

/** Records how `p` settled (the first record wins: a promise settles once). */
export function trackPromise(p: Promise<unknown>, state: Settled["state"], value?: unknown) {
  if (!settled.has(p)) settled.set(p, { state, value });
}

export const settledPromise = (p: Promise<unknown>): Settled | undefined => settled.get(p);

const Intrinsic = Promise;

/** `value` has no `then` anywhere on its chain (found without calling getters), so resolving with it fulfills. */
function plainValue(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return true;
  try {
    for (let o: object | null = value as object, n = 0; o && n < 100; o = Object.getPrototypeOf(o), n++) {
      const d = Object.getOwnPropertyDescriptor(o, "then");
      if (d) return "value" in d && typeof d.value !== "function";
    }
    return true;
  } catch {
    return false;
  }
}

/** Resolve/reject functions that record the first call on the promise `target()` returns (once it exists). */
function recorders(target: () => Promise<unknown> | undefined, resolve: (v: unknown) => void, reject: (e: unknown) => void) {
  let done = false;
  let pending: [Settled["state"], unknown] | undefined;
  const settle = (state: Settled["state"], value: unknown) => {
    if (done) return;
    done = true;
    const p = target();
    if (p) trackPromise(p, state, value);
    else pending = [state, value];
  };
  return {
    resolve: (v: unknown) => {
      if (plainValue(v)) settle("resolved", v);
      else done = true;
      resolve(v);
    },
    reject: (e: unknown) => {
      settle("rejected", e);
      reject(e);
    },
    flush: (p: Promise<unknown>) => {
      if (pending) trackPromise(p, ...pending);
    },
  };
}

let installed = false;

/** Installs the hooks described at the top of this file on the worker's global `Promise`. */
export function trackPromises(g: { Promise: PromiseConstructor }) {
  if (installed) return;
  installed = true;
  const proto = Intrinsic.prototype;
  const then = proto.then;
  const observed = new WeakSet<object>();

  const PromiseProxy: PromiseConstructor = new Proxy(Intrinsic, {
    construct(target, args, newTarget) {
      const executor = args[0];
      if (typeof executor !== "function") return Reflect.construct(target, args, newTarget === PromiseProxy ? target : newTarget);
      let p: Promise<unknown> | undefined;
      let rec: ReturnType<typeof recorders> | undefined;
      p = Reflect.construct(
        target,
        [
          (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            rec = recorders(() => p, resolve, reject);
            try {
              executor(rec.resolve, rec.reject);
            } catch (e) {
              rec.reject(e);
            }
          },
        ],
        newTarget === PromiseProxy ? target : newTarget,
      ) as Promise<unknown>;
      rec?.flush(p);
      return p;
    },
  });

  const self = (c: unknown) => (c === PromiseProxy ? Intrinsic : c) as PromiseConstructor;
  const resolve = Intrinsic.resolve;
  const reject = Intrinsic.reject;
  const define = (name: string, fn: Function) => Object.defineProperty(Intrinsic, name, { value: fn, writable: true, configurable: true, enumerable: false });
  define("resolve", {
    resolve(this: unknown, v: unknown) {
      const C = self(this);
      const p = resolve.call(C, v);
      if (p !== v && plainValue(v)) trackPromise(p, "resolved", v);
      return p;
    },
  }.resolve);
  define("reject", {
    reject(this: unknown, e: unknown) {
      const p = reject.call(self(this), e);
      trackPromise(p, "rejected", e);
      return p;
    },
  }.reject);
  const withResolvers = (Intrinsic as { withResolvers?: Function }).withResolvers;
  if (withResolvers)
    define("withResolvers", {
      withResolvers(this: unknown) {
        const r = withResolvers.call(self(this)) as { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
        const rec = recorders(() => r.promise, r.resolve, r.reject);
        return { promise: r.promise, resolve: rec.resolve, reject: rec.reject };
      },
    }.withResolvers);

  // A reaction that records the outcome, added before the caller's. Only plain promises: on a subclass instance,
  // `then` would construct a derived promise through the subclass (its constructor is user code).
  Object.defineProperty(proto, "then", {
    value: {
      then(this: Promise<unknown>, onFulfilled?: unknown, onRejected?: unknown) {
        if (typeof this === "object" && this !== null && !observed.has(this) && Object.getPrototypeOf(this) === proto && !Object.prototype.hasOwnProperty.call(this, "constructor")) {
          observed.add(this);
          const p = this;
          try {
            then.call(p, (v) => trackPromise(p, "resolved", v), (e) => trackPromise(p, "rejected", e));
          } catch {}
        }
        return then.call(this, onFulfilled as never, onRejected as never);
      },
    }.then,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  g.Promise = PromiseProxy;
}
