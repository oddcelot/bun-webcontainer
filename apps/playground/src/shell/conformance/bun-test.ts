// The part of bun:test Bun's shell tests use, collecting tests for run.ts.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export class SkipError extends Error {}
export type Case = { name: string; file: string; fn: () => unknown; skip?: string };
export const cases: Case[] = [];
export const hooks = { beforeAll: [] as (() => unknown)[], afterAll: [] as (() => unknown)[], beforeEach: [] as (() => unknown)[], afterEach: [] as (() => unknown)[] };
const prefix: string[] = [];
let skipping: string | undefined;
export let currentFile = "";
export const setFile = (f: string) => void (currentFile = f);

export function describe(name: string, fn: () => void) {
  prefix.push(name);
  try {
    fn();
  } finally {
    prefix.pop();
  }
}
const skipDescribe = (reason: string) => (name: string, fn: () => void) => {
  const was = skipping;
  skipping = reason;
  describe(name, fn);
  skipping = was;
};
describe.todo = skipDescribe("todo");
describe.skip = skipDescribe("skip");
describe.if = (cond: unknown) => (cond ? describe : skipDescribe("if"));
describe.skipIf = (cond: unknown) => (cond ? skipDescribe("skipIf") : describe);
describe.each = (rows: unknown[]) => (name: string, fn: (...a: any[]) => void) => rows.forEach((r) => describe(fmt(name, r), () => fn(...(Array.isArray(r) ? r : [r]))));
describe.concurrent = describe;

const fmt = (name: string, row: unknown) => {
  const args = Array.isArray(row) ? row : [row];
  let i = 0;
  return name.replace(/%[sdpij]/g, () => String(args[i++]));
};

export function test(name: string, fn: () => unknown, _timeout?: unknown) {
  cases.push({ name: [...prefix, name].join(" > "), file: currentFile, fn, skip: skipping });
}
const skipTest = (reason: string) => (name: string, fn: () => unknown) => cases.push({ name: [...prefix, name].join(" > "), file: currentFile, fn, skip: reason });
test.todo = skipTest("todo");
test.skip = skipTest("skip");
test.failing = skipTest("failing");
test.if = (cond: unknown) => (cond ? test : skipTest("if"));
test.skipIf = (cond: unknown) => (cond ? skipTest("skipIf") : test);
test.todoIf = (cond: unknown) => (cond ? skipTest("todo") : test);
test.each = (rows: unknown[]) => (name: string, fn: (...a: any[]) => unknown) => rows.forEach((r) => test(fmt(name, r), () => fn(...(Array.isArray(r) ? r : [r]))));
test.concurrent = test;
test.serial = test;
export const it = test;
export const beforeAll = (fn: () => unknown) => hooks.beforeAll.push(fn);
export const afterAll = (fn: () => unknown) => hooks.afterAll.push(fn);
export const beforeEach = (fn: () => unknown) => hooks.beforeEach.push(fn);
export const afterEach = (fn: () => unknown) => hooks.afterEach.push(fn);
export const setDefaultTimeout = () => {};

const str = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));
function matchers(actual: any, not: boolean) {
  const check = (ok: boolean, msg: () => string) => {
    if (ok === not) throw new assert.AssertionError({ message: (not ? "not " : "") + msg() });
  };
  return {
    toBe: (e: unknown) => check(Object.is(actual, e), () => `expected ${str(actual)} to be ${str(e)}`),
    toEqual: (e: unknown) => check(isDeepStrictEqual(norm(actual), norm(e)), () => `expected ${str(JSON.stringify(actual))} to equal ${str(JSON.stringify(e))}`),
    toStrictEqual: (e: unknown) => check(isDeepStrictEqual(actual, e), () => `expected ${str(actual)} to strictly equal ${str(e)}`),
    toContain: (e: unknown) => check(actual?.includes?.(e), () => `expected ${str(actual)} to contain ${str(e)}`),
    toInclude: (e: unknown) => check(actual?.includes?.(e), () => `expected ${str(actual)} to include ${str(e)}`),
    toStartWith: (e: string) => check(String(actual).startsWith(e), () => `expected ${str(actual)} to start with ${str(e)}`),
    toEndWith: (e: string) => check(String(actual).endsWith(e), () => `expected ${str(actual)} to end with ${str(e)}`),
    toMatch: (e: RegExp | string) => check(typeof e === "string" ? String(actual).includes(e) : e.test(String(actual)), () => `expected ${str(actual)} to match ${e}`),
    toBeTrue: () => check(actual === true, () => `expected ${str(actual)} to be true`),
    toBeFalse: () => check(actual === false, () => `expected ${str(actual)} to be false`),
    toBeTruthy: () => check(!!actual, () => `expected ${str(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, () => `expected ${str(actual)} to be falsy`),
    toBeUndefined: () => check(actual === undefined, () => `expected ${str(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, () => `expected a value`),
    toBeNull: () => check(actual === null, () => `expected ${str(actual)} to be null`),
    toBeInstanceOf: (c: any) => check(actual instanceof c, () => `expected an instance of ${c?.name}`),
    toBeOneOf: (list: unknown[]) => check(list.some((x) => isDeepStrictEqual(x, actual)), () => `expected ${str(actual)} to be one of ${JSON.stringify(list)}`),
    toBeGreaterThan: (n: number) => check(actual > n, () => `expected ${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n: number) => check(actual >= n, () => `expected ${actual} >= ${n}`),
    toBeLessThan: (n: number) => check(actual < n, () => `expected ${actual} < ${n}`),
    toHaveLength: (n: number) => check(actual?.length === n, () => `expected length ${n}, got ${actual?.length}`),
    toThrow: (e?: unknown) => {
      let threw: unknown;
      let did = false;
      try {
        actual();
      } catch (x) {
        did = true;
        threw = x;
      }
      const msg = (threw as Error)?.message ?? String(threw);
      const ok = did && (e === undefined || (typeof e === "string" ? msg.includes(e) : e instanceof RegExp ? e.test(msg) : typeof e === "function" ? threw instanceof (e as any) : true));
      check(ok, () => `expected a throw${e ? ` matching ${e}` : ""}, got ${did ? msg : "none"}`);
    },
    toMatchInlineSnapshot: (e?: string) => {
      if (e === undefined) throw new SkipError("snapshot without a value");
      const clean = (s: string) => s.replace(/^\n/, "").replace(/\n\s*$/, "").replace(/^"|"$/g, "");
      const lines = clean(e).split("\n");
      const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
      const want = lines.map((l) => l.slice(indent)).join("\n");
      const got = typeof actual === "string" ? actual : JSON.stringify(actual, null, 2);
      check(got.trim() === want.trim(), () => `snapshot: got ${str(got)} want ${str(want)}`);
    },
  };
}
const norm = (v: unknown): unknown => (v instanceof Uint8Array ? [...v] : v);

export function expect(actual: unknown) {
  const m = matchers(actual, false);
  const rejects = new Proxy({} as any, {
    get: (_, k) => async (...a: unknown[]) => {
      let err: unknown;
      try {
        await actual;
      } catch (e) {
        err = e;
      }
      return (matchers(() => {
        if (err) throw err;
      }, false) as any)[k === "toThrow" || k === "toThrowError" ? "toThrow" : k](...a);
    },
  });
  const resolves = new Proxy({} as any, { get: (_, k) => async (...a: unknown[]) => (matchers(await actual, false) as any)[k](...a) });
  return Object.assign(m, { not: matchers(actual, true), rejects, resolves, toThrowError: m.toThrow });
}
expect.assertions = () => {};
expect.anything = () => true;
