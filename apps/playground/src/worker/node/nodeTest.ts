// node:test as Bun has it (bun/src/js/node/test.ts): top-level tests and suites register with bun:test (test.ts), so
// `bun test` runs and reports them; subtests (`t.test`) run inside their parent and fail it ("1 subtest failed",
// with the first failure as its `cause`) without counting on their own. `beforeEach`/`afterEach` of the file or a
// suite run around each test and subtest, with its TestContext. `mock` is Node's MockTracker; `mock.timers` drives
// bun:test's fake timers. `run()` runs each file in a `bun test` child process (worker/processes.ts) and rebuilds
// node's events from the ones the child writes. Not here, as in Bun: `mock.module()`, snapshots.
import assert from "./assert";
import { codeError } from "./errors";
import { fakeTimers, real } from "./fakeTimers";
import { Readable } from "./stream";
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

// ---- run(): the child's side ----
//
// A `bun test` that run() started (NODE_TEST_CONTEXT=child-v8) writes one JSON event per finished test on stdout after
// Bun's marker; the parent rebuilds node's events from them (runFiles below). As Bun 1.4.4 does.

const RUN_CHILD_ENV = "NODE_TEST_CONTEXT";
const RUN_EVENT_PREFIX = "\0bun:test:run\0";
const childReporter = () => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[RUN_CHILD_ENV] !== undefined;

function emitChildEvent(type: string, data: object) {
  try {
    process.stdout.write(`${RUN_EVENT_PREFIX}${JSON.stringify({ type, data })}\n`);
  } catch {}
}

type SerializedError = { message: string; stack?: string; code?: string; failureType?: string; name: string; cause?: SerializedError };
function serializeError(error: unknown, depth = 0): SerializedError {
  if (error instanceof Error) {
    const e = error as Error & { code?: string; failureType?: string; cause?: unknown };
    return { message: e.message, stack: e.stack, code: e.code, failureType: e.failureType, name: e.name, cause: e.cause !== undefined && depth < 8 ? serializeError(e.cause, depth + 1) : undefined };
  }
  return { message: String(error), stack: undefined, code: undefined, name: "Error" };
}

/** A test or suite that never runs (skip, or a todo subtest): a pass carrying its directive, in a run() child. */
function reportDirective(name: string, nesting: number, directive: { skip: string | true } | { todo: string | true }, type: "test" | "suite" = "test") {
  if (!childReporter()) return;
  const skip = "skip" in directive ? directive.skip : undefined;
  emitChildEvent("test:pass", { name, nesting, testNumber: 0, duration_ms: 0, skip, todo: "todo" in directive ? directive.todo : undefined, type, tags: [], error: undefined });
}

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
  /** `plan(n, { wait })`: wait for the missing assertions (`true`), or that many ms; and who waits. */
  #planWait: boolean | number = false;
  #planWaiting: (() => void) | undefined;
  #count = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #pending = new Set<Promise<unknown>>();
  #failed = 0;
  #firstFailure: unknown;
  #error: unknown;
  #passed = false;
  /** The directive a run() child reports it with: `t.skip()`/`t.todo()` (their message, or true), or the todo option. */
  #skip: string | true | undefined;
  #todo: string | true | undefined;
  constructor(name: string, s: Scope, parent?: TestContext, todo?: string | true) {
    this.#name = name;
    this.#scope = s;
    this.#parent = parent;
    this.#todo = todo;
  }
  /** Node's nesting: 0 for a top-level test, one more per suite or test around it. */
  get #nesting(): number {
    return this.#parent ? this.#parent.#nesting + 1 : scopeNames(this.#scope).length;
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
        this.#counted();
        return customAsserts.has(k) ? f.call(out, ...args) : f(...args);
      };
    }
    out.snapshot = () => {
      throw new Error("t.assert.snapshot() is not supported in the playground");
    };
    return (this.#assert = out);
  }
  diagnostic(_message: string) {}
  plan(count: number, options: { wait?: boolean | number } = {}) {
    if (!Number.isInteger(count) || count < 1) throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "count" is out of range. It must be >= 1 && <= 4294967295. Received ${count}`);
    if (this.#plan !== undefined) throw codeError(Error, "ERR_TEST_FAILURE", "cannot set plan more than once");
    const { wait = false } = options ?? {};
    if (typeof wait === "number" && !(wait >= 0 && wait <= 2147483647)) throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "options.wait" is out of range. It must be >= 0 && <= 2147483647. Received ${wait}`);
    if (typeof wait !== "number" && typeof wait !== "boolean") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.wait" property must be of type boolean or number. Received ${typeof wait}`);
    this.#plan = count;
    this.#planWait = wait;
  }
  /** An assertion or subtest towards the plan; the last one a waiting plan needs lets the test end. */
  #counted() {
    this.#count++;
    if (this.#planWaiting && this.#plan !== undefined && this.#count >= this.#plan) this.#planWaiting();
  }
  /** Bun's plan check once the test's function and subtests are done: waits for the rest if the plan says so. */
  async #checkPlan() {
    const plan = this.#plan;
    if (plan === undefined || this.#count === plan) return;
    const wait = this.#planWait;
    if (wait === false || this.#count > plan) throw testFailure(`plan expected ${plan} assertions but received ${this.#count}`);
    await new Promise<void>((resolve, reject) => {
      const timer = typeof wait === "number" ? real.setTimeout(() => ((this.#planWaiting = undefined), reject(testFailure(`plan timed out after ${wait}ms with ${this.#count} assertions when expecting ${plan}`))), wait) : undefined;
      this.#planWaiting = () => {
        this.#planWaiting = undefined;
        if (timer !== undefined) real.clearTimeout(timer);
        resolve();
      };
    });
  }
  skip(message?: string) {
    this.#skip = message ?? true;
    if (!this.#parent && !childReporter()) markRunning("skip");
  }
  todo(message?: string) {
    this.#todo = message ?? true;
    if (!this.#parent && !childReporter()) markRunning("todo");
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
      this.#counted();
      if (options.skip || options.todo) {
        reportDirective(name, this.#nesting + 1, options.skip ? { skip: options.skip } : { todo: options.todo || true });
        return undefined;
      }
      if (!this.#beforeRan) {
        this.#beforeRan = true;
        for (const h of this.#hooks.before) await invoke(h, this);
      }
      try {
        await child.run(fn ?? noop, options);
      } catch (e) {
        // Bun prints nothing here: the parent's failure carries the first one as its cause.
        if (!this.#failed++) this.#firstFailure = e;
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
    const started = performance.now();
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
        if (this.#failed) throw Object.assign(testFailure(`${this.#failed} subtest${this.#failed === 1 ? "" : "s"} failed`, "subtestsFailed"), { cause: this.#firstFailure });
        await this.#checkPlan();
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
      if (childReporter()) {
        const skip = this.#skip;
        emitChildEvent(this.#passed ? "test:pass" : "test:fail", {
          name: this.#name,
          nesting: this.#nesting,
          testNumber: 0,
          duration_ms: performance.now() - started,
          skip,
          todo: skip === undefined ? this.#todo : undefined,
          expectFailure: undefined,
          tags: [],
          error: this.#passed ? undefined : serializeError(this.#error),
        });
      }
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
  else if (childReporter()) {
    // In a run() child, as in Bun: a skip reports its directive when its turn comes; a todo runs its body (a failure
    // doesn't fail the file) and reports with the directive.
    const todo = mode === "todo" ? ((typeof options.todo === "string" ? options.todo : undefined) ?? true) : undefined;
    if (mode === "skip") bunTest.test(name, () => reportDirective(name, scopeNames(s).length, { skip: options.skip || true }));
    else bunTest.test(name, () => new TestContext(name, s, undefined, todo).run(fn ?? noop, options).catch(noop), ...timeout);
  } else bunTest.test[mode](name, fn ?? noop);
  return Promise.resolve(undefined);
}

function defineSuite(forced: Mode | undefined, a0: unknown, a1: unknown, a2: unknown): Promise<undefined> {
  const { name, options, fn } = parseArgs(a0, a1, a2);
  const s: Scope = { name, parent: currentScope(), hooks: newHooks() };
  const mode = modeOf(options, forced);
  // A run() child reports a skipped or todo suite as it is defined.
  if (mode !== "run") reportDirective(name, scopeNames(s.parent).length, mode === "skip" ? { skip: options.skip || true } : { todo: options.todo || true }, "suite");
  // As in Bun, a skipped suite's callback never runs: its tests count nowhere.
  if (mode === "skip") return Promise.resolve(undefined);
  (mode === "run" || childReporter() ? bunTest.describe : bunTest.describe[mode])(name, () => {
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

// ---- run(): the parent's side ----

/** node's TestsStream: an object-mode Readable of `{ type, data }`, each also emitted as an event of its type. */
class TestsStream extends Readable {
  #buffer: unknown[] = [];
  #canPush = true;
  constructor() {
    super({ objectMode: true, highWaterMark: Number.MAX_SAFE_INTEGER });
  }
  override _read() {
    this.#canPush = true;
    while (this.#buffer.length > 0) if (!this.#tryPush(this.#buffer.shift())) return;
  }
  #tryPush(message: unknown) {
    if (this.#canPush) this.#canPush = this.push(message);
    else this.#buffer.push(message);
    return this.#canPush;
  }
  publish(type: string, data: unknown) {
    this.emit(type, data);
    this.#tryPush({ __proto__: null, type, data });
  }
  endStream() {
    this.#tryPush(null);
  }
}

type Counts = Record<"tests" | "failed" | "passed" | "cancelled" | "skipped" | "todo" | "topLevel" | "suites", number>;
const newCounts = (): Counts => ({ __proto__: null, tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 0, suites: 0 }) as Counts;
type RunOptions = { files: string[]; cwd: string; env?: Record<string, string>; argv: string[]; execArgv: string[]; setup?: (s: TestsStream) => unknown; signal?: AbortSignal };

const notImplemented = (feature: string, extra?: string) => {
  const issue = " Track the status & thumbs up the issue: https://github.com/oven-sh/bun/issues/5090";
  throw Object.assign(new Error(`${feature} is not yet implemented in Bun.${issue}${extra ? `. ${extra}` : ""}`), { name: "NotImplementedError", code: "ERR_NOT_IMPLEMENTED" });
};

/** `run({ files })`: each file in a `bun test` child process of its own, its events republished on one stream (Bun 1.4.4). */
function run(options: Record<string, any> = {}): TestsStream {
  if (options === null || typeof options !== "object") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options" argument must be of type object.`);
  const { files, cwd = process.cwd(), env, argv = [], execArgv = [], setup, signal, isolation = "process" } = options;
  if (files != null && !Array.isArray(files)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.files" property must be an instance of Array.`);
  if (typeof cwd !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.cwd" property must be of type string.`);
  if (setup != null && typeof setup !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.setup" property must be of type function.`);
  for (const [k, v] of [["argv", argv], ["execArgv", execArgv]] as const)
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.${k}" property must be an instance of Array.`);
  if (isolation !== "process" && isolation !== "none") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.isolation' must be one of: 'process', 'none'. Received '${String(isolation)}'`);
  const stream = new TestsStream();
  // A test file that calls run() on itself would start itself again and again.
  if (childReporter()) {
    process.emitWarning("node:test run() is being called recursively within a test file. skipping running files.");
    stream.endStream();
    return stream;
  }
  if (options.watch) notImplemented("run({ watch: true })", "Use `bun:test --watch` in the interim.");
  if (options.coverage) notImplemented("run({ coverage: true })", "Use `bun:test --coverage` in the interim.");
  if (options.shard) notImplemented("run({ shard })");
  if (isolation === "none") notImplemented("run({ isolation: 'none' })");
  if (options.globPatterns?.length > 0) notImplemented("run({ globPatterns })");
  if (options.globalSetupPath != null) notImplemented("run({ globalSetupPath })");
  if (options.only) notImplemented("run({ only: true })");
  if (options.testNamePatterns != null) notImplemented("run({ testNamePatterns })");
  if (options.testSkipPatterns != null) notImplemented("run({ testSkipPatterns })");
  if (options.forceExit) notImplemented("run({ forceExit: true })");
  if (options.concurrency != null) notImplemented("run({ concurrency })");
  if (files == null) notImplemented("run() default file discovery", "Pass { files: [...] } explicitly.");
  void runFiles({ files, cwd, env, argv, execArgv, setup, signal }, stream);
  return stream;
}

function diagnostics(stream: TestsStream, counts: Counts, durationMs: number) {
  const rows: [string, number][] = [["tests", counts.tests], ["suites", counts.suites], ["pass", counts.passed], ["fail", counts.failed], ["cancelled", counts.cancelled], ["skipped", counts.skipped], ["todo", counts.todo], ["duration_ms", durationMs]];
  for (const [k, v] of rows) stream.publish("test:diagnostic", { __proto__: null, nesting: 0, message: `${k} ${v}` });
}

async function runFiles(opts: RunOptions, stream: TestsStream) {
  const started = Date.now();
  const counts = newCounts();
  // Listeners attach after run() returns.
  await Promise.resolve();
  try {
    if (opts.setup) await opts.setup(stream);
    let i = 0;
    for (; i < opts.files.length; i++) {
      if (opts.signal?.aborted) break;
      await runOneFile(opts.files[i]!, opts, stream, counts);
    }
    for (; i < opts.files.length; i++) cancelledFile(opts.files[i]!, opts, stream, counts);
    stream.publish("test:plan", { __proto__: null, nesting: 0, count: counts.topLevel });
    const durationMs = Date.now() - started;
    diagnostics(stream, counts, durationMs);
    stream.publish("test:summary", { __proto__: null, success: counts.failed === 0 && counts.cancelled === 0, counts, duration_ms: durationMs, file: undefined });
  } catch (err) {
    stream.destroy(err as Error);
    return;
  }
  stream.endStream();
}

const fileNodeOf = (file: string, absolute: string) => ({ nesting: 0, name: file, type: "test", testId: 1, parentId: 0, tags: [], line: 1, column: 1, file: absolute });

function cancelledFile(file: string, opts: RunOptions, stream: TestsStream, counts: Counts) {
  const fileNode = fileNodeOf(file, resolvePath(opts.cwd, file));
  const error = testFailure("test did not finish before its parent and was cancelled", "cancelledByParent");
  const details = { __proto__: null, duration_ms: 0, type: "test", error };
  stream.publish("test:enqueue", { __proto__: null, ...fileNode });
  stream.publish("test:dequeue", { __proto__: null, ...fileNode });
  stream.publish("test:complete", { __proto__: null, ...fileNode, type: undefined, testNumber: 1, details: { ...details, passed: false } });
  stream.publish("test:fail", { __proto__: null, ...fileNode, type: undefined, testNumber: 1, details });
  counts.tests++;
  counts.cancelled++;
  counts.topLevel++;
}

const resolvePath = (cwd: string, p: string) =>
  "/" + (p.startsWith("/") ? p : `${cwd}/${p}`).split("/").reduce<string[]>((out, s) => (s === ".." ? out.slice(0, -1) : s && s !== "." ? [...out, s] : out), []).join("/");

/** Lines of a child's stream as they come, the last one without its newline too. */
async function eachLine(source: ReadableStream<Uint8Array>, onLine: (line: string, last: boolean) => void) {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of source as unknown as AsyncIterable<Uint8Array>) {
    carry += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      onLine(line, false);
    }
  }
  if (carry.length > 0) onLine(carry, true);
}

async function runOneFile(file: string, opts: RunOptions, stream: TestsStream, counts: Counts) {
  const absolute = resolvePath(opts.cwd, file);
  const fileStarted = Date.now();
  const fileCounts = newCounts();
  const fileNode = fileNodeOf(file, absolute);
  stream.publish("test:enqueue", { __proto__: null, ...fileNode });
  stream.publish("test:dequeue", { __proto__: null, ...fileNode });
  const proc = (globalThis as unknown as { Bun: { spawn: Fn } }).Bun.spawn({
    cmd: ["bun", ...opts.execArgv, "test", absolute, ...opts.argv],
    cwd: opts.cwd,
    env: { ...(opts.env ?? process.env), BUN_TEST_DRAIN_EVENT_LOOP: "1", [RUN_CHILD_ENV]: "child-v8" },
    stdout: "pipe",
    stderr: "pipe",
    signal: opts.signal,
  }) as { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void };
  let drainStderr: Promise<void> | undefined;
  try {
    let stderrText = "";
    drainStderr = eachLine(proc.stderr, (line, last) => {
      stderrText += last ? line : `${line}\n`;
      if (line.length > 0) stream.publish("test:stderr", { __proto__: null, file: absolute, message: `${line}\n` });
    });
    drainStderr.catch(noop);
    await eachLine(proc.stdout, (line) => {
      if (line.length === 0) return;
      const marker = line.indexOf(RUN_EVENT_PREFIX);
      if (marker === -1) return stream.publish("test:stdout", { __proto__: null, file: absolute, message: `${line}\n` });
      const before = line.slice(0, marker).trimEnd();
      if (before.length > 0) stream.publish("test:stdout", { __proto__: null, file: absolute, message: `${before}\n` });
      let event;
      try {
        event = JSON.parse(line.slice(marker + RUN_EVENT_PREFIX.length));
      } catch {
        return;
      }
      if (event == null || typeof event.data !== "object" || event.data === null) return;
      republish(event, absolute, stream, fileCounts);
    });
    await drainStderr;
    const exitCode = await proc.exited;
    // A nonzero exit with no failure reported: the file itself failed (it threw as it loaded).
    const fileFailed = exitCode !== 0 && fileCounts.failed === 0;
    const fileDuration = Date.now() - fileStarted;
    const reportFileNode = fileCounts.tests + fileCounts.suites === 0 || fileFailed;
    fileCounts.topLevel++;
    if (reportFileNode) {
      fileCounts.tests++;
      if (fileFailed) fileCounts.failed++;
      else fileCounts.passed++;
    }
    let error: Error | undefined;
    if (fileFailed) error = testFailure(stderrText.trim() || `Test file failed with exit code ${exitCode}`, "testCodeFailure");
    else stream.publish("test:summary", { __proto__: null, success: fileCounts.failed === 0, counts: { __proto__: null, ...fileCounts }, duration_ms: fileDuration, file: absolute });
    if (reportFileNode) {
      stream.publish("test:complete", { __proto__: null, ...fileNode, type: undefined, testNumber: 1, details: { __proto__: null, duration_ms: fileDuration, type: "test", passed: !fileFailed, error } });
      const details = { __proto__: null, duration_ms: fileDuration, type: "test", error };
      stream.publish(fileFailed ? "test:fail" : "test:pass", { __proto__: null, ...fileNode, type: undefined, testNumber: 1, details });
    }
    for (const k of Object.keys(fileCounts) as (keyof Counts)[]) counts[k] += fileCounts[k];
  } finally {
    proc.kill();
    if (drainStderr !== undefined) await drainStderr.catch(noop);
  }
}

function rebuildError(serialized: SerializedError, depth = 0): Error {
  const { message, stack, name, code, failureType, cause } = serialized;
  const error = new Error(message) as Error & { code?: string; failureType?: string; cause?: unknown };
  error.stack = stack;
  if (name !== undefined && name !== "Error") error.name = name;
  if (code !== undefined) error.code = code;
  if (failureType !== undefined) error.failureType = failureType;
  if (cause !== undefined && depth < 8) error.cause = rebuildError(cause, depth + 1);
  return error;
}

function republish(event: { type: string; data: Record<string, any> }, file: string, stream: TestsStream, counts: Counts) {
  const { type, data } = event;
  Object.setPrototypeOf(data, null);
  data.file = file;
  data.nesting = (data.nesting ?? 0) + 1;
  if (type === "test:pass" || type === "test:fail") {
    const isSuite = data.type === "suite";
    // A suite counts in `suites` only, skipped or not.
    if (isSuite) counts.suites++;
    else {
      counts.tests++;
      if (data.skip) counts.skipped++;
      else if (data.todo) counts.todo++;
      else if (type === "test:pass") counts.passed++;
      else counts.failed++;
    }
    const detailType = isSuite ? "suite" : "test";
    data.details = data.error !== undefined ? { __proto__: null, duration_ms: data.duration_ms, type: detailType, error: rebuildError(data.error) } : { __proto__: null, duration_ms: data.duration_ms, type: detailType };
    delete data.error;
    delete data.duration_ms;
    delete data.type;
  }
  stream.publish(type, data);
}

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
  run,
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
