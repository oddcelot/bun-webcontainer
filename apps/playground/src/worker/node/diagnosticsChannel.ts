// node:diagnostics_channel, after Bun's port of Node's lib/diagnostics_channel.js (bun/src/js/node/diagnostics_channel.ts):
// a channel switches its prototype to ActiveChannel while it has subscribers or bound stores, and channels are held
// weakly by name, so `channel(name)` gives the same object back as long as anyone holds it.
import { codeError } from "./errors";
import process from "./process";

type Fn = (...args: any[]) => any;
type Store = { run<R>(store: unknown, fn: () => R): R };
type Transform = (data: unknown) => unknown;

const received = (v: unknown) =>
  v === null ? " Received null" : v === undefined ? " Received undefined" : typeof v === "function" ? ` Received function ${v.name}` : typeof v === "object" ? ` Received an instance of ${(v as object).constructor?.name ?? "Object"}` : ` Received type ${typeof v} (${String(v)})`;

function validateFunction(v: unknown, name: string): asserts v is Fn {
  if (typeof v !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type function.${received(v)}`);
}

/** An error out of a subscriber doesn't stop the publisher: it is reported as uncaught on the next tick. */
const report = (err: unknown) => process.nextTick(() => globalThis.reportError(err));

class WeakReference<T extends object> extends WeakRef<T> {
  #refs = 0;
  incRef() {
    return ++this.#refs;
  }
  decRef() {
    return --this.#refs;
  }
}

class WeakRefMap<K, V extends object> extends Map<K, WeakReference<V>> {
  #finalizers = new FinalizationRegistry<K>((key) => this.delete(key));
  // @ts-expect-error: stores the value weakly
  override set(key: K, value: V) {
    this.#finalizers.register(value, key);
    return super.set(key, new WeakReference(value));
  }
  // @ts-expect-error: gives the value back
  override get(key: K): V | undefined {
    return super.get(key)?.deref();
  }
  incRef(key: K) {
    return super.get(key)?.incRef();
  }
  decRef(key: K) {
    return super.get(key)?.decRef();
  }
}

const channels = new WeakRefMap<string | symbol, Channel>();

interface Active {
  _subscribers: Fn[];
  _stores: Map<Store, Transform | undefined>;
}

function markActive(channel: Channel) {
  Object.setPrototypeOf(channel, ActiveChannel.prototype);
  channel._subscribers = [];
  channel._stores = new Map();
}

function maybeMarkInactive(channel: Channel) {
  if (!channel._subscribers!.length && !channel._stores!.size) {
    Object.setPrototypeOf(channel, Channel.prototype);
    channel._subscribers = undefined;
    channel._stores = undefined;
  }
}

function wrapStoreRun(store: Store, data: unknown, next: () => unknown, transform: Transform = (d) => d) {
  return () => {
    let context;
    try {
      context = transform(data);
    } catch (err) {
      report(err);
      return next();
    }
    return store.run(context, next);
  };
}

class ActiveChannel {
  declare _subscribers: Fn[];
  declare _stores: Map<Store, Transform | undefined>;
  declare name: string | symbol;

  subscribe(subscription: Fn) {
    validateFunction(subscription, "subscription");
    this._subscribers = [...this._subscribers, subscription];
    channels.incRef(this.name);
  }

  unsubscribe(subscription: Fn) {
    const index = this._subscribers.indexOf(subscription);
    if (index === -1) return false;
    const subscribers = this._subscribers.slice();
    subscribers.splice(index, 1);
    this._subscribers = subscribers;
    channels.decRef(this.name);
    maybeMarkInactive(this as unknown as Channel);
    return true;
  }

  bindStore(store: Store, transform?: Transform) {
    if (!this._stores.has(store)) channels.incRef(this.name);
    this._stores.set(store, transform);
  }

  unbindStore(store: Store) {
    if (!this._stores.has(store)) return false;
    this._stores.delete(store);
    channels.decRef(this.name);
    maybeMarkInactive(this as unknown as Channel);
    return true;
  }

  get hasSubscribers() {
    return true;
  }

  publish(data?: unknown) {
    const subscribers = this._subscribers;
    for (let i = 0; i < (subscribers?.length || 0); i++) {
      try {
        subscribers[i](data, this.name);
      } catch (err) {
        report(err);
      }
    }
  }

  runStores(data: unknown, fn: Fn, thisArg?: unknown, ...args: unknown[]) {
    let run = () => {
      this.publish(data);
      return fn.apply(thisArg, args);
    };
    for (const [store, transform] of this._stores) run = wrapStoreRun(store, data, run, transform);
    return run();
  }
}

class Channel {
  _subscribers: Active["_subscribers"] | undefined;
  _stores: Active["_stores"] | undefined;
  name: string | symbol;

  constructor(name: string | symbol) {
    this._subscribers = undefined;
    this._stores = undefined;
    this.name = name;
    channels.set(name, this);
  }

  static [Symbol.hasInstance](instance: unknown) {
    const prototype = instance === null || instance === undefined ? null : Object.getPrototypeOf(instance);
    return prototype === Channel.prototype || prototype === ActiveChannel.prototype;
  }

  subscribe(subscription: Fn) {
    markActive(this);
    this.subscribe(subscription);
  }

  unsubscribe(_subscription?: Fn) {
    return false;
  }

  bindStore(store: Store, transform?: Transform) {
    markActive(this);
    this.bindStore(store, transform);
  }

  unbindStore(_store?: Store) {
    return false;
  }

  get hasSubscribers() {
    return false;
  }

  publish(_data?: unknown) {}

  runStores(_data: unknown, fn: Fn, thisArg?: unknown, ...args: unknown[]) {
    return fn.apply(thisArg, args);
  }
}

function channel(name: string | symbol): Channel {
  const existing = channels.get(name);
  if (existing) return existing;
  if (typeof name !== "string" && typeof name !== "symbol") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "channel" argument must be of type string or symbol.${received(name)}`);
  return new Channel(name);
}

const subscribe = (name: string | symbol, subscription: Fn) => channel(name).subscribe(subscription);
const unsubscribe = (name: string | symbol, subscription: Fn) => channel(name).unsubscribe(subscription);
const hasSubscribers = (name: string | symbol) => channels.get(name)?.hasSubscribers ?? false;

const traceEvents = ["start", "end", "asyncStart", "asyncEnd", "error"] as const;
type TraceEvent = (typeof traceEvents)[number];
interface TraceContext {
  result?: unknown;
  error?: unknown;
  [k: string]: unknown;
}

function assertChannel(value: unknown, name: string) {
  if (!(value instanceof Channel)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" property must be an instance of Channel.${received(value)}`);
}

class TracingChannel {
  start: Channel;
  end: Channel;
  asyncStart: Channel;
  asyncEnd: Channel;
  error: Channel;

  constructor(nameOrChannels: string | Partial<Record<TraceEvent, Channel>>) {
    if (typeof nameOrChannels === "string") {
      this.start = channel(`tracing:${nameOrChannels}:start`);
      this.end = channel(`tracing:${nameOrChannels}:end`);
      this.asyncStart = channel(`tracing:${nameOrChannels}:asyncStart`);
      this.asyncEnd = channel(`tracing:${nameOrChannels}:asyncEnd`);
      this.error = channel(`tracing:${nameOrChannels}:error`);
    } else if (typeof nameOrChannels === "object") {
      for (const name of traceEvents) assertChannel(nameOrChannels?.[name], `nameOrChannels.${name}`);
      const c = nameOrChannels as Record<TraceEvent, Channel>;
      this.start = c.start;
      this.end = c.end;
      this.asyncStart = c.asyncStart;
      this.asyncEnd = c.asyncEnd;
      this.error = c.error;
    } else {
      throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "nameOrChannels" argument must be an string, object, or Channel.${received(nameOrChannels)}`);
    }
  }

  subscribe(handlers: Partial<Record<TraceEvent, Fn>>) {
    for (const name of traceEvents) if (handlers[name]) this[name]?.subscribe(handlers[name]);
  }

  unsubscribe(handlers: Partial<Record<TraceEvent, Fn>>) {
    let done = true;
    for (const name of traceEvents) if (handlers[name] && !this[name]?.unsubscribe(handlers[name])) done = false;
    return done;
  }

  traceSync(fn: Fn, context: TraceContext = {}, thisArg?: unknown, ...args: unknown[]) {
    const { start, end, error } = this;
    return start.runStores(context, () => {
      try {
        const result = fn.apply(thisArg, args);
        context.result = result;
        return result;
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }

  tracePromise(fn: Fn, context: TraceContext = {}, thisArg?: unknown, ...args: unknown[]) {
    const { start, end, asyncStart, asyncEnd, error } = this;
    function reject(err: unknown) {
      context.error = err;
      error.publish(context);
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return Promise.reject(err);
    }
    function resolve(result: unknown) {
      context.result = result;
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return result;
    }
    return start.runStores(context, () => {
      try {
        let promise = fn.apply(thisArg, args);
        if (!(promise instanceof Promise)) promise = Promise.resolve(promise);
        return promise.then(resolve, reject);
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }

  traceCallback(fn: Fn, position = -1, context: TraceContext = {}, thisArg?: unknown, ...args: unknown[]) {
    const { start, end, asyncStart, asyncEnd, error } = this;
    const callback = args.at(position);
    validateFunction(callback, "callback");
    function wrappedCallback(this: unknown, err: unknown, res: unknown) {
      if (err) {
        context.error = err;
        error.publish(context);
      } else context.result = res;
      // eslint-disable-next-line prefer-rest-params
      const a = arguments;
      asyncStart.runStores(context, () => {
        try {
          return (callback as Fn).apply(this, a as unknown as unknown[]);
        } finally {
          asyncEnd.publish(context);
        }
      });
    }
    args.splice(position, 1, wrappedCallback);
    return start.runStores(context, () => {
      try {
        return fn.apply(thisArg, args);
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }
}

const tracingChannel = (nameOrChannels: string | Partial<Record<TraceEvent, Channel>>) => new TracingChannel(nameOrChannels);

export default { channel, hasSubscribers, subscribe, tracingChannel, unsubscribe, Channel };
