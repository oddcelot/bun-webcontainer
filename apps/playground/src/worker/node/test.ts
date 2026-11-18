import { fakeTimers, real, resetFakeTimers } from "./fakeTimers";
import { dedent, serialize, SnapshotFile, withMatchers, type SnapshotCounts, type SnapshotIO } from "./snapshot";
import { formatLog } from "../inspect";
import { inspect, isDeepStrictEqual } from "./util";
import type { TestOptions } from "../../testArgs";

// `bun:test`: a compact Jest-style runner. Files register suites while they load; `runTestFiles` loads each file in
// turn, runs what it registered and reports in the style of `bun test`. Coverage is worker/coverage.ts; not supported: --watch.

type Fn = (done?: (err?: unknown) => void) => unknown;
/** `body`: whether it was given a function (a `test.todo` without one doesn't run with `--todo`). */
type Case = { kind: "case"; name: string; fn: Fn; body: boolean; mode: Mode; timeout: number; failing: boolean };
/** What `test.skip.failing` and friends have said so far: the mode, and `.failing`. `.concurrent` and `.serial` change nothing here (tests run in turn). */
type Flags = { mode: Mode; failing: boolean };
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

/** What native Bun's diff printer (test_runner/diff/printDiff.rs) does for a person, not an agent. */
const DIFF = { chunkOver: 2 * 1024, context: 5, truncateOver: 2 * 1024, truncateKeep: 100 };
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** A line longer than 2 KiB (in UTF-8) with its middle elided, as Bun does. */
function truncateLine(line: string): string {
  const bytes = utf8.encode(line);
  if (bytes.length <= DIFF.truncateOver) return line;
  const cont = (i: number) => i < bytes.length && (bytes[i] & 0xc0) === 0x80;
  let head = DIFF.truncateKeep;
  let tail = bytes.length - DIFF.truncateKeep;
  while (head > 0 && cont(head)) head--;
  while (cont(tail)) tail++;
  return `${fromUtf8.decode(bytes.subarray(0, head))}... (${tail - head} bytes truncated) ...${fromUtf8.decode(bytes.subarray(tail))}`;
}

/** A piece of a row (UTF-8), each of its lines cut on its own; a line break goes on in a new row after `prefix`. */
const piece = (bytes: Uint8Array, prefix: string) => fromUtf8.decode(bytes).split("\n").map(truncateLine).join(`\n${prefix}`);

/**
 * A change: the rows of what it removes, then of what it inserts. Bun diffs the two by character to colour what
 * changed; without colours, that shows only where a line over 2 KiB is cut, as it cuts each piece (changed or not) on
 * its own. The pieces here: the start both share, the middle, the end both share (Bun's character diff can find more).
 */
function modified(removed: string, inserted: string, removedPrefix: string, insertedPrefix: string): string {
  const r = utf8.encode(removed);
  const i = utf8.encode(inserted);
  const whole = () => `${removedPrefix}${piece(r, removedPrefix)}\n${insertedPrefix}${piece(i, insertedPrefix)}`;
  const larger = Math.max(r.length, i.length);
  if (larger > 30 && Math.min(r.length, i.length) * 3 < larger) return whole();
  const long = (text: string) => text.split("\n").some((l) => utf8.encode(l).length > DIFF.truncateOver);
  if (!long(removed) && !long(inserted)) return whole();
  const cont = (b: Uint8Array, at: number) => at < b.length && (b[at] & 0xc0) === 0x80;
  let p = 0;
  while (p < r.length && p < i.length && r[p] === i[p]) p++;
  while (p > 0 && (cont(r, p) || cont(i, p))) p--;
  let s = 0;
  while (s < r.length - p && s < i.length - p && r[r.length - 1 - s] === i[i.length - 1 - s]) s++;
  while (s > 0 && (cont(r, r.length - s) || cont(i, i.length - s))) s--;
  // Most of a side changed: Bun doesn't highlight it.
  const most = (b: Uint8Array) => b.length - p - s > 10 && b.length - p - s > Math.floor(b.length / 3) * 2;
  if (most(r) || most(i)) return whole();
  const side = (b: Uint8Array, prefix: string) =>
    prefix + [b.subarray(0, p), b.subarray(p, b.length - s), b.subarray(b.length - s)].filter((x) => x.length).map((x) => piece(x, prefix)).join("");
  return `${side(r, removedPrefix)}\n${side(i, insertedPrefix)}`;
}

type Segment = { kind: "equal"; lines: string[] } | { kind: "change"; removed: string[]; inserted: string[] } | { kind: "skipped"; count: number };

/**
 * Bun's line diff of two texts: every line, `- ` for the expected side and `+ ` for the received one, then the
 * `- Expected  - n` / `+ Received  + n` totals. Over 2 KiB, only 5 lines of context around each change remain, under
 * hunk headers (`@@ -2,3 +2,6 @@`). From a line-level LCS; two single lines are `Expected:` and `Received:`.
 */
function diffText(expectedText: string, receivedText: string): string {
  if (!expectedText.includes("\n") && !receivedText.includes("\n")) return modified(expectedText, receivedText, "Expected: ", "Received: ");
  const a = expectedText.split("\n");
  const b = receivedText.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  // Runs of equal lines, and between them each change: what it removes, then what it inserts.
  let segments: Segment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const s = segments.at(-1);
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (s?.kind === "equal") s.lines.push(a[i]);
      else segments.push({ kind: "equal", lines: [a[i]] });
      i++;
      j++;
      continue;
    }
    const change = s?.kind === "change" ? s : (segments[segments.push({ kind: "change", removed: [], inserted: [] }) - 1] as Segment & { kind: "change" });
    if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) change.removed.push(a[i++]);
    else change.inserted.push(b[j++]);
  }
  if (utf8.encode(expectedText).length > DIFF.chunkOver || utf8.encode(receivedText).length > DIFF.chunkOver) {
    // Only the context next to each change remains of an equal run.
    const n = segments.length;
    segments = segments.flatMap((s, k): Segment[] => {
      if (s.kind !== "equal") return [s];
      const head = k > 0 ? DIFF.context : 0;
      const tail = k + 1 < n ? DIFF.context : 0;
      if (s.lines.length <= head + tail) return [s];
      return [
        ...(head ? [{ kind: "equal" as const, lines: s.lines.slice(0, head) }] : []),
        { kind: "skipped" as const, count: s.lines.length - head - tail },
        ...(tail ? [{ kind: "equal" as const, lines: s.lines.slice(-tail) }] : []),
      ];
    });
  }
  const rows: string[] = [];
  const add = (prefix: string, lines: string[]) => lines.forEach((l) => rows.push(`${prefix}${truncateLine(l)}`));
  let oldLine = 1;
  let newLine = 1;
  let minus = 0;
  let plus = 0;
  // A hunk header starts each group of rows after elided lines (and the first, if any were elided).
  let header = segments.some((s) => s.kind === "skipped");
  for (const [k, s] of segments.entries()) {
    if (s.kind === "skipped") {
      header = true;
      oldLine += s.count;
      newLine += s.count;
      continue;
    }
    if (header) {
      header = false;
      let nOld = 0;
      let nNew = 0;
      for (const t of segments.slice(k)) {
        if (t.kind === "skipped") break;
        nOld += t.kind === "equal" ? t.lines.length : t.removed.length;
        nNew += t.kind === "equal" ? t.lines.length : t.inserted.length;
      }
      rows.push(`@@ -${oldLine},${nOld} +${newLine},${nNew} @@`);
    }
    if (s.kind === "equal") {
      add("  ", s.lines);
      oldLine += s.lines.length;
      newLine += s.lines.length;
    } else {
      if (s.removed.length && s.inserted.length) rows.push(modified(s.removed.join("\n"), s.inserted.join("\n"), "- ", "+ "));
      else add(s.removed.length ? "- " : "+ ", s.removed.length ? s.removed : s.inserted);
      oldLine += s.removed.length;
      newLine += s.inserted.length;
      minus += s.removed.length;
      plus += s.inserted.length;
    }
  }
  return `${rows.join("\n")}\n\n- Expected  - ${minus}\n+ Received  + ${plus}`;
}
const diff = (expected: unknown, received: unknown) => diffText(pretty(expected), pretty(received));

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

type Result = { pass: boolean; expected?: unknown; received?: unknown; label?: string; rlabel?: string; diff?: boolean; noArg?: boolean; custom?: { args: string; message: string } };
type Ctx = { mode?: "resolves" | "rejects"; not?: boolean };
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

const matchers: Record<string, (r: any, ...a: any[]) => Result | ((ctx: Ctx) => Result | Promise<Result>)> = {
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
const returnsOf = (v: unknown) => {
  callsOf(v);
  return (v as { mock: { results: { type: string; value: unknown }[] } }).mock.results.filter((x) => x.type === "return").map((x) => x.value);
};
const sizeOf = (v: unknown) =>
  typeof v === "string" || Array.isArray(v) ? v.length : v instanceof Map || v instanceof Set ? v.size : v !== null && typeof v === "object" ? Object.keys(v).length : undefined;
Object.assign(matchers, {
  toBeEmpty: (r: unknown) => ({ pass: sizeOf(r) === 0, received: r, label: "Expected empty" }),
  toBeOneOf: (r: unknown, e: unknown[]) => ({ pass: [...e].some((x) => equals(x, r)), expected: e, received: r, label: "Expected one of" }),
  toSatisfy: (r: unknown, fn: (v: unknown) => unknown) => ({ pass: !!fn(r), received: r, label: "Expected to satisfy" }),
  toStartWith: (r: unknown, e: string) => ({ pass: typeof r === "string" && r.startsWith(e), expected: e, received: r, label: "Expected to start with" }),
  toEndWith: (r: unknown, e: string) => ({ pass: typeof r === "string" && r.endsWith(e), expected: e, received: r, label: "Expected to end with" }),
  toInclude: (r: unknown, e: string) => ({ pass: typeof r === "string" && r.includes(e), expected: e, received: r, label: "Expected to include" }),
  toBeArray: (r: unknown) => ({ pass: Array.isArray(r), received: r, label: "Expected array" }),
  toBeArrayOfSize: (r: unknown, n: number) => ({ pass: Array.isArray(r) && r.length === n, expected: n, received: lenOf(r), label: "Expected array of size" }),
  toBeString: (r: unknown) => ({ pass: typeof r === "string", received: r, label: "Expected string" }),
  toBeNumber: (r: unknown) => ({ pass: typeof r === "number", received: r, label: "Expected number" }),
  toBeInteger: (r: unknown) => ({ pass: Number.isInteger(r), received: r, label: "Expected integer" }),
  toBeBoolean: (r: unknown) => ({ pass: typeof r === "boolean", received: r, label: "Expected boolean" }),
  toBeFunction: (r: unknown) => ({ pass: typeof r === "function", received: r, label: "Expected function" }),
  toBeObject: (r: unknown) => ({ pass: r !== null && typeof r === "object", received: r, label: "Expected object" }),
  toHaveReturned: (r: unknown) => ({ pass: returnsOf(r).length > 0, received: returnsOf(r).length, label: "Expected number of returns >= 1\nReceived number of returns" }),
  toHaveReturnedTimes: (r: unknown, n: number) => ({ pass: returnsOf(r).length === n, expected: n, received: returnsOf(r).length, label: "Expected number of returns", rlabel: "Received number of returns" }),
  toHaveReturnedWith: (r: unknown, e: unknown) => ({ pass: returnsOf(r).some((v) => equals(v, e)), expected: e, received: returnsOf(r) }),
  toHaveLastReturnedWith: (r: unknown, e: unknown) => ({ pass: equals(returnsOf(r).at(-1), e), expected: e, received: returnsOf(r).at(-1) }),
  toHaveNthReturnedWith: (r: unknown, n: number, e: unknown) => ({ pass: equals(returnsOf(r)[n - 1], e), expected: e, received: returnsOf(r)[n - 1] }),
});

// ---- snapshots ----

/** The test file being run, its snapshots, and the name of the test running (`describe` names and its own, by spaces). */
let snapshots: SnapshotFile | undefined;
let testName = "";
const snapCounts: SnapshotCounts = { passed: 0, added: 0, failed: 0 };
const isCI = () => {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CI;
  return !!v && v !== "false" && v !== "0";
};

/** The line and column of the project file's frame in the stack (the test's call of the matcher). */
function callSite(file: string): [number, number] | undefined {
  for (const line of (new Error().stack ?? "").split("\n")) {
    const m = /(\/[^\s()]*?):(\d+):(\d+)\)?$/.exec(line);
    if (m && m[1] === `/${file}`) return [+m[2], +m[3]];
  }
}

function snapshotMatcher(name: "toMatchSnapshot" | "toMatchInlineSnapshot") {
  const inline = name === "toMatchInlineSnapshot";
  return (r: unknown, ...a: unknown[]) =>
    (ctx: Ctx): Result => {
      const fail = (message: string): never => {
        throw new ExpectError(`expect(received).${ctx.not ? "not." : ""}${name}(${ctx.not ? "" : "expected"})\n\n${message}`);
      };
      const refused = (what: string, tail: string): never => {
        throw new ExpectError(`${what} creation is disabled in CI environments unless --update-snapshots is used\nTo override, set the environment variable CI=false.\n\n${tail}`);
      };
      const received = (v: string) => `Received:${v.includes("\n") ? "\n" : " "}${v}`;
      if (ctx.not) fail("Matcher error: Snapshot matchers cannot be used with not");
      if (!snapshots) throw new Error("Snapshot matchers cannot be used outside of a test");
      // (properties?, hint) or (properties?, inline snapshot), where a string first is the hint or snapshot itself.
      const props = typeof a[0] === "object" && a[0] !== null ? a[0] : undefined;
      const text = props !== undefined ? a[1] : a[0];
      if (props !== undefined && !subset(r, props)) return { pass: false, custom: { args: "propertyMatchers", message: `Expected propertyMatchers to match properties from received object\n\nReceived: ${stringify(r)}` } };
      const value = serialize(props !== undefined ? withMatchers(r, props) : r);
      const show = (v: string) => (v.includes("\n") ? `\n${v}\n` : v);
      const mismatch = (expected: string) =>
        value.includes("\n") || expected.includes("\n") ? diffText(show(expected), show(value)) : `Expected: ${expected}\nReceived: ${value}\n`;
      const ci = isCI();
      if (inline) {
        const site = callSite(snapshots.file);
        if (typeof text !== "string") {
          if (ci && !update) refused("Inline snapshot", received(value));
          snapCounts.added++;
          if (site) snapshots.rewriteInline(site[0], site[1], value);
          return { pass: true };
        }
        const expected = dedent(text);
        if (expected === value) return (snapCounts.passed++, { pass: true });
        if (update) {
          snapCounts.passed++;
          if (site) snapshots.rewriteInline(site[0], site[1], value);
          return { pass: true };
        }
        snapCounts.failed++;
        return { pass: false, custom: { args: "expected", message: mismatch(expected) } };
      }
      const key = snapshots.key(testName, typeof text === "string" ? text : undefined);
      const res = snapshots.check(key, value, ci);
      if (res === "ok") return { pass: true };
      if (res === "ci") return refused("Snapshot", `Snapshot name: ${JSON.stringify(key)}\n${received(value)}`);
      return { pass: false, custom: { args: "expected", message: mismatch(res.expected) } };
    };
}
matchers.toMatchSnapshot = snapshotMatcher("toMatchSnapshot");
matchers.toMatchInlineSnapshot = snapshotMatcher("toMatchInlineSnapshot");
/** `bun test --update-snapshots`: new values replace the snapshots that differ. */
let update = false;

function check(name: string, recv: unknown, args: unknown[], not: boolean, ctx: Ctx): void | Promise<void> {
  expectCalls++;
  testAssertions++;
  const res = matchers[name](recv, ...args);
  const out = typeof res === "function" ? res({ ...ctx, not }) : res;
  return out instanceof Promise ? out.then((r) => verdict(name, args, not, ctx, r)) : verdict(name, args, not, ctx, out);
}

function verdict(name: string, args: unknown[], not: boolean, ctx: Ctx, res: Result) {
  if (res.pass !== not) return;
  if (res.custom) throw new ExpectError(`expect(received).${name}(${res.custom.args})\n\n${res.custom.message}`);
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

class AssertionError extends Error {
  name = "AssertionError";
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
              return check(name, v, args, not, { mode });
            },
            (e) => {
              if (mode === "resolves") throw new ExpectError(`Expected promise that resolves\nReceived promise that rejected: ${pretty(e)}`);
              return check(name, e, args, not, { mode });
            },
          );
        };
      },
    },
  );
}

// ---- expect.extend, expect.assertions ----

/** The matcher's parameters after the received value, as Bun prints them in the failure's first line: `(lo, hi)`. */
function argNames(fn: Function): string {
  const src = Function.prototype.toString.call(fn);
  const open = src.indexOf("(");
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    if ("([{".includes(src[end])) depth++;
    else if (")]}".includes(src[end]) && --depth === 0) break;
  }
  const parts: string[] = [];
  let part = "";
  depth = 0;
  for (const ch of src.slice(open + 1, end)) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) (parts.push(part), (part = ""));
    else part += ch;
  }
  if (part.trim()) parts.push(part);
  return parts
    .slice(1)
    .map((x) => x.replace(/=[^]*$/, "").trim())
    .join(", ");
}

/** Bun's `pretty-format` look, as `this.utils.stringify` prints: plain keys, one entry per line, trailing commas. */
function stringify(v: unknown, ind = "", seen: unknown[] = []): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object" || v === null) return typeof v === "function" ? `[Function ${v.name || "anonymous"}]` : typeof v === "bigint" ? `${v}n` : String(v);
  if (seen.includes(v)) return "[Circular]";
  const proto = Object.getPrototypeOf(v);
  const isArr = Array.isArray(v);
  if (!isArr && proto !== Object.prototype && proto !== null) return inspect(v, { depth: 2 });
  const inner = [...seen, v];
  const entries = isArr ? (v as unknown[]).map((x) => stringify(x, ind + "  ", inner)) : Object.keys(v).map((k) => `${k}: ${stringify((v as Record<string, unknown>)[k], ind + "  ", inner)}`);
  const [open, close] = isArr ? ["[", "]"] : ["{", "}"];
  return entries.length ? `${open}\n${entries.map((e) => `${ind}  ${e},\n`).join("")}${ind}${close}` : `${open}${close}`;
}

/** `this.utils` of a custom matcher: the printing helpers of Jest's `expect-utils` that matchers use most. */
const matcherUtils = {
  stringify: (v: unknown) => stringify(v),
  printReceived: (v: unknown) => stringify(v),
  printExpected: (v: unknown) => stringify(v),
  matcherHint: (name: string, received = "received", expected = "expected", opts?: { isNot?: boolean; promise?: string }) =>
    `expect(${received})${opts?.promise ? `.${opts.promise}` : ""}${opts?.isNot ? ".not" : ""}.${name}(${expected})`,
  diff: (a: unknown, b: unknown) => (typeof a === "object" && a !== null ? diff(a, b) : null),
  equals: (a: unknown, b: unknown) => equals(a, b),
};

function extend(defs: Record<string, Function>) {
  for (const [name, fn] of Object.entries(defs)) {
    if (typeof fn !== "function") throw new TypeError(`expect.extend: \`${name}\` is not a valid matcher. Must be a function, is "${typeof fn}"`);
    const names = argNames(fn);
    const self = (ctx: Ctx) => ({ isNot: !!ctx.not, promise: ctx.mode ?? "", equals: (a: unknown, b: unknown) => equals(a, b), utils: matcherUtils });
    matchers[name] = (r, ...a) => (ctx) => {
      const settle = (v: { pass: boolean; message?: string | (() => string) }): Result => {
        if (typeof v !== "object" || v === null || typeof v.pass !== "boolean") throw new TypeError("Unexpected return from matcher function.\nMatcher functions should return an object in the following format:\n  {message?: string | function, pass: boolean}");
        const msg = typeof v.message === "function" ? v.message() : v.message;
        return { pass: v.pass, custom: { args: names, message: msg ?? "No message was specified for this matcher." } };
      };
      const v = fn.call(self(ctx), r, ...a);
      return v instanceof Promise ? v.then(settle) : settle(v);
    };
    (expect as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => new Asym(`Custom<${name}>`, (v) => !!(matchers[name](v, ...a) as (c: Ctx) => Result)({}).pass);
  }
}

/** Assertions the running test made so far, and what `expect.assertions` / `hasAssertions` asked of it. */
let testAssertions = 0;
let expectedAssertions: number | undefined;
let needAssertions = false;

const expect = Object.assign((actual: unknown) => makeExpect(actual) as Record<string, any>, {
  anything: () => new Asym("Anything", (v) => v !== null && v !== undefined),
  any: (c: Function) =>
    new Asym(`Any<${c.name}>`, (v) => (c === String ? typeof v === "string" : c === Number ? typeof v === "number" : c === Boolean ? typeof v === "boolean" : c === Function ? typeof v === "function" : v instanceof c)),
  extend,
  assertions: (n: number) => void (expectedAssertions = n),
  hasAssertions: () => void (needAssertions = true),
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
/** The path of the project file whose code is running (the first frame the stacks don't hide), for resolving a relative specifier. */
function callerPath(): string {
  for (const line of (new Error().stack ?? "").split("\n")) {
    const m = /(\/[^\s()]*?):\d+:\d+\)?$/.exec(line);
    if (m) return m[1];
  }
  return "/";
}
/** `mock.module(specifier, factory)`: imports of the module that follow (and requires) get what the factory returns. */
mock.module = (spec: string, factory: () => object) => {
  const g = globalThis as { __mockModule?: (spec: string, from: string, exports: object) => void };
  if (!g.__mockModule) throw new Error("mock.module() is not supported here");
  g.__mockModule(spec, callerPath(), factory());
};
const jest = { fn: mock, spyOn, mock: mock.module, ...fakeTimers };
const vi = { fn: mock, spyOn, mock: mock.module, ...fakeTimers };

// ---- registration ----

/** `%s %d %i %f %j %o %p %#` and `$prop` in `.each` titles. */
function title(t: string, row: unknown, idx: number): string {
  const args = Array.isArray(row) ? [...row] : [row];
  let out = t.replace(/%([sdifjop#%])/g, (m, c: string) => (c === "%" ? "%" : c === "#" ? String(idx) : m === "%%" ? "%" : args.length ? (c === "s" ? String(args.shift()) : c === "d" || c === "i" || c === "f" ? String(Number(args.shift())) : pretty(args.shift())) : m));
  if (row && typeof row === "object" && !Array.isArray(row)) out = out.replace(/\$(\w+)/g, (m, k: string) => (k in row ? String((row as Record<string, unknown>)[k]) : m));
  return out;
}

function defineTest(name: string, fn: Fn | undefined, flags: Flags, opts?: number | { timeout?: number }) {
  const timeout = typeof opts === "number" ? opts : (opts?.timeout ?? defaultTimeout);
  current.items.push({ kind: "case", name, fn: fn ?? (() => {}), body: !!fn, mode: fn || flags.mode === "todo" ? flags.mode : "todo", timeout, failing: flags.failing });
}

function defineSuite(name: string, fn: () => void, flags: Flags) {
  const s = newSuite(name, current, flags.mode);
  current.items.push(s);
  const prev = current;
  current = s;
  try {
    fn();
  } finally {
    current = prev;
  }
}

/**
 * `test`/`describe` with `.skip`, `.only`, `.todo`, `.failing`, `.concurrent`, `.serial` (each chaining into the others),
 * `.each`, `.if`, `.skipIf`, `.todoIf`.
 */
function api<A extends unknown[]>(define: (name: string, fn: any, flags: Flags, ...rest: A) => void) {
  const make = (flags: Flags): any => {
    const mode = (m: Mode) => make({ ...flags, mode: m });
    const call = (name: string, fn: any, ...rest: A) => define(name, fn, flags, ...rest);
    const each = (rows: unknown[]) => (name: string, fn: (...a: any[]) => unknown, ...rest: A) =>
      rows.forEach((row, i) => define(title(name, row, i), Array.isArray(row) ? () => fn(...row) : () => fn(row), flags, ...rest));
    const lazy = (get: () => unknown) => ({ get, enumerable: true });
    return Object.defineProperties(call, {
      skip: lazy(() => mode("skip")),
      only: lazy(() => mode("only")),
      todo: lazy(() => mode("todo")),
      failing: lazy(() => make({ ...flags, failing: true })),
      concurrent: lazy(() => make(flags)),
      serial: lazy(() => make(flags)),
      each: { value: each },
      if: { value: (c: boolean) => (c ? make(flags) : mode("skip")) },
      skipIf: { value: (c: boolean) => (c ? mode("skip") : make(flags)) },
      todoIf: { value: (c: boolean) => (c ? mode("todo") : make(flags)) },
    });
  };
  return make({ mode: "run", failing: false });
}

type Api = {
  (name: string, fn?: any, ...rest: any[]): void;
  skip: Api; only: Api; todo: Api; failing: Api; concurrent: Api; serial: Api;
  each: (rows: unknown[]) => (name: string, fn: (...a: any[]) => unknown, ...rest: any[]) => void;
  if: (c: boolean) => Api; skipIf: (c: boolean) => Api; todoIf: (c: boolean) => Api;
};
const test: Api = api(defineTest);
const describe: Api = api(defineSuite);
const hook = (h: Hook) => (fn: Fn) => void current.hooks[h].push(fn);

// ---- running ----

/**
 * Where the report goes: the console (the run's own), or, in a spawned `bun test` (runtime.ts), its stdout (the version
 * line) and stderr (the rest) as Bun writes them to a pipe.
 */
let report = { log: (text: string) => console.log(text), error: (text: string) => console.error(text) };
export function setReport(r: typeof report) {
  report = r;
}

const paint = (n: number, s: string) => `\x1b[${n}m${s}\x1b[0m`;
const dim = (s: string) => paint(90, s);
const ms = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(2)}s` : `${t.toFixed(2)}ms`);

const hasOnly = (s: Suite): boolean => s.mode === "only" || s.items.some((i) => i.mode === "only" || (i.kind === "suite" && hasOnly(i)));

/** Ends the callback running now (a test or a hook) with an error; see `failRunning`. */
let failCurrent: ((err: unknown) => void) | undefined;

/**
 * An uncaught error or unhandled rejection while `bun test` runs: as in Bun, it fails the test (or hook) running now,
 * whichever callback threw it. False between tests, where Bun lets it go.
 */
export function failRunning(err: unknown): boolean {
  if (!failCurrent) return false;
  failCurrent(err ?? new Error("thrown undefined"));
  return true;
}

/** node:test's `t.skip()` and `t.todo()` (nodeTest.ts): the running test counts as skipped or todo once it ends. */
let runningMark: "skip" | "todo" | undefined;
export const markRunning = (mark: "skip" | "todo") => void (runningMark = mark);
/** The test file loading or running now (relative to the project), for node:test's `filePath`. */
let currentFile = "";
export const testFile = () => currentFile;

/** A callback that ran past its timeout: a test reports it as Bun does, under its name. */
class Timeout extends Error {
  constructor(readonly ms: number) {
    super(`test timed out after ${ms}ms`);
  }
}

/** Runs one callback with `done` support and a timeout. */
function call(fn: Fn, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = real.setTimeout(() => finish(new Timeout(timeout)), timeout);
    const finish = (err?: unknown) => {
      real.clearTimeout(timer);
      if (failCurrent === finish) failCurrent = undefined;
      err ? reject(err) : resolve();
    };
    failCurrent = finish;
    try {
      if (fn.length > 0) fn(finish);
      else Promise.resolve(fn()).then(() => finish(), finish);
    } catch (e) {
      finish(e ?? new Error("thrown undefined"));
    }
  });
}

/** `filtered`: tests `-t` left out. */
type Totals = { pass: number; fail: number; skip: number; todo: number; filtered: number };
const totals: Totals = { pass: 0, fail: 0, skip: 0, todo: 0, filtered: 0 };

/** What the run's flags ask (testArgs.ts): `-t`, `--bail`, `--todo`, `--only`. */
let runOpts: Pick<TestOptions, "namePattern" | "bail" | "todo" | "only"> = { todo: false, only: false };
/** What `--bail` throws once the run has failed often enough. */
const BAIL = Symbol("bail");
/** A failure: counted, and with `--bail`, the end of the run once there are enough. */
function countFailure() {
  totals.fail++;
  if (runOpts.bail && totals.fail >= runOpts.bail) throw BAIL;
}

/** How Bun reports what failed a test: an error as its printer has it (source, own properties, frames, cause). */
function failure(e: unknown): string {
  if (e instanceof ExpectError) return `error: ${e.message}`;
  if (e instanceof Error) return formatLog([e], "error").replace(/\n+$/, "");
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
    // In a file with `.only` tests (any file, with `--only`), the others don't run or count, as in Bun; `-t` filters
    // the rest, counted as filtered out.
    if (only && item.mode !== "only" && !ancestors.some((a) => a.mode === "only")) continue;
    if (runOpts.namePattern && !runOpts.namePattern.test([...names(s), item.name].join(" "))) {
      totals.filtered++;
      continue;
    }
    if (skipAll || s.mode === "skip" || item.mode === "skip") {
      totals.skip++;
      report.log(dim(`» ${label(item)}`));
      continue;
    }
    // `--todo`: a todo test with a body runs, and fails if it passes.
    const todoRun = (item.mode === "todo" || todo) && runOpts.todo && item.body;
    if ((item.mode === "todo" || todo) && !todoRun) {
      totals.todo++;
      report.log(`\x1b[35m✎\x1b[0m ${label(item)} ${dim("[todo]")}`);
      continue;
    }
    testName = [...names(s), item.name].join(" ");
    const t0 = performance.now();
    let err: unknown;
    let failed = false;
    testAssertions = 0;
    expectedAssertions = undefined;
    needAssertions = false;
    let threw = false;
    runningMark = undefined;
    try {
      for (const a of ancestors) if (!started && a === s) for (const h of a.hooks.beforeAll) await call(h, defaultTimeout);
      started = true;
      for (const a of ancestors) for (const h of a.hooks.beforeEach) await call(h, defaultTimeout);
      try {
        await call(item.fn, item.timeout);
        if (expectedAssertions !== undefined && testAssertions !== expectedAssertions) {
          throw new AssertionError(`expected ${expectedAssertions} assertion${expectedAssertions === 1 ? "" : "s"}, but test ended with ${testAssertions} assertion${testAssertions === 1 ? "" : "s"}`);
        }
        if (needAssertions && testAssertions === 0) throw new AssertionError("received 0 assertions, but expected at least one assertion to be called");
      } catch (e) {
        // `.failing`: the test is meant to throw; the afterEach hooks run all the same.
        if (!item.failing) throw e;
        threw = true;
      } finally {
        for (const a of [...ancestors].reverse()) for (const h of a.hooks.afterEach) await call(h, defaultTimeout);
      }
    } catch (e) {
      (failed = true), (err = e);
    }
    const time = dim(`[${ms(performance.now() - t0)}]`);
    const mark = runningMark;
    runningMark = undefined;
    if (mark === "skip") {
      totals.skip++;
      report.log(dim(`» ${label(item)}`));
    } else if (mark === "todo") {
      totals.todo++;
      report.log(`\x1b[35m✎\x1b[0m ${label(item)} ${dim("[todo]")}`);
    } else if (todoRun && failed) {
      totals.todo++;
      report.error(`${failure(err)}\n\x1b[35m✎\x1b[0m ${label(item)} ${time}`);
    } else if (todoRun) {
      report.error(`\x1b[31m✗\x1b[0m\x1b[31m ${label(item)}\x1b[0m ${time}\n  ^ this test is marked as todo but passes. Remove \`.todo\` if tested behavior now works`);
      countFailure();
    } else if (item.failing && !threw && !failed) {
      report.error(`\x1b[31m✗\x1b[0m\x1b[31m ${label(item)}\x1b[0m\n  ^ this test is marked as failing but it passed. Remove \`.failing\` if tested behavior now works`);
      countFailure();
    } else if (failed && err instanceof Timeout && err.ms === item.timeout) {
      report.error(`\x1b[31m✗\x1b[0m\x1b[31m ${label(item)}\x1b[0m ${time}\n  ^ this test timed out after ${err.ms}ms.`);
      countFailure();
    } else if (failed) {
      report.error(`${failure(err)}\n\x1b[31m✗\x1b[0m\x1b[31m ${label(item)}\x1b[0m ${time}`);
      countFailure();
    } else {
      totals.pass++;
      report.log(`\x1b[32m✓\x1b[0m ${label(item)} ${time}`);
    }
  }
  if (started) for (const h of s.hooks.afterAll) await call(h, defaultTimeout).catch((e) => (report.error(`${failure(e)}\n\x1b[31m✗\x1b[0m\x1b[31m ${names(s).join(" > ")} (afterAll)\x1b[0m`), countFailure()));
}

/** Snapshot files in the project, through the worker's `fs`. */
async function fsIO(): Promise<SnapshotIO> {
  const { default: fs } = await import("./fs");
  return {
    read: (p) => (fs.existsSync(`/${p}`) ? (fs.readFileSync(`/${p}`, "utf8") as string) : undefined),
    write: (p, text) => {
      fs.mkdirSync(`/${p}`.replace(/\/[^/]*$/, "") || "/", { recursive: true });
      fs.writeFileSync(`/${p}`, text);
    },
  };
}

/** Failed tests in all, and per file in the order they ran. */
export type TestOutcome = { failed: number; results: { file: string; failed: number }[]; coverageFailed?: boolean };

/**
 * Loads each file (its top level registers suites in `bun:test`), runs it and prints Bun's report.
 * Resolves to the number of failed tests, in all and per file (import errors count as failures).
 */
export async function runTestFiles(
  files: string[],
  load: (file: string) => Promise<unknown>,
  version: string,
  opts: Partial<TestOptions> & { io?: SnapshotIO; preload?: () => string[]; coverage?: () => boolean } = {},
): Promise<TestOutcome> {
  update = !!opts.update;
  runOpts = { namePattern: opts.namePattern, bail: opts.bail, todo: !!opts.todo, only: !!opts.only };
  if (opts.timeout !== undefined) defaultTimeout = opts.timeout;
  snapCounts.passed = snapCounts.added = snapCounts.failed = 0;
  const io = opts.io ?? (await fsIO());
  const t0 = performance.now();
  resetFakeTimers();
  totals.pass = totals.fail = totals.skip = totals.todo = totals.filtered = 0;
  expectCalls = 0;
  const results: TestOutcome["results"] = [];
  report.log(`bun test v${version.replace(/-.*/, "")}`);
  // bunfig.toml's `[test] preload`: resolved up front, run with the first file. Its hooks are global: `beforeEach` and
  // `afterEach` around every test, `beforeAll` before the first file's tests, `afterAll` after the last file's.
  let preloads: string[] = [];
  try {
    preloads = opts.preload?.() ?? [];
  } catch (e) {
    report.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return { failed: 1, results };
  }
  const global = newSuite("");
  let globalStarted = false;
  const globalHook = (hook: "beforeAll" | "afterAll") =>
    (async () => {
      for (const h of global.hooks[hook]) await call(h, defaultTimeout);
    })().catch((e) => (totals.fail++, report.error(`${failure(e)}\n\x1b[31m✗\x1b[0m\x1b[31m (${hook})\x1b[0m`)));
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const ran = () => totals.pass + totals.fail + totals.skip + totals.todo;
  const runs = Math.max(1, opts.rerunEach ?? 1);
  let started = 0;
  try {
    for (const file of files) {
      started++;
      currentFile = file;
      snapshots = new SnapshotFile(io, file, update, snapCounts);
      const before = totals.fail;
      // `--rerun-each`: the tests the file registered run that many times.
      for (let run = 1; run <= runs; run++) {
        report.log(`\n${file}:${runs > 1 ? ` (run #${run})` : ""}`);
        if (run === 1) {
          try {
            if (preloads.length) {
              root = current = global;
              for (const p of preloads.splice(0)) await load(p);
            }
            root = current = newSuite("", global);
            await load(file);
          } catch (e) {
            report.error(`${failure(e)}\n\x1b[31m✗\x1b[0m\x1b[31m ${file}\x1b[0m`);
            results.push({ file, failed: 1 });
            countFailure();
            break;
          }
          if (!globalStarted) (globalStarted = true), await globalHook("beforeAll");
        }
        await runSuite(root, runOpts.only || hasOnly(root), false);
      }
      // (A file that didn't load leaves its snapshot file as it is.)
      if (results.at(-1)?.file === file) continue;
      snapshots.flush();
      results.push({ file, failed: totals.fail - before });
    }
  } catch (e) {
    if (e !== BAIL) throw e;
    // `--bail`: no summary, as in Bun, but how far it got.
    report.log(`Ran ${plural(ran(), "test")} across ${plural(started, "file")}. ${dim(`[${ms(performance.now() - t0)}]`)}`);
    report.error(`Bailed out after ${plural(totals.fail, "failure")}`);
    resetFakeTimers();
    return { failed: totals.fail, results };
  }
  if (globalStarted) await globalHook("afterAll");
  const n = ran();
  if (runOpts.namePattern && !n) {
    report.log("");
    report.error(`error: regex ${JSON.stringify(runOpts.namePattern.source)} matched 0 tests. Searched ${plural(files.length, "file")} (skipping ${plural(totals.filtered, "test")}) ${dim(`[${ms(performance.now() - t0)}]`)}`);
    resetFakeTimers();
    return { failed: 1, results };
  }
  // `--coverage`: its table goes before the summary.
  const coverageFailed = opts.coverage?.() ?? false;
  const row = (count: number, word: string) => (count ? ` ${count} ${word}` : "");
  report.log("");
  report.log(paint(32, ` ${totals.pass} pass`));
  // Bun counts the tests `-t` left out only where none was skipped.
  for (const [c, w] of [[totals.skip, "skip"], [totals.skip ? 0 : totals.filtered, "filtered out"], [totals.todo, "todo"]] as const) if (c) report.log(row(c, w));
  if (totals.fail) report.error(` ${totals.fail} fail`);
  else report.log(" 0 fail");
  const { passed, added, failed } = snapCounts;
  if (passed + added + failed) {
    const parts = [passed && `${passed} passed`, added && (passed || failed ? `${added} added` : `+${added} added`), failed && `${failed} failed`].filter(Boolean);
    report.log(`snapshots: ${parts.join(", ")}`);
  }
  if (expectCalls) report.log(` ${expectCalls} expect() calls`);
  report.log(`Ran ${plural(n, "test")} across ${plural(files.length, "file")}. ${dim(`[${ms(performance.now() - t0)}]`)}`);
  resetFakeTimers();
  return { failed: totals.fail, results, ...(coverageFailed && { coverageFailed }) };
}

export default {
  describe,
  test,
  it: test,
  expect,
  mock,
  spyOn,
  jest,
  vi,
  setSystemTime: fakeTimers.setSystemTime,
  beforeAll: hook("beforeAll"),
  beforeEach: hook("beforeEach"),
  afterEach: hook("afterEach"),
  afterAll: hook("afterAll"),
  setDefaultTimeout: (t: number) => void (defaultTimeout = t),
};
