// `Bun.XML` (bun/src/runtime/api/XMLObject.rs): `parse` is Bun's parser in transpile-wasm (its result as JSON);
// `stringify` is a port of Bun's Stringifier, so the output and the errors are byte-identical. Self-contained (no
// imports): the worker and the bun/node diff scripts both load it.

type Obj = Record<string, unknown>;
type Space = { kind: "min" } | { kind: "num"; n: number } | { kind: "str"; s: string };
/** How a value is written as content or an attribute value: nothing, an empty element, or text. */
type Scalar = { kind: "skip" } | { kind: "empty" } | { kind: "text"; text: string };

const SKIP: Scalar = { kind: "skip" };
const EMPTY: Scalar = { kind: "empty" };

/** `JSValue::unwrap_boxed_primitive`: `new Number(1)` etc. become their primitive (not boxed symbols). */
function unbox(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  for (const [C, ctor] of [[Number.prototype, Number], [String.prototype, String], [Boolean.prototype, Boolean], [BigInt.prototype, BigInt]] as const) {
    if (v instanceof ctor) {
      try {
        return (C.valueOf as (this: unknown) => unknown).call(v);
      } catch {
        // not really boxed (a subclass-like prototype trick)
      }
    }
  }
  return v;
}

const isObj = (v: unknown): v is object => (typeof v === "object" && v !== null) || typeof v === "function";
/** Values `stringify` leaves out entirely, as `JSON.stringify` does. */
const skipped = (v: unknown) => v === undefined || typeof v === "symbol" || typeof v === "function";
const isDate = (v: unknown): v is Date => v instanceof Date;

/**
 * `JSPropertyIterator` (own enumerable string keys, values read through getters): the keys are
 * taken up front and a property deleted meanwhile is skipped.
 */
function* props(o: object): Generator<[string, unknown]> {
  for (const k of Object.keys(o)) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    yield [k, (o as Obj)[k]];
  }
}

/** `JSValue::array_iterator`: index 0 to length, holes read as undefined. */
function* items(a: unknown[]): Generator<unknown> {
  for (let i = 0; i < a.length; i++) yield a[i];
}

/** `value.get(global, key)`: `undefined` maps to None. */
const get = (o: object, key: string): unknown => (o as Obj)[key];

/** `global.throw(...)`: a plain `Error`; Bun formats the strings as UTF-8, so lone surrogates become U+FFFD. */
const fail = (msg: string) => new Error(msg.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�"));

const hex4 = (cp: number) => cp.toString(16).toUpperCase().padStart(4, "0");
const unrepresentable = (cp: number) => fail(`XML.stringify: XML cannot represent the character U+${hex4(cp)}`);

/** The code point at UTF-16 index `i` and its width; unpaired surrogates come back as-is. */
function codePointAt(s: string, i: number): [number, number] {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const next = s.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return [((c - 0xd800) << 10) + (next - 0xdc00) + 0x10000, 2];
  }
  return [c, 1];
}

/** `Char` (§2.2 [2]). */
const isXmlChar = (cp: number) =>
  cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);

function isNameStartChar(cp: number): boolean {
  if (cp < 0x80) return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f || cp === 0x3a;
  return (
    (cp >= 0xc0 && cp <= 0xd6) ||
    (cp >= 0xd8 && cp <= 0xf6) ||
    (cp >= 0xf8 && cp <= 0x2ff) ||
    (cp >= 0x370 && cp <= 0x37d) ||
    (cp >= 0x37f && cp <= 0x1fff) ||
    (cp >= 0x200c && cp <= 0x200d) ||
    (cp >= 0x2070 && cp <= 0x218f) ||
    (cp >= 0x2c00 && cp <= 0x2fef) ||
    (cp >= 0x3001 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfdcf) ||
    (cp >= 0xfdf0 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0xeffff)
  );
}

function isNameChar(cp: number): boolean {
  if (cp < 0x80) return isNameStartChar(cp) || (cp >= 0x30 && cp <= 0x39) || cp === 0x2d || cp === 0x2e;
  return isNameStartChar(cp) || cp === 0xb7 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x203f && cp <= 0x2040);
}

/** Same interpretation as `JSON.stringify`'s `space`. */
function initSpace(spaceValue: unknown): Space {
  const space = unbox(spaceValue);
  if (typeof space === "number") {
    if (Number.isNaN(space) || space < 1) return { kind: "min" };
    return { kind: "num", n: space > 10 ? 10 : Math.trunc(space) };
  }
  if (typeof space === "string") return space.length === 0 ? { kind: "min" } : { kind: "str", s: space };
  return { kind: "min" };
}

/**
 * A top-level value is a `{ name, attributes, children }` node (rather than a compact document)
 * when it has a string `name` and a `children` or `attributes` property (an own property holding
 * undefined counts).
 */
function isNode(value: object): boolean {
  if (Array.isArray(value)) return false;
  const name = get(value, "name");
  if (typeof name !== "string") return false;
  for (const key of ["children", "attributes"]) {
    if (get(value, key) !== undefined || Object.prototype.hasOwnProperty.call(value, key)) return true;
  }
  return false;
}

const isStackOverflow = (e: unknown) => e instanceof RangeError && /call stack|too much recursion/i.test(e.message);

/** `Bun.XML.stringify(value, replacer?, space?)`; `undefined` where Bun returns it. */
export function xmlStringify(value: unknown, replacer?: unknown, space?: unknown): string | undefined {
  if (skipped(value)) return undefined;
  if (replacer !== undefined && replacer !== null) throw fail("XML.stringify does not support the replacer argument");
  const root = unbox(value);
  if (!isObj(root) || Array.isArray(root)) {
    throw fail("XML.stringify expects an object: a { name, attributes, children } node or an object with a single root element key");
  }
  const s = new XmlStringifier(initSpace(space));
  try {
    if (isNode(root)) s.stringifyNode(root, get(root, "name"));
    else s.stringifyCompactDocument(root);
  } catch (e) {
    if (isStackOverflow(e)) throw new RangeError("Maximum call stack size exceeded.");
    throw e;
  }
  return s.out;
}

class XmlStringifier {
  out = "";
  indent = 0;
  space: Space;
  visiting = new Set<object>();

  constructor(space: Space) {
    this.space = space;
  }

  get pretty(): boolean {
    return this.space.kind !== "min";
  }

  markVisiting(value: object): void {
    if (this.visiting.has(value)) throw fail("Converting circular structure to XML");
    this.visiting.add(value);
  }

  // ── node tree ──────────────────────────────────────────────────────────────

  /** `{ name, attributes, children }` → `<name ...>children</name>`; `name` is already fetched. */
  stringifyNode(node: object, name: unknown): void {
    this.markVisiting(node);
    try {
      this.stringifyNodeInner(node, name);
    } finally {
      this.visiting.delete(node);
    }
  }

  stringifyNodeInner(node: object, nameValue: unknown): void {
    if (typeof nameValue !== "string") {
      throw fail("XML.stringify: element children must be strings, { name, attributes, children } elements, { comment } or { target, data }");
    }
    const name = nameValue;
    this.checkName(name, "element");
    this.out += "<" + name;

    const attributes = get(node, "attributes");
    if (attributes !== undefined && attributes !== null) {
      if (!isObj(attributes) || Array.isArray(attributes)) throw fail("XML.stringify: a node's attributes must be an object");
      for (const [attrName, propValue] of props(attributes)) {
        const sc = this.scalar(propValue, "an attribute value");
        if (sc.kind === "text") this.appendAttribute(attrName, sc.text);
      }
    }

    const childrenValue = get(node, "children");
    let children: unknown[] | undefined;
    if (Array.isArray(childrenValue)) children = childrenValue;
    else if (childrenValue === null || childrenValue === undefined) children = undefined;
    else throw fail("XML.stringify: a node's children must be an array");
    if (!children) {
      this.out += "/>";
      return;
    }

    // Element-only content is indented when pretty-printing; any text child makes the content
    // inline so character data is kept exactly.
    let count = 0;
    let hasText = false;
    for (const raw of items(children)) {
      const child = unbox(raw);
      if (child === null || skipped(child)) continue;
      count++;
      if (!isObj(child) || Array.isArray(child) || isDate(child)) hasText = true;
    }
    if (count === 0) {
      this.out += "/>";
      return;
    }
    this.out += ">";
    const pretty = this.pretty && !hasText;
    if (pretty) this.indent++;
    for (const raw of items(children)) {
      const child = unbox(raw);
      if (child === null || skipped(child)) continue;
      if (pretty) this.newline();
      if (isObj(child) && !Array.isArray(child) && !isDate(child)) {
        // Inside `children` any object is an element (`name`), a comment (`comment`) or a
        // processing instruction (`target`).
        const childName = get(child, "name");
        if (childName === undefined && this.stringifyMarkup(child)) continue;
        this.stringifyNode(child, childName);
      } else if (Array.isArray(child)) {
        throw fail("XML.stringify: a node's children cannot contain arrays");
      } else {
        const sc = this.scalar(child, "a text child");
        if (sc.kind === "text") this.appendText(sc.text);
      }
    }
    if (pretty) {
      this.indent--;
      this.newline();
    }
    this.appendEndTag(name);
  }

  /** `{ comment }` → `<!--comment-->`, `{ target, data }` → `<?target data?>`; `false` if neither. */
  stringifyMarkup(child: object): boolean {
    const comment = get(child, "comment");
    if (comment !== undefined) {
      if (get(child, "target") !== undefined) {
        throw fail("XML.stringify: a child with both 'comment' and 'target' is neither a comment nor a processing instruction");
      }
      if (typeof comment !== "string") throw fail("XML.stringify: a comment node's 'comment' must be a string");
      const len = comment.length;
      let i = 0;
      let prevDash = false;
      while (i < len) {
        const [cp, w] = codePointAt(comment, i);
        i += w;
        if (!isXmlChar(cp)) throw unrepresentable(cp);
        if (cp === 0x2d && (prevDash || i === len)) throw fail("XML.stringify: a comment cannot contain '--' or end with '-'");
        prevDash = cp === 0x2d;
      }
      this.out += "<!--" + comment + "-->";
      return true;
    }
    const target = get(child, "target");
    if (target !== undefined) {
      if (typeof target !== "string") throw fail("XML.stringify: a processing instruction's 'target' must be a string");
      this.checkName(target, "processing instruction target");
      if (target.length === 3) {
        const lower = (i: number) => target.charCodeAt(i) | 0x20;
        if (lower(0) === 0x78 && lower(1) === 0x6d && lower(2) === 0x6c) {
          throw fail("XML.stringify: 'xml' is reserved and cannot be a processing instruction target");
        }
      }
      this.out += "<?" + target;
      const data = get(child, "data");
      if (data === undefined || data === null) {
        // no data
      } else if (typeof data === "string") {
        const len = data.length;
        if (len > 0) {
          let i = 0;
          let prevQ = false;
          while (i < len) {
            const [cp, w] = codePointAt(data, i);
            i += w;
            if (!isXmlChar(cp)) throw unrepresentable(cp);
            if (prevQ && cp === 0x3e) throw fail("XML.stringify: processing instruction data cannot contain '?>'");
            prevQ = cp === 0x3f;
          }
          this.out += " " + data;
        }
      } else {
        throw fail("XML.stringify: a processing instruction's 'data' must be a string");
      }
      this.out += "?>";
      return true;
    }
    return false;
  }

  // ── compact object ─────────────────────────────────────────────────────────

  /** `{ [root]: value }` → the root element. */
  stringifyCompactDocument(document: object): void {
    this.markVisiting(document);
    try {
      this.stringifyCompactDocumentInner(document);
    } finally {
      this.visiting.delete(document);
    }
  }

  stringifyCompactDocumentInner(document: object): void {
    let root: [string, unknown] | undefined;
    for (const [key, propValue] of props(document)) {
      const value = unbox(propValue);
      if (skipped(value)) continue;
      if (key.startsWith("@") || key.startsWith("#")) {
        throw fail(`XML.stringify: the top-level object is the document, so it can only contain the root element (found '${key}')`);
      }
      if (root) throw fail("XML.stringify: an XML document has exactly one root element, but the top-level object has more than one key");
      if (Array.isArray(value)) {
        throw fail(`XML.stringify: the root element '${key}' cannot be an array (an XML document has exactly one root element)`);
      }
      root = [key, value];
    }
    if (!root) throw fail("XML.stringify: the top-level object must have one key naming the root element");
    this.stringifyCompactElement(root[0], root[1], false);
  }

  /** Whether a compact property value produces any output: everything but skipped scalars and arrays of only those. */
  static hasOutput(raw: unknown): boolean {
    const value = unbox(raw);
    if (skipped(value)) return false;
    if (!Array.isArray(value)) return true;
    for (const item of items(value)) if (!skipped(unbox(item))) return true;
    return false;
  }

  /** One `name: value` pair as an element (one per item for an array); `separate` puts array items on their own lines. */
  stringifyCompactElement(name: string, raw: unknown, separate: boolean): void {
    const value = unbox(raw);
    if (!isObj(value) || isDate(value)) {
      this.stringifyCompactLeaf(name, value);
      return;
    }
    this.markVisiting(value);
    try {
      if (Array.isArray(value)) this.stringifyCompactArray(name, value, separate);
      else this.stringifyCompactObject(name, value);
    } finally {
      this.visiting.delete(value);
    }
  }

  stringifyCompactArray(name: string, value: unknown[], separate: boolean): void {
    let first = true;
    for (const raw of items(value)) {
      const item = unbox(raw);
      if (skipped(item)) continue;
      if (Array.isArray(item)) throw fail(`XML.stringify: nested arrays cannot be represented (element '${name}')`);
      if (!first && separate) this.newline();
      first = false;
      this.stringifyCompactElement(name, item, separate);
    }
  }

  /** A scalar as `<name>text</name>` (or `<name/>`). */
  stringifyCompactLeaf(name: string, value: unknown): void {
    this.checkName(name, "element");
    const sc = this.scalar(value, "element content");
    if (sc.kind === "skip") return;
    if (sc.kind === "empty" || sc.text.length === 0) {
      this.out += "<" + name + "/>";
      return;
    }
    this.out += "<" + name + ">";
    this.appendText(sc.text);
    this.appendEndTag(name);
  }

  /** An object as `<name @attrs>children #text</name>`. */
  stringifyCompactObject(name: string, object: object): void {
    this.checkName(name, "element");

    // Pass 1: the start tag with `@` attributes; note what content follows.
    this.out += "<" + name;
    let hasElements = false;
    let hasText = false;
    for (const [key, child] of props(object)) {
      if (skipped(child)) continue;
      if (key.startsWith("@")) {
        const sc = this.scalar(child, "an attribute value");
        if (sc.kind === "text") this.appendAttribute(key.slice(1), sc.text);
      } else if (key === "#text") {
        const sc = this.scalar(child, "#text");
        if (sc.kind === "text" && sc.text.length > 0) hasText = true;
      } else if (key.startsWith("#")) {
        throw fail(`XML.stringify: unknown key '${key}' (keys starting with '#' are reserved; text content is "#text")`);
      } else if (XmlStringifier.hasOutput(child)) {
        hasElements = true;
      }
    }

    if (!hasElements && !hasText) {
      this.out += "/>";
      return;
    }
    this.out += ">";

    // Pass 2: child elements and text, in key order. Element-only content is indented.
    const pretty = this.pretty && !hasText;
    if (pretty) this.indent++;
    for (const [key, child] of props(object)) {
      if (skipped(child) || key.startsWith("@")) continue;
      if (key === "#text") {
        const sc = this.scalar(child, "#text");
        if (sc.kind === "text") this.appendText(sc.text);
        continue;
      }
      if (!XmlStringifier.hasOutput(child)) continue;
      if (pretty) this.newline();
      this.stringifyCompactElement(key, child, pretty);
    }
    if (pretty) {
      this.indent--;
      this.newline();
    }
    this.appendEndTag(name);
  }

  // ── values ─────────────────────────────────────────────────────────────────

  /** The text form of a leaf value; `what` names the position for errors. */
  scalar(raw: unknown, what: string): Scalar {
    const value = unbox(raw);
    if (skipped(value)) return SKIP;
    if (value === null) return EMPTY;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return { kind: "text", text: String(value) };
    }
    if (isDate(value)) {
      const t = Date.prototype.getTime.call(value);
      if (Number.isNaN(t)) throw fail("XML.stringify cannot serialize an invalid Date");
      return { kind: "text", text: Date.prototype.toISOString.call(value) };
    }
    throw fail(`XML.stringify: ${what} must be a string, number, boolean, bigint, Date, or null`);
  }

  /** Element and attribute names must match the XML `Name` production, or the output would not parse. */
  checkName(name: string, what: string): void {
    const len = name.length;
    let valid = len > 0;
    let i = 0;
    while (valid && i < len) {
      const [cp, width] = codePointAt(name, i);
      valid = i === 0 ? isNameStartChar(cp) : isNameChar(cp);
      i += width;
    }
    if (!valid) throw fail(`XML.stringify: '${name}' is not a valid XML ${what} name`);
  }

  // ── output pieces ──────────────────────────────────────────────────────────

  appendEndTag(name: string): void {
    this.out += "</" + name + ">";
  }

  /** ` name="value"` with `& < > "` and whitespace other than space escaped (§3.3.3 normalization). */
  appendAttribute(name: string, value: string): void {
    this.checkName(name, "attribute");
    this.out += " " + name + '="';
    this.appendEscaped(value, true);
    this.out += '"';
  }

  /** Character data with `& < >` and CR escaped. */
  appendText(text: string): void {
    this.appendEscaped(text, false);
  }

  appendEscaped(text: string, attribute: boolean): void {
    const len = text.length;
    let out = "";
    let i = 0;
    while (i < len) {
      const [cp, width] = codePointAt(text, i);
      i += width;
      if (cp === 0x26) out += "&amp;";
      else if (cp === 0x3c) out += "&lt;";
      else if (cp === 0x3e) out += "&gt;";
      else if (cp === 0x22 && attribute) out += "&quot;";
      else if (cp === 0x09 && attribute) out += "&#x9;";
      else if (cp === 0x0a && attribute) out += "&#xA;";
      else if (cp === 0x0d) out += "&#xD;";
      else if (!isXmlChar(cp)) throw unrepresentable(cp);
      else out += text.slice(i - width, i);
    }
    this.out += out;
  }

  newline(): void {
    const space = this.space;
    if (space.kind === "num") this.out += "\n" + " ".repeat(this.indent * space.n);
    else if (space.kind === "str") this.out += "\n" + space.s.slice(0, 10).repeat(this.indent);
  }
}

/** transpile-wasm's `xml_parse_c`: the result as JSON, or `{ error }` (Bun's SyntaxError message, or "StackOverflow"). */
export type XmlWasm = { parse(input: Uint8Array, flags: number): string | { error: string } };

/** The bytes of a Blob, read synchronously (a worker's FileReaderSync), as Bun does. */
function blobBytes(b: Blob): Uint8Array {
  const Reader = (globalThis as unknown as { FileReaderSync?: new () => { readAsArrayBuffer(b: Blob): ArrayBuffer } }).FileReaderSync;
  if (!Reader) throw new TypeError("XML.parse: a Blob can't be read synchronously here");
  return new Uint8Array(new Reader().readAsArrayBuffer(b));
}

/**
 * `Bun.XML.parse(input, options?)`: a string is text (its encoding declaration isn't acted on); a buffer or Blob is
 * bytes (BOM, UTF-16 and declared-encoding detection); anything else but null and undefined is its `String()`.
 */
function xmlParse(wasm: XmlWasm, input: unknown, options: unknown): unknown {
  if (input === undefined || input === null) throw Object.assign(new TypeError("input must be a string, ArrayBuffer, ArrayBufferView or Blob"), { code: "ERR_INVALID_ARG_TYPE" });
  let bytes: Uint8Array;
  let isBytes = true;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else if (typeof Blob === "function" && input instanceof Blob) bytes = blobBytes(input);
  else {
    bytes = new TextEncoder().encode(`${input as string}`);
    isBytes = false;
  }
  let compact = true;
  if (options !== undefined && options !== null) {
    if (typeof options !== "object") throw Object.assign(new TypeError("XML.parse options must be an object"), { code: "ERR_INVALID_ARG_TYPE" });
    const c = (options as Obj).compact;
    if (c !== undefined) {
      if (typeof c !== "boolean") throw Object.assign(new TypeError(`The "compact" property must be of type boolean, got ${typeof c}`), { code: "ERR_INVALID_ARG_TYPE" });
      compact = c;
    }
  }
  const r = wasm.parse(bytes, (compact ? 1 : 0) | (isBytes ? 2 : 0));
  if (typeof r === "string") return JSON.parse(r);
  if (r.error === "StackOverflow") throw new RangeError("Maximum call stack size exceeded.");
  throw new SyntaxError(r.error);
}

/** `Bun.XML`, over transpile-wasm's parser (`wasm` is called on first use). */
export function makeXML(wasm: () => XmlWasm): object {
  const xml = {
    parse: (input: unknown, options?: unknown) => xmlParse(wasm(), input, options),
    stringify: (value: unknown, replacer?: unknown, space?: unknown) => xmlStringify(value, replacer, space),
  };
  return xml;
}
