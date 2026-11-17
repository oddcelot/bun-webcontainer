// node:test as Bun has it (bun/src/js/node/test.ts): top-level tests and suites register with bun:test (test.ts), so
// `bun test` runs and reports them; subtests (`t.test`) run inside their parent and fail it ("1 subtest failed")
// without counting on their own. `beforeEach`/`afterEach` of the file or a suite run around each test and subtest,
// with its TestContext. `mock` is Node's MockTracker; `mock.timers` drives bun:test's fake timers. Not here, as
// in Bun: `run()`, `mock.module()`, snapshots.
import assert from "./assert";
import { codeError } from "./errors";
import { fakeTimers } from "./fakeTimers";
import bunTest, { markRunning, testFile } from "./test";

type Fn = (...args: any[]) => any;
type Hooks = { before: Fn[]; after: Fn[]; beforeEach: Fn[]; afterEach: Fn[] };
type Options = { skip?: boolean | string; todo?: boolean | string; only?: boolean; timeout?: number; concurrency?: number | boolean; plan?: number; signal?: AbortSignal };

const noop = () => {};
const newHooks = (): Hooks => ({ before: [], after: [], beforeEach: [], afterEach: [] });

/** A suite (the file, or a `describe`) as node:test sees it: its name and its `beforeEach`/`afterEach` hooks. */
interface Scope {
  name: string;
  parent?: Scope;
  hooks: Hooks;
}

let fileScope: Scope = { name: "", hooks: newHooks() };
let scopeFile: string | undefined;
let scope: Scope | undefined;
/** The test running now, innermost subtest first: `test()` inside it makes a subtest, as in Node. */
let running: TestContext | undefined;

/** The suite being defined; a new file starts from a new root. */
function currentScope(): Scope {
  if (scope) return scope;
  if (scopeFile !== testFile()) (scopeFile = testFile()), (fileScope = { name: "", hooks: newHooks() });
  return fileScope;
}

const scopeNames = (s: Scope | undefined): string[] => (s ? [...scopeNames(s.parent), ...(s.name ? [s.name] : [])] : []);

function testFailure(message: string, failureType?: string): Error {
  const err = new Error(message) as Error & { code: string; failureType?: string };
  if (failureType) err.failureType = failureType;
  err.code = "ERR_TEST_FAILURE";
  return err;
}

/** `fn(arg)`, or `fn(arg, done)` when it takes two parameters, as a promise. */
function invoke(fn: Fn, arg: unknown): Promise<unknown> {
  if (fn.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        fn(arg, (err?: unknown) => (err ? reject(err) : resolve(undefined)));
      } catch (e) {
        reject(e);
      }
    });
  }
  try {
    return Promise.resolve(fn(arg));
  } catch (e) {
    return Promise.reject(e);
  }
}

/** `(name?, options?, fn?)` in any of the orders Node takes. */
function parseArgs(a0: unknown, a1: unknown, a2: unknown): { name: string; options: Options; fn: Fn | undefined } {
  let name: string | undefined;
  let options: Options = {};
  let fn: Fn | undefined;
  const rest = typeof a0 === "string" ? ((name = a0), [a1, a2]) : [a0, a1, a2];
  for (const r of rest) {
    if (typeof r === "function") fn ??= r as Fn;
    else if (r !== null && typeof r === "object" && !fn) options = r as Options;
  }
  if (options.timeout !== undefined && (typeof options.timeout !== "number" || options.timeout < 0)) throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "options.timeout" is out of range. It must be >= 0 && <= 2147483647. Received ${String(options.timeout)}`);
  return { name: name ?? (fn?.name || "<anonymous>"), options, fn };
}

const customAsserts = new Map<string, Fn>();

/** What a test or subtest function gets: Node's TestContext. */
class TestContext {
  #name: string;
  #scope: Scope;
  #parent: TestContext | undefined;
  #hooks = newHooks();
  #beforeRan = false;
  #controller = new AbortController();
  #mock: MockTracker | undefined;
  #assert: Record<string, Fn> | undefined;
  #plan: number | undefined;
  #count = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #pending = new Set<Promise<unknown>>();
  #failed = 0;
  #error: unknown;
  #passed = false;
  constructor(name: string, s: Scope, parent?: TestContext) {
    this.#name = name;
    this.#scope = s;
    this.#parent = parent;
  }
  get name() {
    return this.#name;
  }
  get fullName(): string {
    return this.#parent ? `${this.#parent.fullName} > ${this.#name}` : [...scopeNames(this.#scope), this.#name].join(" > ");
  }
  get filePath() {
    return testFile();
  }
  get signal() {
    return this.#controller.signal;
  }
  get passed() {
    return this.#passed;
  }
  get error() {
    return this.#error;
  }
  get attempt() {
    return 0;
  }
  get workerId() {
    return undefined;
  }
  get tags(): string[] {
    return [];
  }
  get mock(): MockTracker {
    return (this.#mock ??= new MockTracker());
  }
  /** node:assert's functions, each counted towards `plan()`, and the ones `assert.register` added. */
  get assert(): Record<string, Fn> {
    if (this.#assert) return this.#assert;
    const out: Record<string, Fn> = {};
    const all: Record<string, Fn> = { ...(assert as unknown as Record<string, Fn>), ...Object.fromEntries(customAsserts) };
    for (const [k, f] of Object.entries(all)) {
      if (typeof f !== "function" || k === "AssertionError" || k === "CallTracker" || k === "Assert") continue;
      out[k] = (...args: unknown[]) => {
        this.#count++;
        return customAsserts.has(k) ? f.call(out, ...args) : f(...args);
      };
    }
    out.snapshot = () => {
      throw new Error("t.assert.snapshot() is not supported in the playground");
    };
    return (this.#assert = out);
  }
  diagnostic(_message: string) {}
  plan(count: number, _options?: { wait?: boolean | number }) {
    if (!Number.isInteger(count) || count < 1) throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "count" is out of range. It must be >= 1 && <= 4294967295. Received ${count}`);
    if (this.#plan !== undefined) throw codeError(Error, "ERR_TEST_FAILURE", "cannot set plan more than once");
    this.#plan = count;
  }
  skip(_message?: string) {
    if (!this.#parent) markRunning("skip");
  }
  todo(_message?: string) {
    if (!this.#parent) markRunning("todo");
  }
  runOnly(_on: boolean) {
    throw new Error("t.runOnly() is not supported");
  }
  waitFor(condition: () => unknown, options: { interval?: number; timeout?: number } = {}) {
    const { interval = 50, timeout = 1000 } = options;
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        try {
          resolve(condition());
        } catch (e) {
          if (Date.now() - start >= timeout) reject(e);
          else setTimeout(poll, interval);
        }
      };
      poll();
    });
  }
  before(fn: Fn) {
    this.#hooks.before.push(fn);
  }
  after(fn: Fn) {
    this.#hooks.after.push(fn);
  }
  beforeEach(fn: Fn) {
    this.#hooks.beforeEach.push(fn);
  }
  afterEach(fn: Fn) {
    this.#hooks.afterEach.push(fn);
  }

  /** A subtest: runs after this test's earlier ones, inside this test; a failure fails this test. */
  test(a0?: unknown, a1?: unknown, a2?: unknown): Promise<undefined> {
    const { name, options, fn } = parseArgs(a0, a1, a2);
    const child = new TestContext(name, this.#scope, this);
    const prev = this.#queue;
    const p = (async () => {
      await prev.catch(noop);
      this.#count++;
      if (options.skip || options.todo) return undefined;
      if (!this.#beforeRan) {
        this.#beforeRan = true;
        for (const h of this.#hooks.before) await invoke(h, this);
      }
      try {
        await child.run(fn ?? noop, options);
      } catch (e) {
        this.#failed++;
        console.error(e instanceof Error ? `${e.name === "Error" ? "error" : e.name}: ${e.message}` : `error: ${String(e)}`);
      }
      return undefined;
    })();
    this.#queue = p;
    this.#pending.add(p);
    return p;
  }

  /** The hooks around this test, outermost first: its suites', then its parent tests'. */
  #chain(): Hooks[] {
    if (this.#parent) return [...this.#parent.#chain(), this.#parent.#hooks];
    const out: Hooks[] = [];
    for (let s: Scope | undefined = this.#scope; s; s = s.parent) out.unshift(s.hooks);
    return out;
  }

  /** Runs the test with the hooks around it; rejects with what failed it. */
  async run(fn: Fn, options: Options = {}) {
    if (options.plan !== undefined) this.plan(options.plan);
    const chain = this.#chain();
    const prev = running;
    running = this;
    try {
      for (const h of chain) for (const f of h.beforeEach) await invoke(f, this);
      try {
        await invoke(fn, this);
        // Subtests nobody awaited still belong to this test.
        while (this.#pending.size) {
          const all = [...this.#pending];
          this.#pending.clear();
          await Promise.all(all);
        }
        if (this.#failed) throw testFailure(`${this.#failed} subtest${this.#failed === 1 ? "" : "s"} failed`, "subtestsFailed");
        if (this.#plan !== undefined && this.#count !== this.#plan) throw testFailure(`plan expected ${this.#plan} assertions but received ${this.#count}`);
        this.#passed = true;
      } catch (e) {
        this.#error = e;
        throw e;
      } finally {
        for (const h of [...chain].reverse()) for (const f of h.afterEach) await invoke(f, this);
        for (const f of this.#hooks.after) await invoke(f, this);
        this.#controller.abort();
        this.#mock?.reset();
      }
    } finally {
      running = prev;
    }
  }
}

/** What a `describe` callback and suite hooks get: Node's SuiteContext. */
class SuiteContext {
  #scope: Scope;
  #controller = new AbortController();
  constructor(s: Scope) {
    this.#scope = s;
  }
  get name() {
    return this.#scope.name;
  }
  get fullName() {
    return scopeNames(this.#scope).join(" > ");
  }
  get filePath() {
    return testFile();
  }
  get signal() {
    return this.#controller.signal;
  }
  get passed() {
    return true;
  }
  get attempt() {
    return 0;
  }
  diagnostic(_message: string) {}
}

// ---- registration ----

type Mode = "run" | "skip" | "todo";
const modeOf = (o: Options, forced?: Mode): Mode => forced ?? (o.skip ? "skip" : o.todo ? "todo" : "run");

function defineTest(forced: Mode | undefined, a0: unknown, a1: unknown, a2: unknown): Promise<undefined> {
  if (running && !forced) return running.test(a0, a1, a2);
  const { name, options, fn } = parseArgs(a0, a1, a2);
  if (running) return running.test(name, { ...options, [forced!]: true }, fn);
  const s = currentScope();
  const mode = modeOf(options, forced);
  const timeout = options.timeout === undefined ? [] : [{ timeout: Math.min(options.timeout, 2 ** 31 - 1) }];
  if (mode === "run") bunTest.test(name, () => new TestContext(name, s).run(fn ?? noop, options), ...timeout);
  else bunTest.test[mode](name, fn ?? noop);
  return Promise.resolve(undefined);
}

function defineSuite(forced: Mode | undefined, a0: unknown, a1: unknown, a2: unknown): Promise<undefined> {
  const { name, options, fn } = parseArgs(a0, a1, a2);
  const s: Scope = { name, parent: currentScope(), hooks: newHooks() };
  const mode = modeOf(options, forced);
  // As in Bun, a skipped suite's callback never runs: its tests count nowhere.
  if (mode === "skip") return Promise.resolve(undefined);
  (mode === "run" ? bunTest.describe : bunTest.describe[mode])(name, () => {
    const prev = scope;
    scope = s;
    try {
      fn?.(new SuiteContext(s));
    } finally {
      scope = prev;
    }
  });
  return Promise.resolve(undefined);
}

type Api = ((name?: unknown, options?: unknown, fn?: unknown) => Promise<undefined>) & { skip: Api; todo: Api; only: Api };
function api(define: typeof defineTest): Api {
  const make = (forced?: Mode) => (a0?: unknown, a1?: unknown, a2?: unknown) => define(forced, a0, a1, a2);
  // `only` without --test-only runs as usual, in Bun too.
  return Object.assign(make(), { skip: make("skip"), todo: make("todo"), only: make() }) as Api;
}

const test = api(defineTest);
const describe = api(defineSuite);

/** A suite hook (`before`, `after`) inside a test is the test's own; at the top of a file or suite, bun:test's. */
const suiteHook = (kind: "before" | "after") => (fn: Fn, _options?: object) => {
  if (running) return void running[kind](fn);
  const ctx = new SuiteContext(currentScope());
  bunTest[kind === "before" ? "beforeAll" : "afterAll"](() => invoke(fn, ctx));
};
const eachHook = (kind: "beforeEach" | "afterEach") => (fn: Fn, _options?: object) => {
  if (running) return void running[kind](fn);
  currentScope().hooks[kind].push(fn);
};

// ---- mocks ----

type Call = { arguments: unknown[]; error: unknown; result: unknown; stack: Error; target: unknown; this: unknown };

class MockFunctionContext {
  #calls: Call[] = [];
  #impl: Fn;
  #original: Fn;
  #once = new Map<number, Fn>();
  #times: number | undefined;
  #restore: (() => void) | undefined;
  constructor(impl: Fn, original: Fn, times: number | undefined, restore?: () => void) {
    this.#impl = impl;
    this.#original = original;
    this.#times = times;
    this.#restore = restore;
  }
  get calls(): Call[] {
    return this.#calls.slice();
  }
  callCount() {
    return this.#calls.length;
  }
  mockImplementation(fn: Fn) {
    if (typeof fn !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "implementation" argument must be of type function.`);
    this.#impl = fn;
  }
  mockImplementationOnce(fn: Fn, onCall?: number) {
    if (typeof fn !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "implementation" argument must be of type function.`);
    this.#once.set(onCall ?? this.#calls.length, fn);
  }
  resetCalls() {
    this.#calls = [];
  }
  restore() {
    this.#restore?.();
  }
  /** @internal The implementation for the next call. */
  _next(): Fn {
    const n = this.#calls.length;
    const once = this.#once.get(n);
    if (once) {
      this.#once.delete(n);
      return once;
    }
    if (this.#times !== undefined && n >= this.#times) return this.#original;
    return this.#impl;
  }
  /** @internal */
  _record(call: Call) {
    this.#calls.push(call);
  }
}

class MockPropertyContext {
  #accesses: { type: "get" | "set"; value: unknown; stack: Error }[] = [];
  #value: unknown;
  #once = new Map<number, unknown>();
  #restore: () => void;
  constructor(value: unknown, restore: () => void) {
    this.#value = value;
    this.#restore = restore;
  }
  get accesses() {
    return this.#accesses.slice();
  }
  accessCount() {
    return this.#accesses.length;
  }
  mockImplementation(value: unknown) {
    this.#value = value;
  }
  mockImplementationOnce(value: unknown, onAccess?: number) {
    this.#once.set(onAccess ?? this.#accesses.length, value);
  }
  resetAccesses() {
    this.#accesses = [];
  }
  restore() {
    this.#restore();
  }
  /** @internal */
  _get() {
    const n = this.#accesses.length;
    const value = this.#once.has(n) ? this.#once.get(n) : this.#value;
    this.#once.delete(n);
    this.#accesses.push({ type: "get", value, stack: new Error() });
    return value;
  }
  /** @internal */
  _set(value: unknown) {
    this.#accesses.push({ type: "set", value, stack: new Error() });
    this.#value = value;
  }
}

/** `mock.timers`: bun:test's fake timers (Bun's `jest.useFakeTimers`) behind Node's API. */
class MockTimers {
  enable(options: { apis?: string[]; now?: number | Date } = {}) {
    fakeTimers.useFakeTimers({ now: options.now });
  }
  tick(ms = 1) {
    fakeTimers.advanceTimersByTime(ms);
  }
  runAll() {
    fakeTimers.runAllTimers();
  }
  setTime(ms: number) {
    fakeTimers.setSystemTime(ms);
  }
  reset() {
    if (fakeTimers.isFakeTimers()) fakeTimers.useRealTimers();
  }
  [Symbol.dispose]() {
    this.reset();
  }
}

class MockTracker {
  #mocks: { restore(): void }[] = [];
  #timers: MockTimers | undefined;
  get timers(): MockTimers {
    return (this.#timers ??= new MockTimers());
  }
  #make(original: Fn, impl: Fn, times: number | undefined, restore?: () => void): Fn & { mock: MockFunctionContext } {
    const ctx = new MockFunctionContext(impl, original, times, restore);
    const mocked = function (this: unknown, ...args: unknown[]) {
      const fn = ctx._next();
      const call: Call = { arguments: args, error: undefined, result: undefined, stack: new Error(), target: new.target, this: this };
      try {
        call.result = new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
      } catch (e) {
        call.error = e;
        ctx._record(call);
        throw e;
      }
      ctx._record(call);
      return call.result;
    };
    Object.defineProperty(mocked, "name", { value: original.name, configurable: true });
    Object.defineProperty(mocked, "length", { value: original.length, configurable: true });
    Object.defineProperty(mocked, "mock", { value: ctx, enumerable: false, configurable: false, writable: false });
    this.#mocks.push(ctx);
    return mocked as never;
  }
  fn(original?: Fn | object, implementation?: Fn | object, options: { times?: number } = {}) {
    if (original !== undefined && typeof original === "object") (options = original as object), (original = undefined);
    if (implementation !== undefined && typeof implementation === "object") (options = implementation as object), (implementation = undefined);
    const orig = (original as Fn | undefined) ?? function () {};
    return this.#make(orig, (implementation as Fn | undefined) ?? orig, options.times);
  }
  method(object: object, methodName: PropertyKey, implementation?: Fn | object, options: { getter?: boolean; setter?: boolean; times?: number } = {}) {
    if (implementation !== undefined && typeof implementation === "object") (options = implementation as object), (implementation = undefined);
    if (object === null || (typeof object !== "object" && typeof object !== "function")) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "object" argument must be of type object.`);
    let desc: PropertyDescriptor | undefined;
    for (let o: object | null = object; o && !desc; o = Object.getPrototypeOf(o)) desc = Object.getOwnPropertyDescriptor(o, methodName);
    const own = Object.getOwnPropertyDescriptor(object, methodName);
    const original = options.getter ? desc?.get : options.setter ? desc?.set : desc?.value;
    if (typeof original !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'methodName' must be a method. Received ${String(original)}`);
    const restore = () => (own ? Object.defineProperty(object, methodName, own) : delete (object as Record<PropertyKey, unknown>)[methodName]);
    const mock = this.#make(original, (implementation as Fn | undefined) ?? original, options.times, restore);
    const next: PropertyDescriptor = { configurable: desc!.configurable, enumerable: desc!.enumerable };
    if (options.getter) Object.assign(next, { get: mock, set: desc!.set });
    else if (options.setter) Object.assign(next, { get: desc!.get, set: mock });
    else Object.assign(next, { value: mock, writable: desc!.writable });
    Object.defineProperty(object, methodName, next);
    return mock;
  }
  getter(object: object, methodName: PropertyKey, implementation?: Fn | object, options: object = {}) {
    if (implementation !== undefined && typeof implementation === "object") (options = implementation), (implementation = undefined);
    return this.method(object, methodName, implementation, { ...options, getter: true });
  }
  setter(object: object, methodName: PropertyKey, implementation?: Fn | object, options: object = {}) {
    if (implementation !== undefined && typeof implementation === "object") (options = implementation), (implementation = undefined);
    return this.method(object, methodName, implementation, { ...options, setter: true });
  }
  property(object: object, propertyName: PropertyKey, value?: unknown) {
    const own = Object.getOwnPropertyDescriptor(object, propertyName);
    const restore = () => (own ? Object.defineProperty(object, propertyName, own) : delete (object as Record<PropertyKey, unknown>)[propertyName]);
    const ctx = new MockPropertyContext(arguments.length > 2 ? value : (object as Record<PropertyKey, unknown>)[propertyName], restore);
    Object.defineProperty(object, propertyName, { configurable: true, enumerable: own?.enumerable ?? true, get: () => ctx._get(), set: (v) => ctx._set(v) });
    this.#mocks.push(ctx);
    const proxy = new Proxy(object, { get: (t, k, r) => (k === "mock" ? ctx : Reflect.get(t, k, r)) });
    return proxy;
  }
  module(): never {
    throw new Error("mock.module() is not yet implemented in Bun. Use `bun:test` in the interim.");
  }
  reset() {
    this.restoreAll();
    this.#mocks = [];
    this.#timers?.reset();
  }
  restoreAll() {
    for (const m of this.#mocks) m.restore();
  }
}

const mock = new MockTracker();

const notSupported = (what: string) => () => {
  throw new Error(`${what} is not supported in the playground`);
};

const nodeTest = Object.assign(test, {
  test,
  it: test,
  describe,
  suite: describe,
  before: suiteHook("before"),
  after: suiteHook("after"),
  beforeEach: eachHook("beforeEach"),
  afterEach: eachHook("afterEach"),
  mock,
  skip: test.skip,
  todo: test.todo,
  only: test.only,
  run: notSupported("node:test run()"),
  getTestContext: () => running,
  assert: {
    register(name: string, fn: Fn) {
      if (typeof name !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "name" argument must be of type string.`);
      if (typeof fn !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "fn" argument must be of type function.`);
      customAsserts.set(name, fn);
    },
  },
  snapshot: { setDefaultSnapshotSerializers: notSupported("snapshot.setDefaultSnapshotSerializers()"), setResolveSnapshotPath: notSupported("snapshot.setResolveSnapshotPath()") },
});

export default nodeTest;
