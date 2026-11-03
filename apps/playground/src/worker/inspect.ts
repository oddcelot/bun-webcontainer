import { inspect as nodeInspect } from "./node/inspect";
import { settledPromise } from "./promises";
import { bodyOf, type BodyInfo } from "./bodies";

/**
 * Bun's value formatter (`console.log`, `Bun.inspect`): a port of bun/src/jsc/ConsoleObject.rs's `Formatter`, quirks
 * included. Objects print one property per line with a trailing comma, arrays break once Bun's running estimate of
 * the line passes 80 columns, strings inside values get double quotes, and errors print `error: message` and their
 * frames, after Bun's source preview where the worker knows the top frame's file and line. `util.inspect` is\n * Node's format (node/util.ts), not this one.
 *
 * Differences that can't be ported: a promise's state isn't readable synchronously, so promises print `<pending>`
 * unless promises.ts saw them settle; a Proxy prints as what its traps return; keys come strings first, then
 * symbols (Reflect.ownKeys' order: the interleaving Bun shows isn't observable). Host objects print their native
 * accessors' values (as Bun reads JSC's custom accessors) and Bun's runtime classes (Response, Request, Blob…)
 * print with their own writers, the body sizes from bodies.ts.
 */

export type InspectOptions = { depth?: number | null; colors?: boolean; sorted?: boolean; compact?: boolean };
export type Level = "log" | "info" | "debug" | "warn" | "error";

type Tag =
  | "StringPossiblyFormatted"
  | "String"
  | "Undefined"
  | "Double"
  | "Null"
  | "Boolean"
  | "Array"
  | "Object"
  | "Function"
  | "Class"
  | "Error"
  | "TypedArray"
  | "Map"
  | "MapIterator"
  | "SetIterator"
  | "Set"
  | "BigInt"
  | "Symbol"
  | "Custom"
  | "Promise"
  | "Date"
  | "GetterSetter"
  | "RevokedProxy"
  | "Headers"
  | "Response"
  | "Request"
  | "Blob"
  | "FormData"
  | "URLSearchParams"
  | "Event"
  | "JSX";
type TagResult = { tag: Tag; stringLike: boolean; custom?: Function };

const PRIMITIVE = new Set<Tag>(["String", "StringPossiblyFormatted", "Undefined", "Double", "Null", "Boolean", "Symbol", "BigInt"]);
const CIRCULAR = new Set<Tag>(["Function", "Array", "Object", "Map", "Set", "Class", "Event", "JSX"]);
const SGR: Record<string, string> = { r: "0", d: "2", b: "1", red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36" };
const CUSTOM = Symbol.for("nodejs.util.inspect.custom");
const IDENT = /^[A-Za-z_$][\w$]*$/;
const INDEX = /^(0|[1-9]\d*)$/;

const has = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);
const brand = (fn: Function, v: unknown) => {
  try {
    fn.call(v);
    return true;
  } catch {
    return false;
  }
};
const getter = (proto: object, key: PropertyKey) => Object.getOwnPropertyDescriptor(proto, key)!.get!;
const typedArrayTag = getter(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag);
const mapIteratorProto = Object.getPrototypeOf(new Map().entries());
const setIteratorProto = Object.getPrototypeOf(new Set().values());

const isError = (v: unknown): v is Error => {
  const e = Error as unknown as { isError?: (v: unknown) => boolean };
  return typeof e.isError === "function" ? e.isError(v) : v instanceof Error;
};
const isBuffer = (v: unknown) => typeof (globalThis as { Buffer?: { isBuffer?: (v: unknown) => boolean } }).Buffer?.isBuffer === "function" && (globalThis as any).Buffer.isBuffer(v);

/** `class` syntax, or a builtin constructor (JSC's InternalFunction constructors print as classes; Promise doesn't). */
function isClass(fn: Function): boolean {
  let src = "";
  try {
    src = Function.prototype.toString.call(fn);
  } catch {}
  if (/^class\b/.test(src)) return true;
  return /\{\s*\[native code\]\s*\}$/.test(src) && /^[A-Z]/.test(fn.name) && fn !== Promise && !fn.name.startsWith("bound ") && ["object", "function"].includes(typeof (fn as { prototype?: unknown }).prototype);
}

const fnName = (fn: Function): string => {
  let name: unknown;
  try {
    name = fn.name;
  } catch {}
  return typeof name === "string" ? name.replace(/^bound /, "") : "";
};

/** JSC's `getClassName`: the `constructor` (a data property) on the chain, else `Symbol.toStringTag`, else `Object`. */
function className(v: object): string {
  let ctorName = "";
  for (let o: object | null = v, n = 0; o && n < 64; o = Object.getPrototypeOf(o), n++) {
    const d = Object.getOwnPropertyDescriptor(o, "constructor");
    if (!d) continue;
    if ("value" in d && typeof d.value === "function") ctorName = fnName(d.value);
    break;
  }
  if (ctorName && ctorName !== "Object") return ctorName;
  let tag: unknown;
  try {
    tag = (v as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
  } catch {}
  return typeof tag === "string" && tag ? tag : "Object";
}

function objectName(v: object): string | undefined {
  const name = className(v);
  if (name !== "Object") return name;
  if (Object.getPrototypeOf(v) === null) return "[Object: null prototype]";
}

const nativeFns = new WeakMap<Function, boolean>();
/** A builtin (host) function rather than JS source: `function get href() { [native code] }`. */
function isNative(fn: Function): boolean {
  let r = nativeFns.get(fn);
  if (r === undefined) {
    try {
      r = /\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(fn));
    } catch {
      r = false;
    }
    nativeFns.set(fn, r);
  }
  return r;
}

/** An accessor property, printed as `[Getter]`/`[Setter]`/`[Getter/Setter]` rather than called. */
class Accessor {
  constructor(
    readonly get: boolean,
    readonly set: boolean,
  ) {}
}

type Prop = [key: string | symbol, value: unknown];

/**
 * Bun's `forEachProperty`: own keys (non-enumerable ones too), then the prototype chain's, up to five levels and
 * stopping at Object.prototype and Function.prototype; `constructor`, `__proto__` and `Symbol.toStringTag` skipped.
 */
function properties(v: object, nonIndexedOnly: boolean): Prop[] {
  const out: Prop[] = [];
  const seen = new Set<PropertyKey>();
  let level: object | null = v;
  for (let n = 0; level && level !== Object.prototype && level !== Function.prototype && n < 6; n++) {
    let keys: (string | symbol)[];
    try {
      keys = Reflect.ownKeys(level);
    } catch {
      break;
    }
    for (const k of keys) {
      if (k === "constructor" || k === "__proto__" || k === Symbol.toStringTag) continue;
      if (nonIndexedOnly && (k === "length" || (typeof k === "string" && INDEX.test(k)))) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      const d = Object.getOwnPropertyDescriptor(level, k);
      if (!d) continue;
      if (d.get && isNative(d.get)) {
        // A host attribute (URL's href, AbortSignal's aborted…): JSC's are custom accessors, which Bun reads.
        try {
          out.push([k, d.get.call(v)]);
        } catch {}
        continue;
      }
      if (d.get || d.set) {
        out.push([k, new Accessor(!!d.get, !!d.set)]);
        continue;
      }
      out.push([k, level === v ? d.value : safeGet(v, k)]);
    }
    if (nonIndexedOnly || typeof level === "function") break;
    try {
      level = Object.getPrototypeOf(level);
    } catch {
      break;
    }
  }
  return out;
}

function sortedProperties(v: object): Prop[] {
  const keys = Reflect.ownKeys(v).filter((k) => k !== "constructor");
  const str = (k: string | symbol) => (typeof k === "symbol" ? (k.description ?? "") : k);
  keys.sort((a, b) => (str(a) < str(b) ? -1 : str(a) > str(b) ? 1 : 0));
  return keys.map((k) => {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    return [k, d.get || d.set ? new Accessor(!!d.get, !!d.set) : d.value];
  });
}

function safeGet(v: object, k: PropertyKey): unknown {
  try {
    return (v as Record<PropertyKey, unknown>)[k];
  } catch {
    return undefined;
  }
}


function getTag(v: unknown, disableCustom = false): TagResult {
  const t = (tag: Tag, stringLike = false): TagResult => ({ tag, stringLike });
  if (v === undefined) return t("Undefined");
  if (v === null) return t("Null");
  switch (typeof v) {
    case "number":
      return t("Double");
    case "boolean":
      return t("Boolean");
    case "string":
      return t("String", true);
    case "bigint":
      return t("BigInt");
    case "symbol":
      return t("Symbol");
  }
  const o = v as object;
  if (o instanceof Accessor) return t("GetterSetter");
  // Bun prints URLSearchParams from its entries (a JSAsJSON type), ahead of its inspect.custom (util.inspect's).
  if (typeof URLSearchParams !== "undefined" && o instanceof URLSearchParams) return t("URLSearchParams");
  if (!disableCustom) {
    let fn: unknown;
    try {
      fn = (o as { [CUSTOM]?: unknown })[CUSTOM];
    } catch {
      return t("RevokedProxy");
    }
    if (typeof fn === "function") return { tag: "Custom", stringLike: false, custom: fn };
  }
  if (typeof o === "function") return t(isClass(o) ? "Class" : "Function");
  // Bun's runtime classes with their own printers (Response/Request/Blob write_format), and DOM wrappers.
  if (typeof Response !== "undefined" && o instanceof Response) return t("Response");
  if (typeof Request !== "undefined" && o instanceof Request) return t("Request");
  if (typeof Blob !== "undefined" && o instanceof Blob) return t("Blob");
  if (typeof FormData !== "undefined" && o instanceof FormData) return t("FormData");
  if (typeof Headers !== "undefined" && o instanceof Headers) return t("Headers");
  if (typeof Event !== "undefined" && o instanceof Event) return t("Event");
  if (typeof DOMException !== "undefined" && o instanceof DOMException) return t("Object");
  if (isReactElement(o)) return t("JSX");
  if (isError(o)) return t("Error");
  if (Array.isArray(o) || Object.prototype.toString.call(o) === "[object Arguments]") return t("Array");
  if (brand(Number.prototype.valueOf, o)) return t("Double");
  if (brand(String.prototype.valueOf, o)) return t("String", true);
  if (brand(Boolean.prototype.valueOf, o)) return t("Boolean");
  if (o instanceof RegExp) return t("String");
  if (brand(Date.prototype.getTime, o)) return t("Date");
  if (brand(Map.prototype.has as Function, o) || brand(WeakMap.prototype.has as Function, o)) return t("Map");
  if (brand(Set.prototype.has as Function, o) || brand(WeakSet.prototype.has as Function, o)) return t("Set");
  const proto = Object.getPrototypeOf(o);
  if (proto === mapIteratorProto) return t("MapIterator");
  if (proto === setIteratorProto) return t("SetIterator");
  if (o instanceof Promise) return t("Promise");
  if (ArrayBuffer.isView(o) || brand(getter(ArrayBuffer.prototype, "byteLength"), o)) return t("TypedArray");
  if (typeof SharedArrayBuffer !== "undefined" && brand(getter(SharedArrayBuffer.prototype, "byteLength"), o)) return t("TypedArray");
  return t("Object");
}

const REACT_ELEMENT = new Set([Symbol.for("react.element"), Symbol.for("react.transitional.element"), Symbol.for("react.fragment")]);
/** A React element: an own, truthy `$$typeof` that is one of React's element symbols. */
function isReactElement(o: object): boolean {
  try {
    const d = Object.getOwnPropertyDescriptor(o, "$$typeof");
    if (!d) return false;
    const v = "value" in d ? d.value : d.get?.call(o);
    return REACT_ELEMENT.has(v);
  } catch {
    return false;
  }
}

type ErrorLevel = "normal" | "warn" | "full";

class Formatter {
  out = "";
  indent = 0;
  depth = 0;
  maxDepth = 8;
  outerMaxDepth: number | undefined;
  quoteStrings = false;
  quoteKeys = false;
  line = 0;
  alwaysNewlineScope = false;
  singleLine = false;
  ordered = false;
  colors = false;
  disableCustom = false;
  formatBufferAsText = false;
  hadErrors = false;
  errorLevel: ErrorLevel = "full";
  remaining: unknown[] = [];
  visited = new Set<unknown>();

  /** `<r>`, `<d>`, `<green>`… as ANSI escapes, or nothing without colors. */
  p(s: string): string {
    return s.replace(/<(r|d|b|red|green|yellow|blue|magenta|cyan)>/g, (_, n: string) => (this.colors ? `\x1b[${SGR[n]}m` : ""));
  }
  w(s: string) {
    this.out += s;
  }
  writeIndent(n = this.indent) {
    this.out += "  ".repeat(n);
  }
  add(n: number) {
    this.line += n;
  }
  resetLine() {
    this.line = this.indent * 2;
  }
  goodTime(indent = this.indent): boolean {
    if (this.line > 80) {
      this.line = indent * 2;
      return true;
    }
    return false;
  }
  comma() {
    this.w(this.p("<r><d>,<r>"));
    this.line += 1;
  }
  space() {
    this.line += 1;
    this.w(" ");
  }
  errorChainMaxDepth() {
    return this.outerMaxDepth ?? this.maxDepth;
  }

  format(r: TagResult, v: unknown) {
    this.printAs(r.tag, v, r);
  }

  printAs(tag: Tag, v: unknown, r?: TagResult) {
    let remove = false;
    if (CIRCULAR.has(tag)) {
      if (this.visited.has(v)) return this.w(this.p("<r><cyan>[Circular]<r>"));
      this.visited.add(v);
      remove = true;
    }
    try {
      this.dispatch(tag, v, r);
    } finally {
      if (remove) this.visited.delete(v);
    }
  }

  dispatch(tag: Tag, v: unknown, r?: TagResult) {
    switch (tag) {
      case "StringPossiblyFormatted": {
        const s = String(v);
        this.add(s.length);
        return this.writeWithFormatting(s);
      }
      case "String":
        return this.printString(v);
      case "Double":
        return this.printNumber(v);
      case "BigInt": {
        const s = String(v);
        this.add(s.length);
        return this.w(this.p("<r><yellow>") + s + "n" + this.p("<r>"));
      }
      case "Undefined":
        this.add(9);
        return this.w(this.p("<r><d>undefined<r>"));
      case "Null":
        this.add(4);
        return this.w(this.p("<r><yellow>null<r>"));
      case "Boolean":
        return this.printBoolean(v);
      case "Symbol": {
        const d = (v as symbol).description ?? "";
        this.add(6);
        if (d) this.add(d.length + 2);
        return this.w(this.p("<r><blue>") + `Symbol(${d})` + this.p("<r>"));
      }
      case "Custom":
        return this.printCustom(v, r!.custom!);
      case "Error":
        return this.printError(v as Error);
      case "Class":
        return this.printClass(v as Function);
      case "Function":
        return this.printFunction(v as Function);
      case "GetterSetter": {
        const a = v as Accessor;
        const s = a.get && a.set ? "[Getter/Setter]" : a.get ? "[Getter]" : "[Setter]";
        return this.w(this.p("<cyan>") + s + this.p("<r>"));
      }
      case "Array":
        return this.printArray(v as unknown[]);
      case "Promise":
        return this.printPromise(v as Promise<unknown>);
      case "Map":
        return this.printMap(v as Map<unknown, unknown>);
      case "Set":
        return this.printSet(v as Set<unknown>);
      case "MapIterator":
      case "SetIterator":
        return this.printIterator(v as Iterator<unknown>, tag);
      case "Date":
        return this.printDate(v as Date);
      case "Object":
        return this.printObject(v as object);
      case "TypedArray":
        return this.printTypedArray(v as ArrayBufferView | ArrayBuffer);
      case "Headers":
        return this.printHeaders(v as Headers);
      case "Response":
        return this.printResponse(v as Response);
      case "Request":
        return this.printRequest(v as Request);
      case "Blob":
        return this.printBlob(v as Blob);
      case "FormData":
      case "URLSearchParams":
        return this.printEntries(v as FormData | URLSearchParams, tag);
      case "Event":
        return this.printEvent(v as Event);
      case "JSX":
        return this.printJSX(v as ReactElement);
      case "RevokedProxy":
        this.add(15);
        return this.w(this.p("<r><cyan><Revoked Proxy><r>"));
    }
  }

  printString(v: unknown) {
    const isRegExp = v instanceof RegExp;
    const isStringObject = typeof v === "object" && v !== null && !isRegExp;
    if (typeof v === "symbol") throw new TypeError("Cannot convert a symbol to a string");
    const s = String(v);
    this.add(s.length);
    if (this.quoteStrings && !isRegExp) {
      if (!s) return this.w('""');
      return this.w(this.p("<r><green>") + JSON.stringify(s) + this.p("<r>"));
    }
    if (isStringObject && brand(String.prototype.valueOf, v)) {
      return this.w(this.p("<r><green>") + "[String: " + JSON.stringify(s) + "]" + this.p("<r>"));
    }
    if (isRegExp) return this.w(this.p("<r><red>") + s + this.p("<r>"));
    this.w(s);
  }

  printNumber(v: unknown) {
    if (typeof v === "object") {
      const name = className(v as object);
      const s = String(v);
      if (name !== "Number") {
        this.add(name.length + s.length + 12);
        return this.w(this.p("<r><yellow>") + `[Number (${name}): ${s}]` + this.p("<r>"));
      }
      this.add(name.length + s.length + 4);
      return this.w(this.p("<r><yellow>") + `[${name}: ${s}]` + this.p("<r>"));
    }
    const n = v as number;
    const s = Object.is(n, -0) ? "-0" : String(n);
    this.add(s.length);
    this.w(this.p("<r><yellow>") + s + this.p("<r>"));
  }

  printBoolean(v: unknown) {
    if (typeof v === "object") {
      const name = className(v as object);
      const s = String(v);
      if (name !== "Boolean") {
        this.add(s.length + name.length + 14);
        return this.w(this.p("<r><yellow>") + `[Boolean (${name}): ${s}]` + this.p("<r>"));
      }
      this.add(s.length + 11);
      return this.w(this.p("<r><yellow>") + `[Boolean: ${s}]` + this.p("<r>"));
    }
    this.add(v ? 4 : 5);
    this.w(this.p(`<r><yellow>${v}<r>`));
  }

  printCustom(v: unknown, fn: Function) {
    const opts = { stylize: (s: string) => s, depth: this.maxDepth, colors: this.colors };
    const result = fn.call(v, Math.max(0, this.maxDepth - this.depth), opts, nodeInspect);
    if (typeof result === "string") return this.w(result);
    this.format(result === v ? getTag(result, true) : getTag(result), result);
  }

  printClass(fn: Function) {
    const name = fnName(fn);
    this.add(name.length);
    const proto = Object.getPrototypeOf(fn);
    const protoName = typeof proto === "function" && isClass(proto) ? fnName(proto) : "";
    this.add(protoName.length);
    const ext = protoName ? ` extends ${protoName}` : "";
    this.w(this.p("<cyan>") + `[class ${name || "(anonymous)"}${ext}]` + this.p("<r>"));
  }

  printFunction(fn: Function) {
    const name = fnName(fn);
    const t = Object.prototype.toString.call(fn).slice(8, -1);
    const kind = t === "Function" ? "" : t;
    let s: string;
    if (!name || kind === name) s = kind ? `[${kind}]` : "[Function]";
    else s = kind ? `[${kind}: ${name}]` : `[Function: ${name}]`;
    this.w(this.p("<cyan>") + s + this.p("<r>"));
  }

  printPromise(v: Promise<unknown>) {
    if (!this.singleLine && this.goodTime()) {
      this.w("\n");
      this.writeIndent();
    }
    this.w("Promise { " + this.p("<r><cyan>") + `<${settledPromise(v)?.state ?? "pending"}>` + this.p("<r>") + " }");
  }

  printDate(d: Date) {
    const t = d.getTime();
    const s = isNaN(t) ? "Invalid Date" : d.toISOString();
    this.add(isNaN(t) ? 4 : s.length + 2);
    this.w(this.p("<r><magenta>") + s + this.p("<r>"));
  }

  depthMarker(name: string) {
    this.add(name.length + 6);
    this.w(this.p("<r><cyan>") + `[${name} ...]` + this.p("<r>"));
  }

  printArray(arr: unknown[]) {
    const len = arr.length;
    if (len !== 0 && this.depth > this.maxDepth) return this.depthMarker("Array");
    if (len === 0) {
      this.w("[]");
      return this.add(2);
    }
    const isArguments = !Array.isArray(arr);
    let wasGoodTime = this.alwaysNewlineScope || len > 10;
    const prevQuote = this.quoteStrings;
    this.indent++;
    this.depth++;
    this.add(2);
    this.quoteStrings = true;
    try {
      const present = (i: number) => has(arr, i);
      let indices: number[] | undefined;
      const nextPresent = (i: number): number | undefined => {
        if (isArguments) return i < len ? i : undefined;
        indices ??= Object.keys(arr)
          .filter((k) => INDEX.test(k))
          .map(Number)
          .sort((a, b) => a - b);
        return indices.find((j) => j >= i);
      };
      let emptyStart: number | undefined;
      const emptyItems = (count: number) => {
        if (count === 1) {
          this.add(10);
          this.w(this.p("<r><d>empty item<r>"));
        } else {
          this.add(String(count).length + 14);
          this.w(this.p("<r><d>") + `${count} x empty items` + this.p("<r>"));
        }
      };
      const breakOrSpace = () => {
        if (!this.singleLine && (this.ordered || this.goodTime())) {
          wasGoodTime = true;
          this.w("\n");
          this.writeIndent();
        } else this.space();
      };

      const first = present(0) ? arr[0] : undefined;
      const firstTag = getTag(first, this.disableCustom);
      wasGoodTime = wasGoodTime || !PRIMITIVE.has(firstTag.tag) || this.goodTime();
      if (!this.singleLine && (this.ordered || wasGoodTime)) {
        this.resetLine();
        this.w("[\n");
        this.writeIndent();
        this.add(1);
      } else {
        this.w("[ ");
        this.add(2);
      }
      if (!present(0)) emptyStart = 0;
      else {
        this.format(firstTag, first);
        if (firstTag.stringLike && this.colors) this.w(this.p("<r>"));
      }

      let i = 1;
      let nonempty = 1;
      while (i < len) {
        if (!present(i)) {
          emptyStart ??= i;
          const next = isArguments ? i + 1 : nextPresent(i + 1);
          if (next === undefined || next >= len) break;
          i = next;
          continue;
        }
        if (nonempty >= 100) {
          this.comma();
          this.w("\n");
          this.line = 0;
          this.writeIndent();
          this.add(16);
          this.w(this.p("<r><d>") + `... ${len - i} more items` + this.p("<r>"));
          break;
        }
        nonempty++;
        if (emptyStart !== undefined) {
          if (emptyStart > 0) {
            this.comma();
            breakOrSpace();
          }
          emptyItems(i - emptyStart);
          emptyStart = undefined;
        }
        this.comma();
        if (!this.singleLine && (this.ordered || this.goodTime())) {
          this.w("\n");
          wasGoodTime = true;
          this.writeIndent();
        } else this.space();
        const el = arr[i];
        const tag = getTag(el, this.disableCustom);
        this.format(tag, el);
        if (tag.stringLike && this.colors) this.w(this.p("<r>"));
        i++;
      }
      if (emptyStart !== undefined) {
        if (emptyStart > 0) {
          this.comma();
          breakOrSpace();
        }
        emptyItems(len - emptyStart);
      }

      if (!isArguments) {
        const alwaysNewline = !this.singleLine && (this.alwaysNewlineScope || this.goodTime());
        const ctx = { i, alwaysNewline, parent: arr as object };
        for (const [k, val] of properties(arr, true)) this.property(ctx, k, val);
      }
    } finally {
      this.quoteStrings = prevQuote;
      this.indent--;
      this.depth--;
    }
    if (!this.singleLine && (this.ordered || wasGoodTime || this.goodTime())) {
      this.resetLine();
      this.w("\n");
      this.writeIndent();
      this.w("]");
      this.resetLine();
      this.add(1);
    } else {
      this.w(" ]");
      this.add(2);
    }
  }

  /** One `key: value` of an object (PropertyIteratorCtx::for_each). */
  property(ctx: { i: number; alwaysNewline: boolean; parent: object }, key: string | symbol, value: unknown) {
    if (key === "constructor") return;
    const tag = getTag(value, this.disableCustom);
    if (ctx.i === 0) {
      if (typeof ctx.parent !== "function") {
        const name = objectName(ctx.parent);
        if (name) this.w(name + " ");
      }
      if (!this.singleLine) ctx.alwaysNewline = true;
      this.line = this.indent * 2 + 1;
      this.indent++;
      this.depth++;
      if (this.singleLine) this.w("{ ");
      else {
        this.w("{\n");
        this.writeIndent();
      }
    }
    if (ctx.i > 0) this.comma();
    const before = ctx.i++;
    if (before > 0) {
      if (!this.singleLine && (ctx.alwaysNewline || this.alwaysNewlineScope || this.goodTime())) {
        this.w("\n");
        this.writeIndent();
        this.resetLine();
      } else this.space();
    }
    this.writeKey(key);
    if (tag.stringLike && this.colors) this.w(this.p("<r><green>"));
    this.format(tag, value);
    if (tag.stringLike && this.colors) this.w(this.p("<r>"));
  }

  writeKey(key: string | symbol) {
    if (typeof key === "symbol") {
      const d = key.description ?? "";
      this.add(12 + d.length);
      return this.w(this.p("<r><d>[<r><blue>") + `Symbol(${d})` + this.p("<r><d>]:<r> "));
    }
    if (!this.quoteKeys && IDENT.test(key)) {
      this.add(key.length + 1);
      return this.w(this.p("<r>") + key + this.p("<d>:<r> "));
    }
    this.add(key.length + 2);
    // A key with characters past Latin-1 is quoted as is (Bun's UTF-16 path doesn't escape it).
    const quoted = /[^\x00-\xff]/.test(key) ? `"${key}"` : JSON.stringify(key);
    this.w(this.p("<r><green>") + quoted + this.p("<r><d>:<r> "));
  }

  printObject(v: object) {
    const prevQuote = this.quoteStrings;
    const prevScope = this.alwaysNewlineScope;
    this.quoteStrings = true;
    try {
      const alwaysNewline = !this.singleLine && (this.alwaysNewlineScope || this.goodTime());
      if (this.depth > this.maxDepth) return this.objectDepthExceeded();
      const ctx = { i: 0, alwaysNewline, parent: v };
      for (const [k, val] of this.ordered ? sortedProperties(v) : properties(v, false)) this.property(ctx, k, val);
      this.objectTail(v, ctx.i, ctx.alwaysNewline);
    } finally {
      this.quoteStrings = prevQuote;
      this.alwaysNewlineScope = prevScope;
    }
  }

  objectDepthExceeded() {
    if (this.singleLine) this.w(" ");
    else if (this.alwaysNewlineScope || this.goodTime()) {
      this.w("\n");
      this.writeIndent();
      this.resetLine();
    }
    this.w(this.p("<r><cyan>[Object ...]<r>"));
  }

  objectTail(v: object, count: number, alwaysNewline: boolean) {
    if (count === 0) {
      if (typeof v === "function") return this.printAs(isClass(v) ? "Class" : "Function", v);
      const name = objectName(v);
      if (name) this.w(name + " ");
      return this.w("{}");
    }
    this.depth--;
    if (alwaysNewline) {
      this.indent = Math.max(0, this.indent - 1);
      this.comma();
      this.w("\n");
      this.writeIndent();
      this.w("}");
      this.line += 1;
    } else {
      this.line += 2;
      this.w(" }");
    }
  }

  /** A sub-block (Map, Set, iterator): one more level of indent and depth, strings quoted. */
  nested(fn: () => void) {
    const prevQuote = this.quoteStrings;
    this.quoteStrings = true;
    this.indent++;
    this.depth++;
    try {
      fn();
    } finally {
      this.indent--;
      this.depth--;
      this.quoteStrings = prevQuote;
    }
  }

  printMap(m: Map<unknown, unknown>) {
    const weak = !(m instanceof Map) && brand(WeakMap.prototype.has as Function, m);
    const name = weak ? "WeakMap" : "Map";
    const size = weak ? 0 : (getter(Map.prototype, "size").call(m) as number);
    if (!size) return this.w(`${name} {}`);
    if (this.depth > this.maxDepth) return this.depthMarker(name);
    this.w(this.singleLine ? `${name}(${size}) { ` : `${name}(${size}) {\n`);
    this.nested(() => {
      let count = 0;
      for (const [k, val] of Map.prototype.entries.call(m)) {
        if (this.singleLine && count > 0) {
          this.comma();
          this.w(" ");
        }
        if (!this.singleLine) this.writeIndent();
        this.format(getTag(k, this.disableCustom), k);
        this.w(": ");
        this.format(getTag(val, this.disableCustom), val);
        count++;
        if (!this.singleLine) {
          this.comma();
          this.w("\n");
        }
      }
      if (this.singleLine && count > 0) this.w(" ");
    });
    if (!this.singleLine) this.writeIndent();
    this.w("}");
  }

  printSet(s: Set<unknown>) {
    const weak = !(s instanceof Set) && brand(WeakSet.prototype.has as Function, s);
    const name = weak ? "WeakSet" : "Set";
    const size = weak ? 0 : (getter(Set.prototype, "size").call(s) as number);
    if (!size) return this.w(`${name} {}`);
    if (this.depth > this.maxDepth) return this.depthMarker(name);
    this.w(this.singleLine ? `${name}(${size}) { ` : `${name}(${size}) {\n`);
    this.nested(() => {
      let first = true;
      for (const val of Set.prototype.values.call(s)) {
        if (this.singleLine) {
          if (!first) {
            this.comma();
            this.w(" ");
          }
          first = false;
        } else this.writeIndent();
        this.format(getTag(val, this.disableCustom), val);
        if (!this.singleLine) {
          this.comma();
          this.w("\n");
        }
      }
      if (this.singleLine && !first) this.w(" ");
    });
    if (!this.singleLine) this.writeIndent();
    this.w("}");
  }

  /** Map and Set iterators, as Bun prints them: it walks (and so uses up) the iterator. */
  printIterator(it: Iterator<unknown>, tag: Tag) {
    const label = tag === "MapIterator" ? "MapIterator" : "SetIterator";
    if (this.depth > this.maxDepth) return this.depthMarker(label);
    this.w(`${label} { `);
    this.nested(() => {
      let count = 0;
      for (let r = it.next(); !r.done; r = it.next()) {
        if (this.singleLine && count > 0) {
          this.comma();
          this.w(" ");
        }
        if (!this.singleLine) {
          this.w("\n");
          this.writeIndent();
        }
        this.format(getTag(r.value, this.disableCustom), r.value);
        count++;
        if (!this.singleLine) this.comma();
      }
      if (this.singleLine) {
        if (count > 0 && label === "MapIterator") this.w(" ");
      } else if (count > 0) this.w("\n");
    });
    if (!this.singleLine) this.writeIndent();
    this.w("}");
  }

  /** An object of entries with quoted keys, the way Bun prints a `toJSON()` result (repeated names as arrays). */
  printEntriesObject(entries: Iterable<[string, unknown]>, View?: new () => object) {
    const obj = (View ? new View() : {}) as Record<string, unknown>;
    for (const [k, v] of entries) {
      if (!has(obj, k)) Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
      else if (Array.isArray(obj[k])) (obj[k] as unknown[]).push(v);
      else obj[k] = [obj[k], v];
    }
    const prevKeys = this.quoteKeys;
    this.quoteKeys = true;
    try {
      this.printAs("Object", obj);
    } finally {
      this.quoteKeys = prevKeys;
    }
  }

  printHeaders(h: Headers) {
    this.add(8);
    this.w(this.p("<r>") + "Headers ");
    this.printEntriesObject(Headers.prototype.entries.call(h));
  }

  /** FormData and URLSearchParams: their entries under the class name (an empty FormData is just `{}`). */
  printEntries(v: FormData | URLSearchParams, tag: Tag) {
    const entries = [...(v.entries() as Iterable<[string, unknown]>)];
    const View = tag === "FormData" ? (entries.length ? FormDataView : undefined) : URLSearchParamsView;
    this.printEntriesObject(entries, View);
  }

  field(name: string) {
    this.writeIndent();
    this.w(this.p(`<r>${name}<d>:<r> `));
  }

  /** Response's write_format: its fields, then the body it was made with (bodies.ts). */
  printResponse(r: Response) {
    const used = !!safeGet(r, "bodyUsed");
    const body: BodyInfo | undefined = used ? { kind: "none" } : bodyOf(r);
    this.w(body ? `Response (${formatSize(bodySize(body))}) {\n` : "Response {\n");
    this.indent++;
    try {
      const line = (name: string, print: () => void) => {
        this.field(name);
        print();
        this.comma();
        this.w("\n");
      };
      line("ok", () => this.printBoolean(!!safeGet(r, "ok")));
      line("url", () => this.w('"' + this.p("<r><b>") + str(safeGet(r, "url")) + this.p("<r>") + '"'));
      line("status", () => this.printNumber(Number(safeGet(r, "status"))));
      line("statusText", () => this.w(this.p("<r>") + '"' + this.p("<b>") + str(safeGet(r, "statusText")) + this.p("<r>") + '"'));
      line("headers", () => this.printHeaders(safeGet(r, "headers") as Headers));
      line("redirected", () => this.printBoolean(!!safeGet(r, "redirected")));
      this.resetLine();
      this.field("bodyUsed");
      this.printBoolean(used);
      if (body && body.kind !== "none") {
        this.comma();
        this.printBody(body);
      }
    } finally {
      this.indent--;
    }
    this.w("\n");
    this.writeIndent();
    this.w("}");
    this.resetLine();
  }

  printRequest(r: Request) {
    const used = !!safeGet(r, "bodyUsed");
    const body: BodyInfo | undefined = used ? { kind: "none" } : bodyOf(r);
    this.w(body ? `Request (${formatSize(bodySize(body))}) {\n` : "Request {\n");
    this.indent++;
    try {
      this.field("method");
      this.w('"' + str(safeGet(r, "method")) + '"');
      this.comma();
      this.w("\n");
      this.field("url");
      this.w('"' + this.p("<b>") + str(safeGet(r, "url")) + this.p("<r>") + '"');
      this.comma();
      this.w("\n");
      this.field("headers");
      this.printHeaders(safeGet(r, "headers") as Headers);
      if (body && body.kind !== "none") this.printBody(body);
    } finally {
      this.indent--;
    }
    this.w("\n");
    this.writeIndent();
    this.w("}");
  }

  /** A body on its own line: a Blob (with its type), the size of bytes, or the stream. */
  printBody(body: Exclude<BodyInfo, { kind: "none" }>) {
    this.w("\n");
    this.writeIndent();
    if (body.kind === "blob") this.printBlob(body.blob);
    else if (body.kind === "stream") this.printAs("Object", body.stream);
    else {
      this.w(this.p("<r>") + "Blob" + this.p("<r>") + " (" + this.p("<yellow>") + formatSize(body.size) + this.p("<r>") + ")");
      if (body.type) this.blobFields(undefined, body.type, 0);
    }
  }

  /** Blob's write_format: `Blob (3 bytes)`, then name, type and lastModified when there are any. */
  printBlob(b: Blob) {
    const file = typeof File !== "undefined" && b instanceof File;
    this.w(this.p("<r>") + (file ? "File" : "Blob") + this.p("<r>") + " (" + this.p("<yellow>") + formatSize(b.size) + this.p("<r>") + ")");
    this.blobFields(file ? (b as File).name : undefined, mimeType(b.type), file ? (b as File).lastModified : 0);
  }

  blobFields(name: string | undefined, type: string, lastModified: number) {
    if (name === undefined && !type && !lastModified) return;
    this.w(" {\n");
    this.indent++;
    if (name !== undefined) {
      this.writeIndent();
      this.w("name" + this.p("<d>:<r> <green>") + `"${name}"` + this.p("<r>"));
      if (type || lastModified) this.comma();
      this.w("\n");
    }
    if (type) {
      this.writeIndent();
      this.w("type" + this.p("<d>:<r> <green>") + `"${type}"` + this.p("<r>"));
      if (lastModified) this.comma();
      this.w("\n");
    }
    if (lastModified) {
      this.writeIndent();
      this.w("lastModified" + this.p("<d>:<r> <yellow>") + lastModified + this.p("<r>") + "\n");
    }
    this.indent--;
    this.writeIndent();
    this.w("}");
  }

  /** print_event: an event whose `type` is "message" or "error" prints as a MessageEvent/ErrorEvent, others as objects. */
  printEvent(e: Event) {
    const type = safeGet(e, "type");
    const name = type === "message" ? "MessageEvent" : type === "error" ? "ErrorEvent" : undefined;
    if (!name) return this.printObject(e);
    if (this.depth > this.maxDepth) return this.depthMarker(name);
    this.w(this.p("<r><cyan>") + name + this.p("<r>") + " {\n");
    const prevQuote = this.quoteStrings;
    this.indent++;
    this.depth++;
    this.quoteStrings = true;
    try {
      this.writeIndent();
      this.w(this.p("<r>") + "type: " + this.p("<green>") + `"${type}"` + this.p("<r><d>,<r>") + (this.singleLine ? " " : "\n"));
      const member = (key: string, value: unknown) => {
        if (!this.singleLine) this.writeIndent();
        this.w(this.p("<r><blue>") + key + this.p("<d>:<r> "));
        this.format(getTag(value, this.disableCustom), value);
        this.comma();
        if (!this.singleLine) this.w("\n");
      };
      const message = safeGet(e, "message");
      if (typeof message === "string") member("message", message);
      if (name === "MessageEvent") member("data", safeGet(e, "data"));
      else {
        const error = safeGet(e, "error");
        if (error !== undefined) member("error", error);
      }
    } finally {
      this.indent--;
      this.depth--;
      this.quoteStrings = prevQuote;
    }
    if (!this.singleLine) this.writeIndent();
    this.w("}");
  }

  /** print_jsx: `<div id="a">text</div>`, children on their own lines. */
  printJSX(el: ReactElement) {
    this.w(this.p("<r>") + "<");
    let needsSpace = true;
    let name = "unknown";
    let primitive = false;
    const type = safeGet(el, "type");
    if (type !== undefined && type !== null) {
      if (typeof type === "symbol") name = "";
      else if (typeof type === "string" || (typeof type === "object" && brand(String.prototype.valueOf, type))) {
        name = String(type);
        primitive = true;
      } else if (typeof type === "object" || typeof type === "function") name = nameProperty(type) || "NoName";
      else name = String(type);
    } else if (type === null) name = "null";
    this.w(this.p(primitive ? "<green>" : "<cyan>") + name + this.p("<r>"));

    const key = safeGet(el, "key");
    if (key !== undefined && key !== null) {
      this.w(needsSpace ? " key=" : "key=");
      const prev = this.quoteStrings;
      this.quoteStrings = true;
      try {
        this.format(getTag(key, this.disableCustom), key);
      } finally {
        this.quoteStrings = prev;
      }
      needsSpace = true;
    }

    const props = safeGet(el, "props");
    if (props !== undefined && props !== null) {
      const prevQuote = this.quoteStrings;
      this.quoteStrings = true;
      try {
        if (typeof props !== "object" && typeof props !== "function") return this.w(" />");
        const keys = Object.keys(props).filter((k) => k !== "");
        const children = safeGet(props, "children");
        if (keys.length) {
          this.indent++;
          try {
            const count = keys.length - (children !== undefined ? 1 : 0);
            keys.forEach((k, i) => {
              if (k === "children") return;
              const value = safeGet(props, k);
              const tag = getTag(value, this.disableCustom);
              if (needsSpace) this.space();
              needsSpace = false;
              this.w(this.p("<r><blue>") + k.slice(0, 128) + this.p("<d>") + "=" + this.p("<r>"));
              if (tag.stringLike && this.colors) this.w(this.p("<r><green>"));
              this.format(tag, value);
              if (tag.stringLike && this.colors) this.w(this.p("<r>"));
              if (!this.singleLine && i + 1 < count && i > 3) {
                this.w("\n");
                this.writeIndent();
              } else if (i + 1 < count) this.space();
            });
          } finally {
            this.indent--;
          }
          if (children !== undefined) {
            const tag = getTag(children);
            if ((tag.tag === "String" || tag.tag === "JSX" || tag.tag === "Array") && !this.singleLine) {
              this.jsxChildren(tag.tag, children);
              this.w("</" + this.p(primitive ? "<r><green>" : "<r><cyan>") + name + this.p("<r>") + ">");
              return;
            }
          }
        }
      } finally {
        this.quoteStrings = prevQuote;
      }
    }
    this.w(" />");
  }

  jsxChildren(tag: Tag, children: unknown) {
    if (tag === "String") {
      const s = String(children);
      if (!s) return;
      this.w(this.p("<r>") + ">");
      if (s.length < 128) return this.w(s);
      this.indent++;
      this.w("\n");
      this.writeIndent();
      this.indent--;
      this.w(s + "\n");
      return this.writeIndent();
    }
    if (tag === "JSX") {
      this.w(">\n");
      this.indent++;
      this.writeIndent();
      try {
        this.format(getTag(children), children);
      } finally {
        this.indent--;
      }
      this.w("\n");
      return this.writeIndent();
    }
    const list = children as unknown[];
    const len = list.length;
    if (!len) return;
    this.w(">\n");
    this.indent++;
    this.writeIndent();
    const prevQuote = this.quoteStrings;
    this.quoteStrings = false;
    try {
      for (let j = 0; j < len; j++) {
        const child = list[j];
        this.format(getTag(child, this.disableCustom), child);
        if (j + 1 < len) {
          this.w("\n");
          this.writeIndent();
        }
      }
    } finally {
      this.quoteStrings = prevQuote;
      this.indent--;
    }
    this.w("\n");
    this.writeIndent();
  }

  printTypedArray(v: ArrayBufferView | ArrayBuffer) {
    let name: string;
    let bytes: Uint8Array;
    let len: number;
    let elements: ArrayLike<number | bigint> | undefined;
    if (ArrayBuffer.isView(v)) {
      const ta = typedArrayTag.call(v) as string | undefined;
      bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (ta) {
        name = ta === "Uint8Array" && isBuffer(v) ? "Buffer" : ta;
        elements = v as unknown as ArrayLike<number>;
        len = elements.length;
      } else {
        name = "DataView";
        len = v.byteLength;
      }
    } else {
      const shared = typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer;
      name = shared ? "SharedArrayBuffer" : "ArrayBuffer";
      bytes = new Uint8Array(v);
      len = bytes.length;
    }
    if (this.formatBufferAsText && name === "Uint8Array") {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return this.w(this.p("<r><green>") + JSON.stringify(text) + this.p("<r>"));
      } catch {}
    }
    this.w(name);
    if (!bytes.length) return this.w(`(${len}) []`);
    this.w(`(${len}) [ `);
    const els = elements ?? bytes;
    const big = typeof els[0] === "bigint";
    const suffix = big ? "n" : "";
    const shown = Math.min(els.length, 513);
    for (let i = 0; i < shown; i++) {
      if (i > 0) {
        this.comma();
        this.space();
      }
      this.w(this.p("<r><yellow>") + String(els[i]) + suffix + this.p("<r>"));
    }
    if (els.length > 513) this.w(this.p("<r><d>") + `${suffix}, ... ${els.length - 513} more` + this.p("<r>"));
    this.w(" ]");
  }

  /** `console.log`'s format string: `%s %d %i %f %o %O %j %c %%`, with Bun's off-by-one after `%%`. */
  writeWithFormatting(input: string) {
    let slice = input;
    let i = 0;
    let len = slice.length;
    let hitPercent = false;
    outer: while (i < len) {
      if (hitPercent) {
        i = 0;
        hitPercent = false;
      }
      if (slice[i] === "%") {
        i++;
        if (i >= len) break;
        if (!this.remaining.length) break;
        const c = slice[i];
        if (c === "%") {
          this.w(slice.slice(0, i));
          slice = slice.slice(i + 1);
          len = slice.length;
          i = 1;
          continue;
        }
        if (!"sfoOdicj".includes(c)) {
          i++;
          continue;
        }
        this.w(slice.slice(0, i - 1));
        slice = slice.slice(i + 1);
        i = 0;
        hitPercent = true;
        len = slice.length;
        const next = this.remaining.shift();
        switch (c) {
          case "s":
            this.printAs("String", next);
            break;
          case "d":
          case "i": {
            const n = toInt(next);
            const s = n === undefined ? "NaN" : String(n);
            this.add(s.length);
            this.w(s);
            if (n === undefined) {
              i++;
              continue outer;
            }
            break;
          }
          case "f": {
            let n: number;
            try {
              n = typeof next === "symbol" ? NaN : Number(next);
            } catch {
              n = NaN;
            }
            const s = String(n);
            this.add(s.length);
            this.w(s);
            break;
          }
          case "o":
          case "O":
            this.format(getTag(next), next);
            break;
          case "c":
            break;
          case "j": {
            const s = String(JSON.stringify(next));
            this.add(s.length);
            this.w(s);
            break;
          }
        }
        if (!this.remaining.length) break;
      }
      i++;
    }
    if (slice) this.w(slice);
  }

  printError(err: Error) {
    if (this.visited.has(err)) return this.w(this.p("<r><cyan>[Circular]<r>"));
    let recorded = false;
    try {
      recorded = this.errorBody(err);
    } finally {
      if (recorded) this.visited.delete(err);
    }
  }

  /** VirtualMachine::print_error_instance_body without the source preview. Returns whether `err` went into `visited`. */
  errorBody(err: Error): boolean {
    const prevHadErrors = this.hadErrors;
    this.hadErrors = true;
    let recorded = false;
    const record = () => {
      if (recorded || this.visited.has(err)) return;
      this.visited.add(err);
      recorded = true;
    };
    try {
      const name = str(safeGet(err, "name"));
      const message = str(safeGet(err, "message"));
      const codeValue = safeGet(err, "code");
      const code = typeof codeValue === "string" && /^[\x00-\xff]*$/.test(codeValue) ? codeValue : undefined;
      const frames = stackFrames(err);
      this.sourcePreview(frames[0]);
      this.nameAndMessage(name, message, code);

      const appended: Error[] = [];
      let sawCause = false;
      const keys = Reflect.ownKeys(err).filter((k) => Object.prototype.propertyIsEnumerable.call(err, k) && k !== "");
      const longest = Math.min(10, Math.max(0, ...keys.map((k) => keyText(k).length)));
      let first = true;
      for (const k of keys) {
        if (k === "message" || k === "name" || k === "stack") continue;
        if (k === "code" && code !== undefined) continue;
        const value = safeGet(err, k);
        const valueIsError = isError(value);
        const circular = valueIsError && (value === err || this.visited.has(value));
        if (valueIsError && !prevHadErrors && !circular) {
          if (k === "cause") sawCause = true;
          appended.push(value);
          continue;
        }
        if (circular && k === "cause") sawCause = true;
        if (value !== null && (typeof value === "object" || typeof value === "function")) record();
        const saved = [this.disableCustom, this.quoteStrings, this.maxDepth, this.outerMaxDepth, this.formatBufferAsText] as const;
        this.depth++;
        this.formatBufferAsText = true;
        this.outerMaxDepth = this.errorChainMaxDepth();
        this.maxDepth = this.depth;
        this.quoteStrings = true;
        this.disableCustom = true;
        try {
          first = false;
          this.w(" ".repeat(Math.max(0, longest - keyText(k).length)));
          this.w(" " + keyText(k) + this.p("<r><d>:<r> "));
          this.format(getTag(value, true), value);
          this.w(this.p("<r><d>,<r>\n"));
        } finally {
          this.depth--;
          [this.disableCustom, this.quoteStrings, this.maxDepth, this.outerMaxDepth, this.formatBufferAsText] = saved;
        }
      }
      if (code !== undefined) {
        first = false;
        this.w(" ".repeat(Math.max(0, longest - 4)));
        this.w(" code" + this.p("<r><d>:<r> <green>") + JSON.stringify(code) + this.p("<r>") + "\n");
      }
      if (!sawCause && has(err, "cause")) {
        const cause = safeGet(err, "cause");
        if (isError(cause)) {
          if (cause === err || this.visited.has(cause)) {
            first = false;
            this.w(" ".repeat(Math.max(0, longest - 5)));
            this.w(" cause" + this.p("<r><d>:<r> <r><cyan>[Circular]<r><r><d>,<r>") + "\n");
          } else appended.push(cause);
        }
      }
      if (!first) this.w("\n");

      for (const frame of frames) {
        const m = /^(.*?) \((.*)\)$/.exec(frame);
        if (m) this.w(this.p("<r>      <d>at <r>") + m[1] + this.p("<d> (<r>") + this.location(m[2]) + this.p("<d>)<r>") + "\n");
        else this.w(this.p("<r>      <d>at <r>") + this.location(frame) + "\n");
      }

      if (appended.length) record();
      for (const e of appended) {
        this.w("\n");
        const prevDepth = this.depth;
        this.depth++;
        try {
          if (this.depth > this.errorChainMaxDepth()) this.w(this.p("<r><cyan>[Error ...]<r>"));
          else this.printError(e);
        } finally {
          this.depth = prevDepth;
        }
      }
    } finally {
      this.hadErrors = prevHadErrors;
    }
    return recorded;
  }

  /** A frame's `path:line:column`: the project directory dim, the rest of the path cyan, the numbers yellow. */
  location(loc: string): string {
    if (!this.colors) return loc;
    const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(loc)!;
    const dir = topLevelDir && m[1].startsWith(topLevelDir) ? topLevelDir : "";
    let s = this.p("<r>") + (dir ? this.p("<cyan><d>") + dir + this.p("<r>") : "") + this.p("<cyan>") + m[1].slice(dir.length) + this.p("<r>");
    if (m[2]) s += this.p("<d>:<r><yellow>") + m[2] + this.p("<r>");
    if (m[3]) s += this.p("<d>:<yellow>") + m[3] + this.p("<r>");
    return s;
  }

  /**
   * Bun's source preview for an error's top frame: up to six lines ending at its line, numbered, and a caret under
   * its column (VirtualMachine::print_error_instance_body). Only where the frame's file and line are known.
   */
  sourcePreview(frame: string | undefined) {
    const m = frame && /^(?:.* \()?(.+):(\d+):(\d+)\)?$/.exec(frame);
    if (!m) return;
    const source = sourceOf(m[1]);
    const line = +m[2] - 1;
    const column = +m[3] - 1;
    const lines = source?.split("\n");
    if (!lines || line >= lines.length) return;
    const first = Math.max(0, line - 5);
    const width = String(line + 1).length;
    for (let i = first; i <= line; i++) {
      const text = lines[i].replace(/^\n+|\n+$/g, "").replace(/[\t \r]+$/, "");
      const shown = text.length > 1024 ? text.slice(0, 1024) : text;
      const n = String(i + 1);
      this.w(" ".repeat(width - n.length) + this.p(`<r><b>${n} |<r> `) + shown + (shown.length < text.length && this.colors ? this.p("<r><d> | ... truncated <r>") : "") + "\n");
      if (i === line && shown.length === text.length) {
        if (text.length < 512 || column > 512) this.w(" ".repeat(width + 3 + Math.max(0, column)) + this.p("<red><b>^<r>") + "\n");
        else this.w("\n");
      }
    }
  }

  nameAndMessage(name: string, message: string, code: string | undefined) {
    const label = (n: string, colon = true) => {
      let s = this.colors ? this.p(this.errorLevel === "warn" ? "<r><yellow>" : this.errorLevel === "full" ? "<r><red>" : "<r>") : "";
      s += n || (this.errorLevel === "warn" ? "warn" : "error");
      if (!colon) return s + this.p("<r>");
      return s + (this.colors ? this.p("<r><d>:<r> ") : ": ");
    };
    if (name && message) {
      let shownName = name;
      let shownMessage = message;
      if (name === "Error") {
        shownName = "";
        if (code !== undefined && message.length > code.length + 3 && message.startsWith(code) && message.slice(code.length, code.length + 2) === ": ") {
          shownName = code;
          shownMessage = message.slice(code.length + 2);
        }
      }
      this.w(label(shownName) + this.p("<b>") + shownMessage + this.p("<r>") + "\n");
    } else if (name) this.w(label(name) + "\n");
    else if (message) this.w(label("") + this.p("<b>") + message + this.p("<r>") + "\n");
    else this.w(label("", false) + "\n");
  }
}

/** What FormData and URLSearchParams print as: their entries under the class name, keys quoted. */
const FormDataView = class FormData {};
const URLSearchParamsView = class URLSearchParams {};

type ReactElement = { $$typeof: symbol; type?: unknown; key?: unknown; props?: unknown };

/** JSC's getNameProperty: a non-empty `Symbol.toStringTag`, else a function's name. */
function nameProperty(v: object): string {
  const tag = safeGet(v, Symbol.toStringTag);
  if (typeof tag === "string" && tag) return tag;
  return typeof v === "function" ? fnName(v) : "";
}

/** bun_core::fmt::size: `0 KB`, `5 bytes`, `0.60 KB`, `2.0 KB`, `2.50 MB`. */
function formatSize(n: number): string {
  if (n === 0) return "0 KB";
  if (n < 512) return `${n} bytes`;
  const mag = Math.min(Math.floor(Math.floor(Math.log2(n)) / 9), 8);
  const v = n / 1000 ** mag;
  if (mag === 0) return `${(v / 1000).toFixed(2)} KB`;
  return `${v.toFixed(Math.abs(v - Math.trunc(v)) <= 0.1 ? 1 : 2)} ${" KMGTPEZY"[mag]}B`;
}

const bodySize = (b: BodyInfo) => (b.kind === "bytes" ? b.size : b.kind === "blob" ? b.blob.size : 0);

/** A Blob's type as Bun stores it: the well-known ones get their canonical form (MimeType::by_name_static). */
const JS_MIME = "text/javascript;charset=utf-8";
const CANONICAL_MIME: Record<string, string> = {
  "application/javascript": JS_MIME,
  "text/javascript": JS_MIME,
  "text/jsx": JS_MIME,
  "application/json": "application/json;charset=utf-8",
  "application/x-www-form-urlencoded": "application/x-www-form-urlencoded;charset=UTF-8",
  "text/css": "text/css;charset=utf-8",
  "text/html": "text/html;charset=utf-8",
  "text/plain": "text/plain;charset=utf-8",
};
const mimeType = (t: string) => (has(CANONICAL_MIME, t) ? CANONICAL_MIME[t] : t);

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : typeof v === "symbol" ? v.toString() : String(v));
const keyText = (k: string | symbol) => (typeof k === "symbol" ? k.toString() : k);

/** `%d`/`%i`: Bun truncates instead of calling parseInt. `undefined` stands for NaN. */
function toInt(v: unknown): number | undefined {
  if (typeof v === "symbol") return undefined;
  let n: number;
  try {
    n = Number(v);
  } catch {
    return undefined;
  }
  if (!Number.isFinite(n)) return undefined;
  if (n === 0) return 0;
  const sign = n < 0 ? -1 : 1;
  let a = Math.abs(n);
  if (a >= 1e21) while (a >= 10) a /= 10;
  else if (a < 0.000001) while (a < 1) a *= 10;
  return Math.floor(a) * sign;
}

let mapFrame = (frame: string) => frame;
let topLevelDir = "";
let sourceOf = (_path: string): string | undefined => undefined;
/**
 * How an error's stack frames read (`fn (location)`): the worker turns served-module URLs into project paths
 * under `dir` (with a trailing slash), which colored output dims like Bun dims its working directory. `source`
 * gives a mapped frame's file text for the source preview (undefined where its lines aren't the file's).
 */
export function setFrameMapper(fn: (frame: string) => string, dir = "", source?: (path: string) => string | undefined) {
  mapFrame = fn;
  topLevelDir = dir;
  if (source) sourceOf = source;
}

/** An error's frames from its `stack` (V8's `    at …` lines, or SpiderMonkey/JSC's `fn@url:1:2`). */
function stackFrames(err: Error): string[] {
  const stack = safeGet(err, "stack");
  if (typeof stack !== "string") return [];
  const out: string[] = [];
  for (const line of stack.split("\n")) {
    let m = /^\s+at (.*)$/.exec(line);
    let frame: string | undefined;
    if (m) frame = mapFrame(m[1]);
    else if ((m = /^(.*)@(.+:\d+:\d+)$/.exec(line))) frame = mapFrame(m[1] ? `${m[1]} (${m[2]})` : m[2]);
    // "": a frame the mapper hides.
    if (frame) out.push(frame);
  }
  return out;
}

type FormatOptions = {
  colors?: boolean;
  quoteStrings?: boolean;
  maxDepth?: number;
  singleLine?: boolean;
  ordered?: boolean;
  indent?: number;
  errorLevel?: ErrorLevel;
};

function formatter(o: FormatOptions): Formatter {
  const f = new Formatter();
  f.colors = !!o.colors;
  f.quoteStrings = !!o.quoteStrings;
  f.maxDepth = o.maxDepth ?? 2;
  f.singleLine = !!o.singleLine;
  f.ordered = !!o.ordered;
  f.indent = o.indent ?? 0;
  f.errorLevel = o.errorLevel ?? "full";
  return f;
}

/** `format2`: values separated by spaces, each string a possible format string for the values after it. */
export function format(values: unknown[], o: FormatOptions = {}, level?: Level): string {
  if (!values.length) return "";
  const f = formatter(o);
  f.writeIndent();
  const red = f.colors && level === "error";
  if (values.length === 1) {
    const tag = getTag(values[0]);
    if (tag.tag === "String" && red) f.w(f.p("<r><red>"));
    f.format(tag, values[0]);
    if (tag.tag === "String" && red) f.w(f.p("<r>"));
    return f.out;
  }
  f.remaining = values.slice(1);
  let v = values[0];
  if (red) f.w(f.p("<r><red>"));
  for (let any = false; ; ) {
    if (any) f.w(" ");
    any = true;
    const tag = getTag(v);
    if (tag.tag === "String" && f.remaining.length) tag.tag = "StringPossiblyFormatted";
    f.format(tag, v);
    if (!f.remaining.length) break;
    v = f.remaining.shift();
  }
  if (red) f.w(f.p("<r>"));
  return f.out;
}

/** Default depth of `console.log` (Bun's `--console-depth`). */
export const CONSOLE_DEPTH = 2;

/** One `console.log`-family message, inside `indent` groups. */
export function formatLog(args: unknown[], level: Level = "log", indent = 0, opts: { depth?: number; colors?: boolean } = {}): string {
  const errorLevel: ErrorLevel = level === "error" ? "full" : level === "warn" ? "warn" : "normal";
  return format(args, { maxDepth: opts.depth ?? CONSOLE_DEPTH, indent, colors: opts.colors, errorLevel }, level);
}

const depthOf = (d: unknown): number => {
  if (d === null || d === Infinity) return 0xffff;
  if (typeof d !== "number" || Number.isNaN(d)) throw new TypeError("depth must be a number");
  return Math.max(0, Math.min(0xffff, Math.trunc(d)));
};

/** `Bun.inspect(value, options)`; `Bun.inspect(value, depth, colors)` also works. */
export function bunInspect(value: unknown, options?: InspectOptions | number, colors?: boolean): string {
  if (arguments.length === 0) return "";
  const o: FormatOptions = { quoteStrings: true, maxDepth: 8 };
  if (typeof options === "number") {
    o.maxDepth = depthOf(options);
    o.colors = !!colors;
  } else if (options && typeof options === "object") {
    if (options.depth !== undefined) o.maxDepth = depthOf(options.depth);
    if (options.colors !== undefined) o.colors = !!options.colors;
    if (options.sorted !== undefined) o.ordered = !!options.sorted;
    if (options.compact !== undefined) o.singleLine = !!options.compact;
  } else o.colors = !!colors;
  return format([value], o, "debug");
}
bunInspect.custom = CUSTOM;

/** A `console.table` cell: strings bare, other values on one line, five levels deep (TablePrinter's formatter). */
export function formatCell(value: unknown, startDepth = 0): string {
  const f = formatter({ singleLine: true, maxDepth: 5 });
  f.depth = Math.min(startDepth, 5);
  const tag = getTag(value);
  f.quoteStrings = tag.tag !== "String";
  f.format(tag, value);
  return f.out;
}

/** getConstructorOf(v).name: the first `constructor` data property on the chain, else `fallback`. */
function constructorNameOf(v: object, fallback: string): string {
  for (let o: object | null = v; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, "constructor");
    if (d && "value" in d && typeof d.value === "function" && d.value.name) return d.value.name;
  }
  return fallback;
}

/**
 * Bun's `[util.inspect.custom]` for URL and URLSearchParams (JSDOMURL.cpp, JSURLSearchParams.cpp), which
 * console.log (URL only) and util.inspect use: `URL { href: '…', … }` and `URLSearchParams { 'a' => '1' }`.
 */
export function installWebInspect(g: { URL?: typeof URL; URLSearchParams?: typeof URLSearchParams }) {
  const define = (proto: object, fn: Function) => Object.defineProperty(proto, CUSTOM, { value: fn, writable: true, configurable: true, enumerable: false });
  if (g.URL)
    define(g.URL.prototype, function (this: URL, depth: unknown, options: Record<string, unknown> = {}) {
      if (!(this instanceof (g.URL as typeof URL))) return this;
      if (typeof depth === "number" && depth < 0) return this;
      const data: Record<string, unknown> = {};
      for (const k of ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "searchParams", "hash"] as const) data[k] = this[k];
      // WebStreamsInspectCustom.cpp's customInspect: the child depth is options.depth - 1 (null without one).
      const opts = { ...options, depth: options.depth === undefined || options.depth === null ? null : Number(options.depth) - 1 };
      return `${constructorNameOf(this, "URL")} ${nodeInspect(data, opts)}`;
    });
  if (g.URLSearchParams)
    define(g.URLSearchParams.prototype, function (this: URLSearchParams, depth: unknown, options?: Record<string, unknown>) {
      if (!(this instanceof (g.URLSearchParams as typeof URLSearchParams))) return this;
      const d = Number(depth);
      if (d < 0) return typeof options?.stylize === "function" ? (options.stylize as Function)("[Object]", "special") : "[Object]";
      const opts: Record<string, unknown> = options ? { ...options } : {};
      opts.depth = options && depth !== undefined && depth !== null ? d - 1 : null;
      const visible = (s: string) => s.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, "").length;
      const output = [...this].map(([k, v]) => `${nodeInspect(k, opts)} => ${nodeInspect(v, opts)}`);
      const name = constructorNameOf(this, "URLSearchParams");
      if (!output.length) return `${name} {}`;
      const total = output.reduce((n, s) => n + visible(s), 0) + (output.length - 1) * 2;
      const breakLength = typeof options?.breakLength === "number" ? options.breakLength : 128;
      return total > breakLength ? `${name} {\n  ${output.join(",\n  ")} }` : `${name} { ${output.join(", ")} }`;
    });
}
