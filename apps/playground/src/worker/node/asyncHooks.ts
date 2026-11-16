// node:async_hooks' AsyncLocalStorage and AsyncResource. The browser has no AsyncContext (Chrome 157 doesn't ship it,
// flag or not), so the context travels the way zone.js's does: every place the playground itself schedules a callback
// (timers, microtasks, `then`, a server's handler) captures the context and runs the callback in it, and `await`, which
// resumes without calling anything of ours, is covered by a source pass over the project's modules that saves the
// context before it and restores it after (src/asyncAwait.ts).
//
// A context is an immutable Map from each storage to its value; `cur` is the one running now. Code that resumes
// without being told one (a microtask nothing wrapped) would otherwise see the last one set, so restoring one
// also queues a single microtask that clears `cur`.

type Ctx = ReadonlyMap<object, unknown> | undefined;
type Fn = (...args: any[]) => any;

let cur: Ctx;
let active = false;
let resetQueued = false;

const native = {
  then: Promise.prototype.then,
  queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
};

/** The context running now. */
export const capture = (): Ctx => cur;

/** `fn` with `this` and `args`, in `ctx`. */
export function runIn<R>(ctx: Ctx, fn: Fn, thisArg: unknown, args: unknown[]): R {
  const prev = cur;
  cur = ctx;
  try {
    return fn.apply(thisArg, args);
  } finally {
    cur = prev;
  }
}

/** `fn`, running in the context of the call to `bindContext`; `this` and arguments pass through. */
export function bindContext<F extends Fn>(fn: F, ctx: Ctx = cur): F {
  if (!active) return fn;
  return function (this: unknown, ...args: unknown[]) {
    return runIn(ctx, fn, this, args);
  } as F;
}

/** What the source pass calls (src/asyncAwait.ts): the context before an `await`... */
const save = (): Ctx => cur;

/** ...and after it: puts `ctx` back and gives `value` through. */
function restore<T>(ctx: Ctx, value: T): T {
  if (!active) return value;
  cur = ctx;
  if (ctx && !resetQueued) {
    resetQueued = true;
    native.queueMicrotask(() => {
      resetQueued = false;
      cur = undefined;
    });
  }
  return value;
}

/** Called once a storage or resource exists: from then on, callbacks the playground schedules carry the context. */
function activate() {
  if (active) return;
  active = true;
  Promise.prototype.then = function then(this: Promise<unknown>, onFulfilled?: unknown, onRejected?: unknown) {
    const ctx = cur;
    return native.then.call(
      this,
      typeof onFulfilled === "function" ? bindContext(onFulfilled as Fn, ctx) : (onFulfilled as undefined),
      typeof onRejected === "function" ? bindContext(onRejected as Fn, ctx) : (onRejected as undefined),
    );
  } as typeof Promise.prototype.then;
  globalThis.queueMicrotask = (fn: () => void) => native.queueMicrotask(bindContext(fn));
}

/** `__alsSave` and `__alsRestore`, which the modules' source pass calls, as globals. */
export function installAsyncContext() {
  Object.assign(globalThis, { __alsSave: save, __alsRestore: restore });
}

class AsyncLocalStorage<T> {
  #disabled = false;
  constructor() {
    activate();
  }
  /** `ctx` with this storage's value set (or removed). */
  #with(store: T | undefined, remove = false): ReadonlyMap<object, unknown> {
    const next = new Map(cur);
    if (remove) next.delete(this);
    else next.set(this, store);
    return next;
  }
  getStore(): T | undefined {
    return this.#disabled ? undefined : (cur?.get(this) as T | undefined);
  }
  run<R, A extends unknown[]>(store: T, fn: (...a: A) => R, ...args: A): R {
    this.#disabled = false;
    return runIn(this.#with(store), fn, undefined, args);
  }
  exit<R, A extends unknown[]>(fn: (...a: A) => R, ...args: A): R {
    return runIn(this.#with(undefined, true), fn, undefined, args);
  }
  enterWith(store: T) {
    this.#disabled = false;
    cur = this.#with(store);
    // The caller's synchronous code and what it schedules see it; whatever resumes unwrapped later doesn't.
    restore(cur, undefined);
  }
  disable() {
    this.#disabled = true;
  }
  static bind<F extends Fn>(fn: F): F {
    return AsyncResource.bind(fn);
  }
  static snapshot() {
    const resource = new AsyncResource("AsyncLocalStorage");
    return <R, A extends unknown[]>(fn: (...a: A) => R, ...args: A): R => resource.runInAsyncScope(fn, undefined, ...args);
  }
}

let ids = 1;

class AsyncResource {
  #ctx: Ctx;
  #id = ++ids;
  constructor(readonly type: string, _opts?: unknown) {
    if (typeof type !== "string") throw Object.assign(new TypeError(`The "type" argument must be of type string. Received ${type === undefined ? "undefined" : typeof type}`), { code: "ERR_INVALID_ARG_TYPE" });
    activate();
    this.#ctx = cur;
  }
  runInAsyncScope<R>(fn: (...a: any[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return runIn(this.#ctx, fn, thisArg, args);
  }
  emitDestroy() {
    return this;
  }
  asyncId() {
    return this.#id;
  }
  triggerAsyncId() {
    return 0;
  }
  bind<F extends Fn>(fn: F, thisArg?: unknown): F {
    if (typeof fn !== "function") throw Object.assign(new TypeError(`The "fn" argument must be of type function. Received ${fn === undefined ? "undefined" : typeof fn}`), { code: "ERR_INVALID_ARG_TYPE" });
    const resource = this;
    const bound = function (this: unknown, ...args: unknown[]) {
      return resource.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args);
    };
    Object.defineProperties(bound, { length: { value: fn.length, configurable: true }, asyncResource: { value: this, configurable: true, enumerable: true, writable: true } });
    return bound as unknown as F;
  }
  static bind<F extends Fn>(fn: F, type?: string, thisArg?: unknown): F {
    return new AsyncResource(type || fn.name || "bound-anonymous-fn").bind(fn, thisArg);
  }
}

export const async_hooks = {
  AsyncLocalStorage,
  AsyncResource,
  createHook: () => ({ enable() {}, disable() {} }),
  executionAsyncId: () => 1,
  triggerAsyncId: () => 0,
  executionAsyncResource: () => ({}),
};
