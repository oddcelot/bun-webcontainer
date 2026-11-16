// node:vm without a second realm. The worker has one global object, so a "context" is a `with` scope over the
// contextified object: a Proxy that answers every name from the object, then from a fresh set of the standard globals,
// and never from the worker's own (process, Bun, fetch, setTimeout ... read as undefined or throw a ReferenceError, as
// in a new Node context). Not a security boundary: the standard globals and every prototype are the worker's own, so
// `({}).constructor.constructor("return process")()` reaches the worker. See compatibility/node.md.
import { Buffer } from "buffer";
import { codeError } from "./errors";

type Opts = string | { filename?: string; contextExtensions?: object[]; parsingContext?: object } | undefined;

const KEYWORDS = new Set("return typeof instanceof in of new delete void throw case do else yield await".split(" "));
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with"]);
const STATEMENT_START = new Set(["", ";", "{", "}", ")"]);

/**
 * What a sloppy script declares at its top level, and which names it applies `typeof` to. A small lexer (strings,
 * templates, comments, regular expressions; blocks that aren't function bodies count as top level) so `var x` and
 * `function f(){}` can be put on the context object as Node does. Destructuring `var`s aren't found.
 */
export function scan(src: string): { vars: string[]; funcs: string[]; typeofs: Set<string> } {
  const vars: string[] = [];
  const funcs: string[] = [];
  const typeofs = new Set<string>();
  // T: a block that isn't a function body, P: parentheses (kind: the control keyword before them), O: anything else
  // that can't hold top-level declarations, S: a template's `${`.
  const stack: { k: "T" | "P" | "O" | "S"; kw?: string }[] = [];
  const top = () => stack.every((f) => f.k === "T" || f.k === "P");
  let prev = "";
  let prev2 = "";
  let inVar = false;
  let expectName = false;
  let varDepth = 0;
  let expectFn = false;
  let newline = false;
  let lastClosed: string | undefined;
  const push = (t: string) => {
    prev2 = prev;
    prev = t;
    newline = false;
  };
  const isWord = (c: string) => /[\w$]/.test(c) || c > "\x7f";
  const template = (from: number): number => {
    let j = from;
    while (j < src.length) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") return push("tpl"), j + 1;
      else if (src[j] === "$" && src[j + 1] === "{") return stack.push({ k: "S" }), push("{"), j + 2;
      else j++;
    }
    return j;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      newline = true;
      i++;
    } else if (/\s/.test(c)) i++;
    else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (src.slice(i, e < 0 ? src.length : e).includes("\n")) newline = true;
      i = e < 0 ? src.length : e + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      push("str");
      i = j + 1;
    } else if (c === "`") i = template(i + 1);
    else if (c === "/" && (prev === "" || (!/^[\w$]/.test(prev) && ![")", "]", "}", "str", "num", "tpl", "re"].includes(prev)) || KEYWORDS.has(prev))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        j++;
      }
      push("re");
      i = j + 1;
      while (i < src.length && isWord(src[i])) i++;
    } else if (isWord(c)) {
      let j = i;
      while (j < src.length && isWord(src[j])) j++;
      const w = src.slice(i, j);
      const numeric = /^\d/.test(w);
      if (!numeric && prev !== ".") {
        const flat = top();
        // ASI: a new line ends a `var` list when an operand is followed by a word.
        if (inVar && newline && stack.length === varDepth && ![",", "=", "+", "-", "*", "/", "?", ":", "&&", "||", "(", "["].includes(prev) && !KEYWORDS.has(prev) && w !== "in" && w !== "of") inVar = false;
        if (expectName && inVar && stack.length === varDepth) {
          vars.push(w);
          expectName = false;
        } else if (expectFn) {
          funcs.push(w);
          expectFn = false;
        } else if (w === "var" && flat) {
          inVar = true;
          expectName = true;
          varDepth = stack.length;
        } else if (w === "function" && flat && (STATEMENT_START.has(prev) || (prev === "async" && STATEMENT_START.has(prev2)))) expectFn = true;
        if (prev === "typeof" || (prev === "(" && prev2 === "typeof")) typeofs.add(w);
      }
      push(numeric ? "num" : w);
      i = j;
    } else {
      if (c === "*" && expectFn) {
        i++;
        continue;
      }
      expectFn = false;
      if (c === "(") stack.push({ k: "P", kw: CONTROL.has(prev) ? prev : undefined });
      else if (c === "[") {
        stack.push({ k: "O" });
        if (expectName) expectName = false;
      } else if (c === "{") {
        const block = (prev === ")" && lastClosed !== undefined) || ["else", "try", "finally", "do"].includes(prev) || STATEMENT_START.has(prev) && prev !== ")";
        stack.push({ k: block ? "T" : "O" });
        if (expectName) expectName = false;
      } else if (c === ")" || c === "]" || c === "}") {
        const f = stack.pop();
        lastClosed = c === ")" ? f?.kw : undefined;
        if (f?.k === "S") {
          i = template(i + 1);
          continue;
        }
      } else if (c === "," && inVar && stack.length === varDepth) expectName = true;
      else if (c === ";" && stack.length === varDepth) inVar = false;
      push(c);
      i++;
    }
  }
  return { vars, funcs, typeofs };
}

const STANDARD = "Object Function Array Number parseFloat parseInt Infinity NaN undefined Boolean String Symbol Date Promise RegExp Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError JSON Math Intl ArrayBuffer Atomics Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array Uint8ClampedArray BigUint64Array BigInt64Array DataView Map BigInt Set WeakMap WeakSet Proxy Reflect FinalizationRegistry WeakRef decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape eval isFinite isNaN SharedArrayBuffer WebAssembly Iterator Float16Array".split(" ");

interface Context {
  /** The standard globals this context has, and its `globalThis` (and top-level `this`). */
  globals: Record<string, unknown>;
  self: object;
}
const contexts = new WeakMap<object, Context>();

const noop = () => {};
// V8 gives every context a console that prints nowhere.
const silentConsole = () => Object.fromEntries(Object.keys(console).map((k) => [k, noop]));

function contextOf(sandbox: object): Context {
  let ctx = contexts.get(sandbox);
  if (ctx) return ctx;
  const globals: Record<string, unknown> = { __proto__: null as never };
  for (const k of STANDARD) if (k in globalThis) globals[k] = (globalThis as Record<string, unknown>)[k];
  globals.console = silentConsole();
  const lookup = (k: PropertyKey) => (k in sandbox ? Reflect.get(sandbox, k) : globals[k as string]);
  const self = new Proxy(sandbox, {
    get: (_, k) => lookup(k),
    has: (t, k) => k in t || k in globals,
  });
  globals.globalThis = self;
  ctx = { globals, self };
  contexts.set(sandbox, ctx);
  return ctx;
}

const describe = (v: unknown) => (typeof v === "string" ? `'${v}'` : String(v));
const invalidArg = (msg: string) => codeError(TypeError, "ERR_INVALID_ARG_TYPE", msg);

function sandboxOf(v: unknown): object {
  if (v === null || typeof v !== "object" && typeof v !== "function" || !contexts.has(v)) throw invalidArg('The "contextifiedObject" argument must be an vm.Context');
  return v;
}

const optsOf = (o: Opts) => (typeof o === "string" ? { filename: o } : (o ?? {}));
const sourceUrl = (filename: string | undefined) => `\n//# sourceURL=${(filename ?? "evalmachine.<anonymous>").replace(/\s/g, "%20")}`;

/** A SyntaxError as Bun reports it: the file the code is from comes first in `stack`. */
function named(e: unknown, filename: string | undefined) {
  if (e instanceof SyntaxError && typeof e.stack === "string") e.stack = `${filename ?? "evalmachine.<anonymous>"}\n\n${e.stack}`;
  return e;
}

/** The `with` scope for one script: every name resolves on the context, so assignments land there. */
function scopeFor(sandbox: object, ctx: Context, names: ReturnType<typeof scan>, look: (k: string) => unknown) {
  return new Proxy(Object.create(null), {
    has: (_, k) => typeof k === "string" && !k.startsWith("$$vm"),
    get(_, k) {
      if (typeof k !== "string") return undefined;
      if (k in sandbox) {
        const v = Reflect.get(sandbox, k);
        if (v !== undefined || !names.funcs.includes(k)) return v;
      }
      if (names.funcs.includes(k)) {
        const f = look(k);
        if (f !== undefined) return f;
      }
      if (k in ctx.globals) return ctx.globals[k];
      if (k === "arguments" || names.typeofs.has(k)) return undefined;
      throw new ReferenceError(`${k} is not defined`);
    },
    set(_, k, v) {
      Reflect.set(sandbox, k, v);
      return true;
    },
    deleteProperty: (_, k) => Reflect.deleteProperty(sandbox, k),
  });
}

// Sloppy on purpose (`with` is a SyntaxError in strict code, and this file is a module). `$$look` reads the function
// declarations the eval'd code hoisted into this function: out here the `with` scope doesn't shadow them.
const runner = new Function(
  "$$vmScope",
  "$$vmCode",
  "$$vmThis",
  "$$vmDone",
  `var $$vmResult;
var $$vmLook = function ($$vmName) { return typeof $$vmName === "string" ? eval("typeof " + $$vmName + " === 'function' ? " + $$vmName + " : undefined") : undefined; };
try {
  with ($$vmScope($$vmLook)) { $$vmResult = eval($$vmCode); }
} finally { $$vmDone($$vmLook); }
return $$vmResult;`,
) as (scope: (look: (k: string) => unknown) => object, code: string, self: object, done: (look: (k: string) => unknown) => void) => unknown;

function runIn(sandbox: object, code: string, opts: Opts): unknown {
  const ctx = contextOf(sandbox);
  const { filename } = optsOf(opts);
  const names = scan(code);
  // As V8 puts them on a context's global before the code runs: functions, then vars.
  for (const k of [...names.funcs, ...names.vars]) if (!(k in sandbox)) Reflect.set(sandbox, k, undefined);
  return runner.call(
      ctx.self,
      (look) => scopeFor(sandbox, ctx, names, look),
      code + sourceUrl(filename),
      ctx.self,
      (look) => {
        for (const k of names.funcs) {
          const f = look(k);
          if (f !== undefined) Reflect.set(sandbox, k, f);
        }
      },
  );
}

function runInThis(code: string, opts: Opts): unknown {
  // Code a Script has parsed already: a SyntaxError here is the program's own (JSON.parse, eval).
  return (0, eval)(code + sourceUrl(optsOf(opts).filename));
}

function check(code: unknown, opts: Opts) {
  if (typeof code !== "string") throw invalidArg(`The "code" argument must be of type string. Received ${typeof code === "object" ? "an instance of " + (code?.constructor?.name ?? "Object") : `type ${typeof code} (${describe(code)})`}`);
  try {
    new Function(code);
  } catch (e) {
    if (e instanceof SyntaxError) throw named(e, optsOf(opts).filename);
  }
}

export class Script {
  #code: string;
  #opts: Opts;
  cachedDataRejected?: boolean;
  sourceMapURL: string | undefined;
  constructor(code: string, opts?: Opts) {
    code = code === undefined ? "undefined" : (code as unknown as string);
    check(code, opts);
    this.#code = code;
    this.#opts = opts;
    this.sourceMapURL = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(code)?.[1];
  }
  runInThisContext(opts?: Opts) {
    return runInThis(this.#code, { ...optsOf(this.#opts), ...optsOf(opts) });
  }
  runInContext(contextifiedObject: object, opts?: Opts) {
    return runIn(sandboxOf(contextifiedObject), this.#code, { ...optsOf(this.#opts), ...optsOf(opts) });
  }
  runInNewContext(contextObject: object = {}, opts?: Opts) {
    return this.runInContext(createContext(contextObject), opts);
  }
  createCachedData() {
    return Buffer.alloc(0);
  }
}

export function createContext(contextObject: object = {}, _options?: unknown) {
  if (contextObject === null || (typeof contextObject !== "object" && typeof contextObject !== "function")) {
    throw invalidArg(`The "contextObject" argument must be of type object. Received ${contextObject === null ? "null" : `type ${typeof contextObject} (${describe(contextObject)})`}`);
  }
  contextOf(contextObject);
  return contextObject;
}

export function isContext(object: unknown) {
  if (object === null || (typeof object !== "object" && typeof object !== "function")) {
    throw invalidArg(`The "object" argument must be of type object. Received ${object === null ? "null" : `type ${typeof object} (${describe(object)})`}`);
  }
  return contexts.has(object);
}

export const runInThisContext = (code: string, opts?: Opts) => new Script(code, opts).runInThisContext();
export const runInContext = (code: string, contextifiedObject: object, opts?: Opts) => new Script(code, opts).runInContext(contextifiedObject);
export const runInNewContext = (code: string, contextObject: object = {}, opts?: Opts) => new Script(code, opts).runInNewContext(contextObject);

export function compileFunction(code: string, params: string[] = [], opts: Opts & object = {}) {
  const { filename, contextExtensions = [], parsingContext } = optsOf(opts as Opts);
  if (typeof code !== "string") throw invalidArg(`The "code" argument must be of type string. Received type ${typeof code} (${describe(code)})`);
  const source = `return function (${params.join(", ")}) {\n${code}\n}`;
  try {
    new Function(source);
  } catch (e) {
    throw named(e, filename);
  }
  const names = scan(code);
  const ctx = parsingContext ? contextOf(sandboxOf(parsingContext)) : undefined;
  const sandbox = parsingContext ? sandboxOf(parsingContext) : undefined;
  const wrap = contextExtensions.map((_, i) => `with ($$vmExt[${i}]) `).join("");
  const make = new Function("$$vmExt", "$$vmScope", `${ctx ? "with ($$vmScope) " : ""}${wrap}{ ${source} }${sourceUrl(filename)}`) as (e: object[], s: object | undefined) => (...a: unknown[]) => unknown;
  return make(contextExtensions, ctx && sandbox && scopeFor(sandbox, ctx, names, () => undefined));
}

export const constants = {
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("vm_dynamic_import_main_context_default"),
  DONT_CONTEXTIFY: Symbol("vm_context_no_contextify"),
};

const unsupported = (name: string) =>
  class {
    constructor() {
      throw new Error(`node:vm.${name} is not supported in the playground`);
    }
  };

export default {
  Script,
  createScript: (code: string, opts?: Opts) => new Script(code, opts),
  createContext,
  isContext,
  runInThisContext,
  runInContext,
  runInNewContext,
  compileFunction,
  constants,
  // Bun resolves with the engine's heap estimate; the worker has none to give.
  measureMemory: () => Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }),
  Module: unsupported("Module"),
  SourceTextModule: unsupported("SourceTextModule"),
  SyntheticModule: unsupported("SyntheticModule"),
};
