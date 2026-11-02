import { inspect, isDeepStrictEqual } from "./util";

class AssertionError extends Error {
  code = "ERR_ASSERTION";
  generatedMessage: boolean;
  actual: unknown;
  expected: unknown;
  operator: string;
  constructor(o: { message?: string | Error; actual?: unknown; expected?: unknown; operator?: string; generated?: string }) {
    super(typeof o.message === "string" ? o.message : (o.generated ?? "Failed"));
    this.name = "AssertionError";
    this.generatedMessage = typeof o.message !== "string";
    this.actual = o.actual;
    this.expected = o.expected;
    this.operator = o.operator ?? "fail";
  }
}

type Msg = string | Error | undefined;

function fail(message: Msg, generated: string, actual?: unknown, expected?: unknown, operator?: string): never {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message, generated, actual, expected, operator });
}

function ok(value: unknown, message?: Msg): asserts value {
  if (!value) fail(message, "The expression evaluated to a falsy value:\n\n  assert.ok(" + inspect(value) + ")\n", value, true, "==");
}

const cmp = (op: string, text: string, pass: (a: unknown, b: unknown) => boolean) => (a: unknown, b: unknown, message?: Msg) => {
  if (!pass(a, b)) fail(message, `${text}\n\n${inspect(a)} ${op} ${inspect(b)}\n`, a, b, op === "!==" ? "strictEqual" : op);
};

function matches(err: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) return expected.test(String(err));
  if (typeof expected === "function") {
    if (expected.prototype !== undefined && err instanceof (expected as new () => unknown)) return true;
    if (Error.isPrototypeOf(expected)) return false;
    return (expected as (e: unknown) => unknown).call({}, err) === true;
  }
  if (typeof expected === "object" && expected !== null) {
    for (const k of Object.keys(expected)) {
      const e = (expected as Record<string, unknown>)[k];
      const a = (err as Record<string, unknown>)?.[k];
      if (e instanceof RegExp && typeof a === "string" ? !e.test(a) : !isDeepStrictEqual(a, e)) return false;
    }
    return true;
  }
  return true;
}

function throws(fn: () => unknown, expected?: unknown, message?: Msg) {
  if (typeof expected === "string") [expected, message] = [undefined, expected];
  try {
    fn();
  } catch (err) {
    if (!matches(err, expected)) throw err;
    return;
  }
  fail(message, "Missing expected exception.", undefined, expected, "throws");
}

async function rejects(p: Promise<unknown> | (() => Promise<unknown>), expected?: unknown, message?: Msg) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (!matches(err, expected)) throw err;
    return;
  }
  fail(message, "Missing expected rejection.", undefined, expected, "rejects");
}

const assert = Object.assign(
  function assert(value: unknown, message?: Msg) {
    ok(value, message);
  },
  {
    AssertionError,
    ok,
    fail: (message?: Msg) => fail(message, "Failed"),
    equal: cmp("==", "Expected values to be loosely equal:", (a, b) => a == b || (a !== a && b !== b)),
    notEqual: cmp("!=", "Expected \"actual\" to be loosely unequal to:", (a, b) => !(a == b)),
    strictEqual: cmp("!==", "Expected values to be strictly equal:", Object.is),
    notStrictEqual: cmp("===", 'Expected "actual" to be strictly unequal to:', (a, b) => !Object.is(a, b)),
    deepEqual: cmp("deepEqual", "Expected values to be loosely deep-equal:", (a, b) => isDeepStrictEqual(a, b, false)),
    notDeepEqual: cmp("notDeepEqual", 'Expected "actual" not to be loosely deep-equal to:', (a, b) => !isDeepStrictEqual(a, b, false)),
    deepStrictEqual: cmp("deepStrictEqual", "Expected values to be strictly deep-equal:", (a, b) => isDeepStrictEqual(a, b)),
    notDeepStrictEqual: cmp("notDeepStrictEqual", 'Expected "actual" not to be strictly deep-equal to:', (a, b) => !isDeepStrictEqual(a, b)),
    throws,
    doesNotThrow(fn: () => unknown, message?: Msg) {
      try {
        fn();
      } catch (err) {
        fail(typeof message === "string" ? message : undefined, `Got unwanted exception.\nActual message: "${(err as Error)?.message}"`, err, undefined, "doesNotThrow");
      }
    },
    rejects,
    async doesNotReject(p: Promise<unknown> | (() => Promise<unknown>), message?: Msg) {
      try {
        await (typeof p === "function" ? p() : p);
      } catch (err) {
        fail(typeof message === "string" ? message : undefined, `Got unwanted rejection.\nActual message: "${(err as Error)?.message}"`, err, undefined, "doesNotReject");
      }
    },
    ifError(v: unknown) {
      if (v !== null && v !== undefined) throw v instanceof Error ? v : new AssertionError({ generated: `ifError got unwanted exception: ${inspect(v)}`, actual: v, operator: "ifError" });
    },
    match: (s: string, re: RegExp, message?: Msg) => re.test(s) || fail(message, `The input did not match the regular expression ${inspect(re)}. Input:\n\n${inspect(s)}\n`, s, re, "match"),
    doesNotMatch: (s: string, re: RegExp, message?: Msg) => !re.test(s) || fail(message, `The input was expected to not match the regular expression ${inspect(re)}. Input:\n\n${inspect(s)}\n`, s, re, "doesNotMatch"),
  },
);
const strict: any = Object.assign((v: unknown, m?: Msg) => ok(v, m), assert, { equal: assert.strictEqual, notEqual: assert.notStrictEqual, deepEqual: assert.deepStrictEqual, notDeepEqual: assert.notDeepStrictEqual });
strict.strict = strict;
(assert as any).strict = strict;

export default assert;
