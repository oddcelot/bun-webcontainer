import { codeError } from "./errors";
import { parseArgs } from "./parseArgs";

const custom = Symbol.for("nodejs.util.inspect.custom");

type InspectOptions = { depth?: number | null; compact?: boolean | number; breakLength?: number; colors?: boolean; showHidden?: boolean; maxArrayLength?: number };

const IDENT = /^[A-Za-z_$][\w$]*$/;
const tag = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1);
const quote = (s: string) => {
  const q = !s.includes("'") ? "'" : !s.includes('"') ? '"' : !s.includes("`") ? "`" : "'";
  return q + s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(q === "'" ? /'/g : q === '"' ? /"/g : /`/g, "\\" + q) + q;
};

function inspectValue(v: unknown, o: Required<Pick<InspectOptions, "breakLength">> & { depth: number }, level: number, seen: unknown[], top: boolean): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "undefined":
      return "undefined";
    case "string":
      return top ? v : quote(v);
    case "number":
      return Object.is(v, -0) ? "-0" : String(v);
    case "bigint":
      return v + "n";
    case "boolean":
      return String(v);
    case "symbol":
      return v.toString();
  }
  const obj = v as Record<string | symbol, unknown>;
  if (typeof (obj as { [custom]?: unknown })[custom] === "function") {
    const r = ((obj as { [custom]: Function })[custom] as Function).call(obj, o.depth - level, o, inspect);
    if (r !== obj) return typeof r === "string" ? r : inspectValue(r, o, level, seen, false);
  }
  if (seen.includes(v)) return "[Circular *1]";
  const t = tag(v);
  const ctor = typeof v === "function" ? undefined : (Object.getPrototypeOf(v)?.constructor?.name as string | undefined);
  let prefix = "";
  let braces: [string, string] = ["{", "}"];
  let items: string[] = [];
  const keys = Object.keys(obj);
  const next = [...seen, v];
  const sub = (x: unknown) => inspectValue(x, o, level + 1, next, false);
  const deep = level > o.depth;
  if (typeof v === "function") {
    const src = Function.prototype.toString.call(v);
    const base = /^class\b/.test(src) ? `[class ${v.name || "(anonymous)"}${Object.getPrototypeOf(v)?.name ? ` extends ${Object.getPrototypeOf(v).name}` : ""}]` : `[${tag(v) === "AsyncFunction" ? "AsyncFunction" : tag(v) === "GeneratorFunction" ? "GeneratorFunction" : "Function"}${v.name ? `: ${v.name}` : " (anonymous)"}]`;
    if (!keys.length) return base;
    prefix = base + " ";
  } else if (Array.isArray(v)) {
    if (deep) return "[Array]";
    braces = ["[", "]"];
    let holes = 0;
    const flush = () => holes && (items.push(`<${holes} empty item${holes > 1 ? "s" : ""}>`), (holes = 0));
    for (let i = 0; i < Math.min(v.length, 100); i++) {
      if (i in v) (flush(), items.push(sub(v[i])));
      else holes++;
    }
    flush();
    if (v.length > 100) items.push(`... ${v.length - 100} more item${v.length - 100 > 1 ? "s" : ""}`);
    for (const k of keys) if (!/^\d+$/.test(k)) items.push(`${IDENT.test(k) ? k : quote(k)}: ${sub(obj[k])}`);
    if (ctor && ctor !== "Array") prefix = `${ctor}(${v.length}) `;
    return wrap(prefix, braces, items, o, level);
  } else if (v instanceof Error) {
    let s = v.stack || `${v.name}: ${v.message}`;
    if (!s.includes(v.message)) s = `${v.name}: ${v.message}\n${s}`;
    const own = keys.filter((k) => k !== "stack" && k !== "message");
    if (!own.length) return s.includes("\n    at") ? s : `[${s}]`;
    prefix = s + " ";
    items = own.map((k) => `${k}: ${sub(obj[k])}`);
    return wrap(prefix, braces, items, o, level);
  } else if (v instanceof Map) {
    if (deep) return "[Map]";
    prefix = `Map(${v.size}) `;
    for (const [k, x] of v) items.push(`${sub(k)} => ${sub(x)}`);
  } else if (v instanceof Set) {
    if (deep) return "[Set]";
    prefix = `Set(${v.size}) `;
    for (const x of v) items.push(sub(x));
  } else if (v instanceof Date) {
    return isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
  } else if (v instanceof RegExp) {
    return String(v);
  } else if (v instanceof Promise) {
    prefix = "Promise ";
    items.push("<pending>");
  } else if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const arr = v as unknown as ArrayLike<unknown>;
    braces = ["[", "]"];
    prefix = `${ctor ?? t}(${arr.length}) `;
    for (let i = 0; i < Math.min(arr.length, 100); i++) items.push(sub(arr[i]));
    if (arr.length > 100) items.push(`... ${arr.length - 100} more items`);
    return wrap(prefix, braces, items, o, level);
  } else if (v instanceof WeakMap || v instanceof WeakSet) {
    return `${t} { <items unknown> }`;
  } else {
    if (ctor && ctor !== "Object") prefix = `${ctor} `;
    else if (!ctor) prefix = "[Object: null prototype] ";
    const st = obj[Symbol.toStringTag];
    if (typeof st === "string" && st !== ctor) prefix = `${prefix || "Object "}[${st}] `;
    if (deep) return `[${ctor ?? "Object: null prototype"}]`;
  }
  for (const k of keys) items.push(`${IDENT.test(k) ? k : quote(k)}: ${sub(obj[k])}`);
  for (const s of Object.getOwnPropertySymbols(obj)) if (Object.prototype.propertyIsEnumerable.call(obj, s)) items.push(`[${s.toString()}]: ${sub(obj[s])}`);
  return wrap(prefix, braces, items, o, level);
}

function wrap(prefix: string, [open, close]: [string, string], items: string[], o: { breakLength: number }, level: number): string {
  if (!items.length) return `${prefix}${open}${close}`;
  const one = `${prefix}${open} ${items.join(", ")} ${close}`;
  if (one.length + level * 2 <= o.breakLength && !one.includes("\n")) return one;
  const pad = "  ".repeat(level + 1);
  return `${prefix}${open}\n${pad}${items.join(`,\n${pad}`)}\n${"  ".repeat(level)}${close}`;
}

export function inspect(v: unknown, opts?: InspectOptions | boolean): string {
  const o = typeof opts === "object" && opts ? opts : {};
  const out = inspectValue(v, { depth: o.depth === null ? Infinity : (o.depth ?? 2), breakLength: o.breakLength ?? 80 }, 0, [], false);
  return out;
}
inspect.custom = custom;
inspect.defaultOptions = { depth: 2, colors: false, breakLength: 80 };

export function format(...args: unknown[]): string {
  const first = args[0];
  let i = 1;
  let out = "";
  if (typeof first === "string") {
    if (args.length === 1) return first;
    out = first.replace(/%([sdifjoOc%])/g, (m, c: string) => {
      if (c === "%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      switch (c) {
        case "s":
          return typeof a === "string" ? a : typeof a === "bigint" ? a + "n" : typeof a === "object" && a !== null ? inspect(a, { depth: 0 }) : String(a);
        case "d":
          return typeof a === "bigint" ? a + "n" : typeof a === "symbol" ? "NaN" : String(Number(a));
        case "i":
          return typeof a === "bigint" ? a + "n" : typeof a === "symbol" ? "NaN" : String(parseInt(a as string));
        case "f":
          return typeof a === "symbol" ? "NaN" : String(parseFloat(a as string));
        case "j":
          try {
            return JSON.stringify(a);
          } catch {
            return "[Circular]";
          }
        case "o":
        case "O":
          return inspect(a);
        default:
          return "";
      }
    });
  } else {
    i = 0;
  }
  for (; i < args.length; i++) {
    const a = args[i];
    out += (out || i > 0 ? " " : "") + (typeof a === "string" ? a : inspect(a));
  }
  return out;
}

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

const ctorOf = (v: unknown) => (v as object)?.constructor?.name;
const types = {
  isPromise: (v: unknown) => v instanceof Promise,
  isRegExp: (v: unknown) => v instanceof RegExp,
  isDate: (v: unknown) => v instanceof Date,
  isNativeError: (v: unknown) => v instanceof Error,
  isMap: (v: unknown) => v instanceof Map,
  isSet: (v: unknown) => v instanceof Set,
  isWeakMap: (v: unknown) => v instanceof WeakMap,
  isWeakSet: (v: unknown) => v instanceof WeakSet,
  isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v: unknown) => v instanceof Uint8Array,
  isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
  isSharedArrayBuffer: (v: unknown) => typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer,
  isAnyArrayBuffer: (v: unknown) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer),
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isDataView: (v: unknown) => v instanceof DataView,
  isAsyncFunction: (v: unknown) => tag(v) === "AsyncFunction" || tag(v) === "AsyncGeneratorFunction",
  isGeneratorFunction: (v: unknown) => tag(v) === "GeneratorFunction" || tag(v) === "AsyncGeneratorFunction",
  isGeneratorObject: (v: unknown) => tag(v) === "Generator",
  isProxy: () => false,
  isBoxedPrimitive: (v: unknown) => v instanceof Number || v instanceof String || v instanceof Boolean || v instanceof BigInt || v instanceof Symbol,
  isNumberObject: (v: unknown) => v instanceof Number,
  isStringObject: (v: unknown) => v instanceof String,
  isBooleanObject: (v: unknown) => v instanceof Boolean,
  isSymbolObject: (v: unknown) => v instanceof Symbol,
  isMapIterator: (v: unknown) => tag(v) === "Map Iterator",
  isSetIterator: (v: unknown) => tag(v) === "Set Iterator",
  isModuleNamespaceObject: (v: unknown) => tag(v) === "Module",
  isExternal: () => false,
  isArgumentsObject: (v: unknown) => tag(v) === "Arguments",
  isBigInt64Array: (v: unknown) => ctorOf(v) === "BigInt64Array",
  isBigUint64Array: (v: unknown) => ctorOf(v) === "BigUint64Array",
  isFloat32Array: (v: unknown) => v instanceof Float32Array,
  isFloat64Array: (v: unknown) => v instanceof Float64Array,
  isInt8Array: (v: unknown) => v instanceof Int8Array,
  isInt16Array: (v: unknown) => v instanceof Int16Array,
  isInt32Array: (v: unknown) => v instanceof Int32Array,
  isUint8ClampedArray: (v: unknown) => v instanceof Uint8ClampedArray,
  isUint16Array: (v: unknown) => v instanceof Uint16Array,
  isUint32Array: (v: unknown) => v instanceof Uint32Array,
};

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
  formatWithOptions: (_o: unknown, ...a: unknown[]) => format(...a),
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
  stripVTControlCharacters: (s: string) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, ""),
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
