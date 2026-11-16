// `jest.useFakeTimers()` and `setSystemTime` of `bun:test` (test.ts), as Bun does them: `setTimeout`, `setInterval`,
// their clears, `Date` and `Bun.sleep` run on a clock that only `advanceTimersByTime` and friends move. It starts at
// the real time (or `{ now }`); `setImmediate`, `process.nextTick`, microtasks and `performance.now` stay real.
// `setSystemTime` alone freezes `Date` at that time without faking any timer.

const RealDate = Date;
/** What the test runner itself must keep using while a test fakes the timers (its own timeout). */
export const real = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };

type Timer = { id: number; ms: number; time: number; seq: number; fn: (...a: unknown[]) => void; args: unknown[]; every?: number };

const NOT_ACTIVE = "Fake timers are not active. Call useFakeTimers() first.";
/** Jest's bound on `runAllTimers`: an interval nothing clears would otherwise never end. */
const MAX_RUN = 100_000;

let active = false;
let clock = 0;
let frozen: number | undefined;
let seq = 0;
let nextId = 1;
const timers = new Map<number, Timer>();
let saved: Record<string, unknown> | undefined;

const nowMs = () => (active ? clock : (frozen ?? RealDate.now()));
const stamp = (t: number | Date) => (t instanceof RealDate ? t.getTime() : Number(t));

class FakeTimeout {
  constructor(public _id: number) {}
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
    const t = timers.get(this._id);
    if (t) (t.time = clock + t.ms), (t.seq = seq++);
    return this;
  }
  close() {
    timers.delete(this._id);
    return this;
  }
  [Symbol.toPrimitive]() {
    return this._id;
  }
}

const delayOf = (d: unknown) => {
  const n = Number(d);
  return n >= 1 && n <= 2 ** 31 - 1 ? Math.trunc(n) : 1;
};

function schedule(fn: unknown, delay: unknown, args: unknown[], repeat: boolean) {
  if (typeof fn !== "function") throw new TypeError('The "callback" argument must be of type function.');
  const ms = delayOf(delay);
  const id = nextId++;
  timers.set(id, { id, ms, time: clock + ms, seq: seq++, fn: fn as Timer["fn"], args, every: repeat ? ms : undefined });
  return new FakeTimeout(id);
}

function clear(handle: unknown) {
  const id = handle instanceof FakeTimeout ? handle._id : typeof handle === "number" || typeof handle === "string" ? Number(handle) : undefined;
  if (id !== undefined) timers.delete(id);
}

function FakeDate(this: unknown, ...args: unknown[]): unknown {
  if (!new.target) return new RealDate(nowMs()).toString();
  return Reflect.construct(RealDate, args.length ? args : [nowMs()], new.target);
}
FakeDate.prototype = RealDate.prototype;
FakeDate.now = () => nowMs();
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;

function sleep(ms: number | Date) {
  const wait = ms instanceof RealDate ? ms.getTime() - nowMs() : ms;
  return new Promise<void>((resolve) => void schedule(resolve, wait, [], false));
}

/** Date and, while the timers are faked, the timer functions and `Bun.sleep`, swapped in or back. */
function install() {
  const g = globalThis as unknown as Record<string, unknown>;
  const bun = g.Bun as Record<string, unknown> | undefined;
  if (!saved && (active || frozen !== undefined)) saved = { Date: g.Date, setTimeout: g.setTimeout, setInterval: g.setInterval, clearTimeout: g.clearTimeout, clearInterval: g.clearInterval, sleep: bun?.sleep };
  else if (saved && !active && frozen === undefined) {
    Object.assign(g, { Date: saved.Date, setTimeout: saved.setTimeout, setInterval: saved.setInterval, clearTimeout: saved.clearTimeout, clearInterval: saved.clearInterval });
    if (bun) bun.sleep = saved.sleep;
    saved = undefined;
    return;
  }
  if (!saved) return;
  g.Date = FakeDate;
  if (active) {
    g.setTimeout = (fn: unknown, d?: unknown, ...a: unknown[]) => schedule(fn, d, a, false);
    g.setInterval = (fn: unknown, d?: unknown, ...a: unknown[]) => schedule(fn, d, a, true);
    g.clearTimeout = g.clearInterval = clear;
    if (bun) bun.sleep = sleep;
  } else {
    Object.assign(g, { setTimeout: saved.setTimeout, setInterval: saved.setInterval, clearTimeout: saved.clearTimeout, clearInterval: saved.clearInterval });
    if (bun) bun.sleep = saved.sleep;
  }
}

const need = () => {
  if (!active) throw new Error(NOT_ACTIVE);
};
const byTime = (a: Timer, b: Timer) => a.time - b.time || a.seq - b.seq;

/** Runs the timer (an interval is set again first, so its callback can clear it). */
function fire(t: Timer) {
  if (t.every !== undefined) (t.time = clock + t.every), (t.seq = seq++);
  else timers.delete(t.id);
  t.fn(...t.args);
}

function runUntil(limit: number, only?: Set<number>) {
  for (;;) {
    const next = [...timers.values()].filter((t) => t.time <= limit && (!only || only.has(t.id))).sort(byTime)[0];
    if (!next) break;
    clock = Math.max(clock, next.time);
    fire(next);
  }
}

export const fakeTimers = {
  useFakeTimers(opts?: { now?: number | Date }) {
    if (!active) {
      active = true;
      clock = opts?.now !== undefined ? stamp(opts.now) : (frozen ?? RealDate.now());
      frozen = undefined;
    } else if (opts?.now !== undefined) clock = stamp(opts.now);
    install();
  },
  useRealTimers() {
    active = false;
    frozen = undefined;
    timers.clear();
    install();
  },
  isFakeTimers: () => active,
  advanceTimersByTime(ms: number) {
    need();
    const limit = clock + Math.max(0, Number(ms) || 0);
    runUntil(limit);
    clock = limit;
  },
  advanceTimersToNextTimer(steps = 1) {
    need();
    for (let i = 0; i < steps; i++) {
      const next = [...timers.values()].sort(byTime)[0];
      if (!next) break;
      runUntil(next.time);
    }
  },
  runOnlyPendingTimers() {
    need();
    const pending = new Set(timers.keys());
    runUntil(Infinity, pending);
  },
  runAllTimers() {
    need();
    for (let i = 0; timers.size; i++) {
      if (i >= MAX_RUN) throw new Error(`Ran ${MAX_RUN} timers, and there are still more! Assuming we've hit an infinite recursion and bailing out...`);
      const next = [...timers.values()].sort(byTime)[0];
      clock = Math.max(clock, next.time);
      fire(next);
    }
  },
  clearAllTimers() {
    need();
    timers.clear();
  },
  getTimerCount() {
    need();
    return timers.size;
  },
  now: () => nowMs(),
  /** A `Date` or milliseconds; none goes back to the real time. */
  setSystemTime(t?: number | Date) {
    if (t === undefined) {
      frozen = undefined;
      if (active) clock = RealDate.now();
    } else if (active) clock = stamp(t);
    else frozen = stamp(t);
    install();
  },
};

/** Ends faking, as when a test run starts or ends. */
export const resetFakeTimers = fakeTimers.useRealTimers;
