import { inspect, isDeepStrictEqual } from "./util";

// `bun:test`: a compact Jest-style runner. Files register suites while they load; `runTestFiles` loads each file in
// turn, runs what it registered and reports in the style of `bun test`. Not supported: snapshots, fake timers,
// mock.module, expect.extend, expect.assertions, coverage, --watch.

type Fn = (done?: (err?: unknown) => void) => unknown;
type Case = { kind: "case"; name: string; fn: Fn; mode: Mode; timeout: number };
type Suite = { kind: "suite"; name: string; parent?: Suite; items: (Suite | Case)[]; mode: Mode; hooks: Record<Hook, Fn[]> };
type Mode = "run" | "skip" | "todo" | "only";
type Hook = "beforeAll" | "beforeEach" | "afterEach" | "afterAll";

const newSuite = (name: string, parent?: Suite, mode: Mode = "run"): Suite => ({ kind: "suite", name, parent, items: [], mode, hooks: { beforeAll: [], beforeEach: [], afterEach: [], afterAll: [] } });

let root = newSuite("");
let current = root;
let expectCalls = 0;
let defaultTimeout = 5000;

// ---- formatting ----

/** Bun's value format: JSON-like, one entry per line, trailing commas. */
function pretty(v: unknown, ind = "", seen: unknown[] = []): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v !== "object" || v === null) return typeof v === "function" ? `[Function: ${v.name || "(anonymous)"}]` : String(v);
  if (v instanceof Asym) return v.label;
  if (seen.includes(v)) return "[Circular]";
  const proto = Object.getPrototypeOf(v);
  const isArr = Array.isArray(v);
  if (!isArr && proto !== Object.prototype && proto !== null) return inspect(v, { depth: 2 });
  const entries = isArr ? (v as unknown[]).map((x) => pretty(x, ind + "  ", [...seen, v])) : Object.keys(v).map((k) => `${JSON.stringify(k)}: ${pretty((v as Record<string, unknown>)[k], ind + "  ", [...seen, v])}`);
  const [open, close] = isArr ? ["[", "]"] : ["{", "}"];
  return entries.length ? `${open}\n${entries.map((e) => `${ind}  ${e},\n`).join("")}${ind}${close}` : open + close;
}

/** `- Expected  - n` / `+ Received  + n` and the lines around the changes, from a line-level LCS. */
function diff(expected: unknown, received: unknown): string {
  const a = pretty(expected).split("\n");
  const b = pretty(received).split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { sign: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push({ sign: " ", text: a[i++] }), j++;
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ sign: "-", text: a[i++] });
    else out.push({ sign: "+", text: b[j++] });
  }
  const keep = out.map((l, k) => l.sign !== " " || out.slice(Math.max(0, k - 2), k + 3).some((x) => x.sign !== " "));
  const lines: string[] = [];
  out.forEach((l, k) => {
    if (keep[k]) lines.push(`${l.sign} ${l.text}`);
    else if (keep[k - 1]) lines.push("  ...");
  });
  const minus = out.filter((l) => l.sign === "-").length;
  const plus = out.filter((l) => l.sign === "+").length;
  return `- Expected  - ${minus}\n+ Received  + ${plus}\n\n${lines.join("\n")}`;
}

// ---- equality ----

class Asym {
  constructor(
    public label: string,
    public test: (v: unknown) => boolean,
  ) {}
}

function equals(a: unknown, b: unknown, strict = false): boolean {
  if (a instanceof Asym) return a.test(b);
  if (b instanceof Asym) return b.test(a);
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || a instanceof RegExp || a instanceof Map || a instanceof Set || ArrayBuffer.isView(a)) return isDeepStrictEqual(a, b, false);
  if (a instanceof Error && b instanceof Error && (a.message !== b.message || a.name !== b.name)) return false;
  const keys = (o: object) => Object.keys(o).filter((k) => strict || (o as Record<string, unknown>)[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && equals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], strict));
}

/** `toMatchObject`: every property of `sub` is in `obj` (recursively), arrays element by element. */
function subset(obj: unknown, sub: unknown): boolean {
  if (sub instanceof Asym) return sub.test(obj);
  if (typeof sub !== "object" || sub === null || typeof obj !== "object" || obj === null) return equals(obj, sub);
  if (Array.isArray(sub)) return Array.isArray(obj) && obj.length === sub.length && sub.every((s, i) => subset(obj[i], s));
  return Object.keys(sub).every((k) => subset((obj as Record<string, unknown>)[k], (sub as Record<string, unknown>)[k]));
}

// ---- matchers ----

type Result = { pass: boolean; expected?: unknown; received?: unknown; label?: string; rlabel?: string; diff?: boolean; noArg?: boolean };
type Ctx = { mode?: "resolves" | "rejects" };
const num = (v: unknown, name: string) => {
  if (typeof v !== "number" && typeof v !== "bigint") throw new TypeError(`expect(received).${name}(): received value must be a number or bigint`);
  return v;
};
const lenOf = (v: unknown) => (v as { length?: number } | null)?.length;

type Call = { args: unknown[] };
const callsOf = (v: unknown): Call[] => {
  const m = (v as { mock?: { calls: unknown[][] } } | null)?.mock;
  if (!m) throw new TypeError("expect(received): received value must be a mock or spy function");
  return m.calls.map((args) => ({ args }));
};

const matchers: Record<string, (r: any, ...a: any[]) => Result | ((ctx: Ctx) => Result)> = {
  toBe: (r, e) => ({ pass: Object.is(r, e), expected: e, received: r }),
  toEqual: (r, e) => ({ pass: equals(r, e), expected: e, received: r, diff: true }),
  toStrictEqual: (r, e) => ({ pass: equals(r, e, true), expected: e, received: r, diff: true }),
  toBeTruthy: (r) => ({ pass: !!r, received: r, label: "Expected truthy" }),
  toBeFalsy: (r) => ({ pass: !r, received: r, label: "Expected falsy" }),
  toBeNull: (r) => ({ pass: r === null, expected: null, received: r }),
  toBeUndefined: (r) => ({ pass: r === undefined, expected: undefined, received: r }),
  toBeDefined: (r) => ({ pass: r !== undefined, received: r, label: "Expected defined" }),
  toBeNaN: (r) => ({ pass: Number.isNaN(r), received: r, label: "Expected NaN" }),
  toBeGreaterThan: (r, e) => ({ pass: num(r, "toBeGreaterThan") > e, expected: e, received: r, label: "Expected greater than" }),
  toBeGreaterThanOrEqual: (r, e) => ({ pass: num(r, "toBeGreaterThanOrEqual") >= e, expected: e, received: r, label: "Expected greater than or equal" }),
  toBeLessThan: (r, e) => ({ pass: num(r, "toBeLessThan") < e, expected: e, received: r, label: "Expected less than" }),
  toBeLessThanOrEqual: (r, e) => ({ pass: num(r, "toBeLessThanOrEqual") <= e, expected: e, received: r, label: "Expected less than or equal" }),
  toBeCloseTo: (r, e, digits = 2) => ({ pass: Math.abs(Number(num(r, "toBeCloseTo")) - e) < 10 ** -digits / 2, expected: e, received: r, label: `Expected (precision ${digits})` }),
  toBeInstanceOf: (r, e) => ({ pass: r instanceof e, expected: e?.name ?? e, received: r, label: "Expected constructor" }),
  toContain: (r, e) => ({ pass: typeof r === "string" ? r.includes(e) : [...(r as Iterable<unknown>)].includes(e), expected: e, received: r, label: "Expected to contain" }),
  toContainEqual: (r, e) => ({ pass: [...(r as Iterable<unknown>)].some((x) => equals(x, e)), expected: e, received: r, label: "Expected to contain equal" }),
  toHaveLength: (r, e) => ({ pass: lenOf(r) === e, expected: e, received: lenOf(r), label: "Expected length" }),
  toHaveProperty: (r, path, ...val) => {
    const keys = Array.isArray(path) ? path : String(path).split(/[.[\]]+/).filter(Boolean);
    let cur = r;
    let found = r !== null && r !== undefined;
    for (const k of keys) {
      if (cur === null || cur === undefined || !(k in Object(cur))) found = false;
      cur = found ? (cur as Record<string, unknown>)[k] : undefined;
    }
    return { pass: found && (!val.length || equals(cur, val[0])), expected: val.length ? val[0] : path, received: val.length ? cur : r, label: val.length ? "Expected" : "Expected path" };
  },
  toMatch: (r, e) => ({ pass: typeof r === "string" && (e instanceof RegExp ? e.test(r) : r.includes(e)), expected: e, received: r, label: "Expected to match" }),
  toMatchObject: (r, e) => ({ pass: subset(r, e), expected: e, received: r, diff: true }),
  toThrow: (r, e) => (ctx) => {
    let threw = false;
    let err: unknown;
    if (ctx.mode === "rejects") (threw = true), (err = r);
    else {
      if (typeof r !== "function") throw new TypeError("expect(received).toThrow(): received value must be a function");
      try {
        r();
      } catch (x) {
        (threw = true), (err = x);
      }
    }
    const msg = (err as Error | undefined)?.message ?? String(err);
    const ok =
      threw &&
      (e === undefined ||
        (typeof e === "string" ? msg.includes(e) : e instanceof RegExp ? e.test(msg) : typeof e === "function" ? err instanceof e : e instanceof Error ? msg === e.message : equals(err, e)));
    return { pass: ok, expected: e, received: threw ? err : "function did not throw", label: e === undefined ? "Expected to throw" : "Expected to throw" };
  },
  toHaveBeenCalled: (r) => ({ pass: callsOf(r).length > 0, received: callsOf(r).length, label: "Expected number of calls >= 1\nReceived number of calls" }),
  toHaveBeenCalledTimes: (r, e) => ({ pass: callsOf(r).length === e, expected: e, received: callsOf(r).length, label: "Expected number of calls", rlabel: "Received number of calls" }),
  toHaveBeenCalledWith: (r, ...a) => ({ pass: callsOf(r).some((c) => equals(c.args, a)), expected: a, received: callsOf(r).map((c) => c.args), diff: false }),
  toHaveBeenLastCalledWith: (r, ...a) => ({ pass: equals(callsOf(r).at(-1)?.args, a), expected: a, received: callsOf(r).at(-1)?.args }),
  toHaveBeenNthCalledWith: (r, n, ...a) => ({ pass: equals(callsOf(r)[n - 1]?.args, a), expected: a, received: callsOf(r)[n - 1]?.args }),
};
matchers.toBeTrue = (r) => ({ pass: r === true, expected: true, received: r });
matchers.toBeFalse = (r) => ({ pass: r === false, expected: false, received: r });
matchers.toHaveBeenCalledOnce = (r) => matchers.toHaveBeenCalledTimes(r, 1);

function check(name: string, recv: unknown, args: unknown[], not: boolean, ctx: Ctx) {
  expectCalls++;
  let res = matchers[name](recv, ...args);
  if (typeof res === "function") res = res(ctx);
  if (res.pass !== not) return;
  const sig = `expect(${ctx.mode ? `received).${ctx.mode}` : "received)"}${not ? ".not" : ""}.${name}(${args.length ? "expected" : ""})`;
  let detail: string;
  const label = res.label ?? "Expected";
  const hasExpected = "expected" in res;
  if (not) detail = hasExpected ? `${label}: not ${pretty(res.expected)}` : `Received: ${pretty(res.received)}`;
  else if (res.diff && typeof res.expected === "object" && res.expected !== null) detail = diff(res.expected, res.received);
  else detail = hasExpected ? `${label}: ${pretty(res.expected)}\n${res.rlabel ?? "Received"}: ${pretty(res.received)}` : `${label}\nReceived: ${pretty(res.received)}`;
  throw new ExpectError(`${sig}\n\n${detail}`);
}

class ExpectError extends Error {
  name = "ExpectError";
}

function makeExpect(actual: unknown, not = false, mode?: Ctx["mode"]): object {
  return new Proxy(
    {},
    {
      get(_, name: string) {
        if (name === "not") return makeExpect(actual, !not, mode);
        if (name === "resolves" || name === "rejects") return makeExpect(actual, not, name);
        if (name === "then") return undefined;
        if (!(name in matchers)) throw new TypeError(`expect(...).${name} is not supported here`);
        return (...args: unknown[]) => {
          if (!mode) return check(name, actual, args, not, {});
          return Promise.resolve(actual).then(
            (v) => {
              if (mode === "rejects") throw new ExpectError("Expected promise that rejects\nReceived promise that resolved");
              check(name, v, args, not, { mode });
            },
            (e) => {
              if (mode === "resolves") throw new ExpectError(`Expected promise that resolves\nReceived promise that rejected: ${pretty(e)}`);
              check(name, e, args, not, { mode });
            },
          );
        };
      },
    },
  );
}

const expect = Object.assign((actual: unknown) => makeExpect(actual) as Record<string, any>, {
  anything: () => new Asym("Anything", (v) => v !== null && v !== undefined),
  any: (c: Function) =>
    new Asym(`Any<${c.name}>`, (v) => (c === String ? typeof v === "string" : c === Number ? typeof v === "number" : c === Boolean ? typeof v === "boolean" : c === Function ? typeof v === "function" : v instanceof c)),
  objectContaining: (o: object) => new Asym("ObjectContaining", (v) => subset(v, o)),
  arrayContaining: (a: unknown[]) => new Asym("ArrayContaining", (v) => Array.isArray(v) && a.every((x) => v.some((y) => equals(y, x)))),
  stringContaining: (s: string) => new Asym(`StringContaining ${JSON.stringify(s)}`, (v) => typeof v === "string" && v.includes(s)),
  stringMatching: (re: RegExp) => new Asym(`StringMatching ${re}`, (v) => typeof v === "string" && re.test(v)),
});

// ---- mocks ----

type MockFn = ((...args: any[]) => any) & {
  mock: { calls: unknown[][]; results: { type: "return" | "throw"; value: unknown }[]; instances: unknown[]; lastCall?: unknown[] };
  [k: string]: any;
};

function mock<T extends (...args: any[]) => any>(impl?: T): MockFn {
  let current: Function | undefined = impl;
  const once: Function[] = [];
  const fn = function (this: unknown, ...args: unknown[]) {
    fn.mock.calls.push(args);
    fn.mock.instances.push(this);
    fn.mock.lastCall = args;
    try {
      const value = (once.shift() ?? current)?.apply(this, args);
      fn.mock.results.push({ type: "return", value });
      return value;
    } catch (e) {
      fn.mock.results.push({ type: "throw", value: e });
      throw e;
    }
  } as MockFn;
  fn.mock = { calls: [], results: [], instances: [] };
  const clear = () => ((fn.mock = { calls: [], results: [], instances: [] }), fn);
  Object.assign(fn, {
    mockClear: clear,
    mockReset: () => (clear(), (current = undefined), (once.length = 0), fn),
    mockRestore: () => (clear(), (current = impl), fn),
    mockImplementation: (f: Function) => ((current = f), fn),
    mockImplementationOnce: (f: Function) => (once.push(f), fn),
    mockReturnValue: (v: unknown) => ((current = () => v), fn),
    mockReturnValueOnce: (v: unknown) => (once.push(() => v), fn),
    mockResolvedValue: (v: unknown) => ((current = () => Promise.resolve(v)), fn),
    mockRejectedValue: (v: unknown) => ((current = () => Promise.reject(v)), fn),
    mockReturnThis: () => ((current = function (this: unknown) { return this; }), fn),
    getMockImplementation: () => current,
  });
  return fn;
}

function spyOn<T extends object>(obj: T, key: keyof T & string): MockFn {
  const orig = obj[key] as unknown as Function;
  const spy = mock(function (this: unknown, ...a: unknown[]) {
    return orig.apply(this, a);
  });
  const restore = spy.mockRestore;
  spy.mockRestore = () => ((obj[key] = orig as T[keyof T & string]), restore());
  obj[key] = spy as unknown as T[keyof T & string];
  return spy;
}
mock.module = () => {
  throw new Error("mock.module() is not supported here");
};
const jest = { fn: mock, spyOn, mock: mock.module };

// ---- registration ----

/** `%s %d %i %f %j %o %p %#` and `$prop` in `.each` titles. */
function title(t: string, row: unknown, idx: number): string {
  const args = Array.isArray(row) ? [...row] : [row];
  let out = t.replace(/%([sdifjop#%])/g, (m, c: string) => (c === "%" ? "%" : c === "#" ? String(idx) : m === "%%" ? "%" : args.length ? (c === "s" ? String(args.shift()) : c === "d" || c === "i" || c === "f" ? String(Number(args.shift())) : pretty(args.shift())) : m));
  if (row && typeof row === "object" && !Array.isArray(row)) out = out.replace(/\$(\w+)/g, (m, k: string) => (k in row ? String((row as Record<string, unknown>)[k]) : m));
  return out;
}

function defineTest(name: string, fn: Fn | undefined, mode: Mode, opts?: number | { timeout?: number }) {
  const timeout = typeof opts === "number" ? opts : (opts?.timeout ?? defaultTimeout);
  current.items.push({ kind: "case", name, fn: fn ?? (() => {}), mode: fn || mode === "todo" ? mode : "todo", timeout });
}

function defineSuite(name: string, fn: () => void, mode: Mode) {
  const s = newSuite(name, current, mode);
  current.items.push(s);
  const prev = current;
  current = s;
  try {
    fn();
  } finally {
    current = prev;
  }
}

/** `test`/`describe` with `.skip`, `.only`, `.todo`, `.each`, `.if`, `.skipIf`. */
function api<A extends unknown[]>(define: (name: string, fn: any, mode: Mode, ...rest: A) => void) {
  const base = (mode: Mode) => (name: string, fn: any, ...rest: A) => define(name, fn, mode, ...rest);
  const each = (mode: Mode) => (rows: unknown[]) => (name: string, fn: (...a: any[]) => unknown, ...rest: A) =>
    rows.forEach((row, i) => define(title(name, row, i), Array.isArray(row) ? () => fn(...row) : () => fn(row), mode, ...rest));
  return Object.assign(base("run"), {
    skip: base("skip"),
    only: base("only"),
    todo: base("todo"),
    each: each("run"),
    if: (c: boolean) => (c ? base("run") : base("skip")),
    skipIf: (c: boolean) => (c ? base("skip") : base("run")),
    todoIf: (c: boolean) => (c ? base("todo") : base("run")),
  });
}

const test = api(defineTest as (name: string, fn: any, mode: Mode, opts?: number | { timeout?: number }) => void);
const describe = api(defineSuite as (name: string, fn: any, mode: Mode) => void);
const hook = (h: Hook) => (fn: Fn) => void current.hooks[h].push(fn);

// ---- running ----

const paint = (n: number, s: string) => `\x1b[${n}m${s}\x1b[0m`;
const dim = (s: string) => paint(90, s);
const ms = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(2)}s` : `${t.toFixed(2)}ms`);

const hasOnly = (s: Suite): boolean => s.mode === "only" || s.items.some((i) => i.mode === "only" || (i.kind === "suite" && hasOnly(i)));

/** Runs one callback with `done` support and a timeout. */
function call(fn: Fn, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`test timed out after ${timeout}ms`)), timeout);
    const finish = (err?: unknown) => {
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    try {
      if (fn.length > 0) fn(finish);
      else Promise.resolve(fn()).then(() => finish(), finish);
    } catch (e) {
      finish(e ?? new Error("thrown undefined"));
    }
  });
}

type Totals = { pass: number; fail: number; skip: number; todo: number };
const totals: Totals = { pass: 0, fail: 0, skip: 0, todo: 0 };

function failure(e: unknown): string {
  if (e instanceof ExpectError) return `error: ${e.message}`;
  if (e instanceof Error) return `error: ${e.message}`;
  return `error: ${pretty(e)}`;
}

const names = (s: Suite): string[] => (s.parent ? [...names(s.parent), ...(s.name ? [s.name] : [])] : []);

async function runSuite(s: Suite, only: boolean, skipAll: boolean) {
  const ancestors: Suite[] = [];
  for (let p: Suite | undefined = s; p; p = p.parent) ancestors.unshift(p);
  let started = false;
  const label = (c: Case) => [...names(s), c.name].join(" > ");
  const todo = s.mode === "todo";
  for (const item of s.items) {
    if (item.kind === "suite") {
      await runSuite(item, only, skipAll || s.mode === "skip" || item.mode === "skip");
      continue;
    }
    const skipped = skipAll || s.mode === "skip" || item.mode === "skip" || (only && item.mode !== "only" && !ancestors.some((a) => a.mode === "only"));
    if (skipped) {
      totals.skip++;
      console.log(dim(`» ${label(item)}`));
      continue;
    }
    if (item.mode === "todo" || todo) {
      totals.todo++;
      console.log(`\x1b[35m✎\x1b[0m ${label(item)} ${dim("[todo]")}`);
      continue;
    }
    const t0 = performance.now();
    let err: unknown;
    let failed = false;
    try {
      for (const a of ancestors) if (!started && a === s) for (const h of a.hooks.beforeAll) await call(h, defaultTimeout);
      started = true;
      for (const a of ancestors) for (const h of a.hooks.beforeEach) await call(h, defaultTimeout);
      try {
        await call(item.fn, item.timeout);
      } finally {
        for (const a of [...ancestors].reverse()) for (const h of a.hooks.afterEach) await call(h, defaultTimeout);
      }
    } catch (e) {
      (failed = true), (err = e);
    }
    const time = dim(`[${ms(performance.now() - t0)}]`);
    if (failed) {
      totals.fail++;
      console.error(`${failure(err)}\n\x1b[31m✗\x1b[0m\x1b[31m ${label(item)}\x1b[0m ${time}`);
    } else {
      totals.pass++;
      console.log(`\x1b[32m✓\x1b[0m ${label(item)} ${time}`);
    }
  }
  if (started) for (const h of s.hooks.afterAll) await call(h, defaultTimeout).catch((e) => ((totals.fail++), console.error(`${failure(e)}\n\x1b[31m✗\x1b[0m\x1b[31m ${names(s).join(" > ")} (afterAll)\x1b[0m`)));
}

/**
 * Loads each file (its top level registers suites in `bun:test`), runs it and prints Bun's report.
 * Resolves to the number of failed tests (import errors count as failures).
 */
export async function runTestFiles(files: string[], load: (file: string) => Promise<unknown>, version: string): Promise<number> {
  const t0 = performance.now();
  totals.pass = totals.fail = totals.skip = totals.todo = 0;
  expectCalls = 0;
  console.log(`bun test v${version.replace(/-.*/, "")}`);
  for (const file of files) {
    console.log(`\n${file}:`);
    root = current = newSuite("");
    try {
      await load(file);
    } catch (e) {
      totals.fail++;
      console.error(`${failure(e)}\n\x1b[31m✗\x1b[0m\x1b[31m ${file}\x1b[0m`);
      continue;
    }
    await runSuite(root, hasOnly(root), false);
  }
  const n = totals.pass + totals.fail + totals.skip + totals.todo;
  const row = (count: number, word: string) => (count ? ` ${count} ${word}` : "");
  console.log("");
  console.log(paint(32, ` ${totals.pass} pass`));
  for (const [c, w] of [[totals.skip, "skip"], [totals.todo, "todo"]] as const) if (c) console.log(row(c, w));
  if (totals.fail) console.error(` ${totals.fail} fail`);
  else console.log(" 0 fail");
  console.log(` ${expectCalls} expect() calls`);
  console.log(`Ran ${n} test${n === 1 ? "" : "s"} across ${files.length} file${files.length === 1 ? "" : "s"}. ${dim(`[${ms(performance.now() - t0)}]`)}`);
  return totals.fail;
}

export default {
  describe,
  test,
  it: test,
  expect,
  mock,
  spyOn,
  jest,
  beforeAll: hook("beforeAll"),
  beforeEach: hook("beforeEach"),
  afterEach: hook("afterEach"),
  afterAll: hook("afterAll"),
  setDefaultTimeout: (t: number) => void (defaultTimeout = t),
};
