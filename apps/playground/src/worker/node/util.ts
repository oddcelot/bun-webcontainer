import { codeError } from "./errors";
import { parseArgs } from "./parseArgs";

import { inspect, format, formatWithOptions, stripVTControlCharacters } from "./inspect";
import { types } from "./types";

export { inspect, format, formatWithOptions, stripVTControlCharacters };

const tag = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1);

const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");

export function promisify(fn: Function): Function {
  if (typeof fn !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "original" argument must be of type function');
  const c = (fn as { [promisifyCustom]?: Function })[promisifyCustom];
  if (c) return c;
  const p = function (this: unknown, ...args: unknown[]) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err: unknown, ...values: unknown[]) => (err ? reject(err) : resolve(values[0])));
    });
  };
  Object.setPrototypeOf(p, Object.getPrototypeOf(fn));
  return Object.defineProperties(p, Object.getOwnPropertyDescriptors(fn));
}
promisify.custom = promisifyCustom;

function callbackify(fn: Function) {
  return function (this: unknown, ...args: unknown[]) {
    const cb = args.pop() as Function;
    fn.apply(this, args).then((v: unknown) => queueMicrotask(() => cb(null, v)), (e: unknown) => queueMicrotask(() => cb(e ?? new Error("Promise was rejected with a falsy value"))));
  };
}

export function isDeepStrictEqual(a: unknown, b: unknown, strict = true, seen = new Map<unknown, unknown>()): boolean {
  if (strict ? Object.is(a, b) : a == b || (a !== a && b !== b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (tag(a) !== tag(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  const eq = (x: unknown, y: unknown) => isDeepStrictEqual(x, y, strict, seen);
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp) return String(a) === String(b) && a.lastIndex === (b as RegExp).lastIndex;
  if (a instanceof Error && (a.message !== (b as Error).message || a.name !== (b as Error).name)) return false;
  if (a instanceof Map) {
    const m = b as Map<unknown, unknown>;
    if (a.size !== m.size) return false;
    for (const [k, v] of a) if (!(m.has(k) ? eq(v, m.get(k)) : [...m].some(([k2, v2]) => eq(k, k2) && eq(v, v2)))) return false;
    return true;
  }
  if (a instanceof Set) {
    const s = b as Set<unknown>;
    if (a.size !== s.size) return false;
    for (const v of a) if (!s.has(v) && ![...s].some((v2) => eq(v, v2))) return false;
    return true;
  }
  if (ArrayBuffer.isView(a)) {
    const x = a as unknown as ArrayLike<unknown>;
    const y = b as unknown as ArrayLike<unknown>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i]) && !(!strict && x[i] == y[i])) return false;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of content.matchAll(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`|[^\n#]*)/gm)) {
    let v = m[2].trim();
    if (/^["'`]/.test(v)) v = v.slice(1, -1);
    out[m[1]] = m[2].startsWith('"') ? v.replace(/\\n/g, "\n") : v;
  }
  return out;
}

const warned = new Set<string>();

export default {
  format,
  parseArgs,
  formatWithOptions,
  inspect,
  promisify,
  callbackify,
  inherits(ctor: Function & { super_?: unknown }, superCtor: Function) {
    Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  },
  deprecate<T extends Function>(fn: T, msg: string, code?: string): T {
    return function (this: unknown, ...a: unknown[]) {
      const key = code ?? msg;
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`(node) [${code ?? "DEP"}] DeprecationWarning: ${msg}`);
      }
      return fn.apply(this, a);
    } as unknown as T;
  },
  debuglog: () => Object.assign(() => {}, { enabled: false }),
  debug: () => Object.assign(() => {}, { enabled: false }),
  types,
  isDeepStrictEqual: (a: unknown, b: unknown) => isDeepStrictEqual(a, b),
  parseEnv,
  TextEncoder,
  TextDecoder,
  stripVTControlCharacters,
  styleText: (_format: unknown, text: string) => text,
  toUSVString: (s: unknown) => (String(s) as any).toWellFormed(),
  isArray: Array.isArray,
  isBoolean: (v: unknown) => typeof v === "boolean",
  isNull: (v: unknown) => v === null,
  isNullOrUndefined: (v: unknown) => v == null,
  isNumber: (v: unknown) => typeof v === "number",
  isString: (v: unknown) => typeof v === "string",
  isSymbol: (v: unknown) => typeof v === "symbol",
  isUndefined: (v: unknown) => v === undefined,
  isRegExp: types.isRegExp,
  isObject: (v: unknown) => typeof v === "object" && v !== null,
  isDate: types.isDate,
  isError: (v: unknown) => v instanceof Error,
  isFunction: (v: unknown) => typeof v === "function",
  isPrimitive: (v: unknown) => v === null || (typeof v !== "object" && typeof v !== "function"),
};
