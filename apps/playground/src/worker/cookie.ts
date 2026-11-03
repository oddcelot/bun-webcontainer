// `Bun.Cookie` and `Bun.CookieMap`, following bun/src/jsc/bindings/{Cookie,CookieMap}.cpp and webcore/JSCookie*.cpp.
import { codeError } from "./node/errors";
import { inspect } from "./node/util";

type SameSite = "strict" | "lax" | "none";
type Init = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Milliseconds since the epoch; undefined for a session cookie. */
  expires: number | undefined;
  /** undefined when not set (Bun's NaN). */
  maxAge: number | undefined;
  secure: boolean;
  sameSite: SameSite;
  httpOnly: boolean;
  partitioned: boolean;
};

type WellFormable = string & { toWellFormed(): string }; // ES2024, past the project's lib
const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
const typeError = (message: string) => new TypeError(message);
const missingArgs = () => codeError(TypeError, "ERR_MISSING_ARGS", "Not enough arguments");
const isObject = (v: unknown): v is Record<string, unknown> => (typeof v === "object" && v !== null) || typeof v === "function";
/** WebIDL USVString: ToString, lone surrogates replaced. */
const usv = (v: unknown): string => {
  if (typeof v === "symbol") throw typeError("Cannot convert a Symbol value to a string");
  return (`${v as string}` as WellFormable).toWellFormed();
};
/** RFC 6265 attribute whitespace (WTF's isASCIIWhitespace). */
const trim = (s: string) => s.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "");

const defaults = (name = "", value = ""): Init => ({ name, value, domain: "", path: "/", expires: undefined, maxAge: undefined, secure: false, sameSite: "lax", httpOnly: false, partitioned: false });

// Bun's validity checks; on the first failure `create` throws.
const validName = (s: string) => /^[!-:<>-~]+$/.test(s);
const validPath = (s: string) => /^[ -:=-~]*$/.test(s);
const validDomain = (s: string) => /^[a-z0-9.-]*$/.test(s);
const validHeaderValue = (s: string) => !/^[ \t]|[ \t]$|[\0\r\n]/.test(s);

function checkInit(i: Init): Init {
  if (!validName(i.name)) throw typeError("Invalid cookie name: contains invalid characters");
  if (!validPath(i.path)) throw typeError("Invalid cookie path: contains invalid characters");
  if (!validDomain(i.domain)) throw typeError("Invalid cookie domain: contains invalid characters");
  return i;
}

/** WTF::parseDate is the legacy parser only: ISO dates are NaN there, though Date.parse takes them. */
const parseLegacyDate = (s: string) => (/^[ \t]*[+-]?\d{4,6}-\d\d/.test(s) ? NaN : Date.parse(s));

/** Cookie `expires` input to epoch milliseconds (a number is seconds, as in Bun). */
function toExpires(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Date) {
    const t = v.getTime();
    if (!Number.isFinite(t)) throw new RangeError("expires must be a valid Date (or Number)");
    return Math.trunc(t);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("expires must be a valid Number (or Date)");
    return Math.trunc(v * 1000);
  }
  if (typeof v === "string") {
    // Bun tests the parsed value for truthiness, so 0 (the epoch) is rejected too.
    const t = parseLegacyDate(usv(v));
    if (!t) throw typeError("Invalid cookie expiration date");
    return Math.trunc(t);
  }
  throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'expires' Invalid expires value. Must be a Date or a number. Received ${typeof v === "symbol" ? "symbol" : inspect(v)}`);
}

function toSameSite(v: string, ignoreCase: boolean): SameSite {
  const s = ignoreCase ? v.toLowerCase() : v;
  if (s === "strict" || s === "lax" || s === "none") return s;
  throw typeError("Invalid sameSite value. Must be 'strict', 'lax', or 'none'");
}

/** Bun's `CookieInit::fromJS`: reads an options object; `withName` also reads name and value from it. */
function fromOptions(options: unknown, withName: boolean, name = "", value = ""): Init {
  const init = defaults(name, value);
  if (options === undefined || options === null) {
    if (withName) throw typeError("name is required");
    return init;
  }
  if (!isObject(options)) throw typeError("Options must be an object");
  const o = options;
  if (withName) {
    if ("name" in o) init.name = usv(o.name);
    if (!init.name) throw typeError("name is required");
    if ("value" in o) init.value = usv(o.value);
  }
  if ("domain" in o && o.domain != null) init.domain = usv(o.domain);
  if ("path" in o && o.path != null) init.path = usv(o.path);
  if ("expires" in o) init.expires = toExpires(o.expires);
  if ("maxAge" in o && typeof o.maxAge === "number" && !Number.isNaN(o.maxAge)) init.maxAge = o.maxAge;
  if ("secure" in o && o.secure !== undefined) init.secure = !!o.secure;
  if ("httpOnly" in o && o.httpOnly !== undefined) init.httpOnly = !!o.httpOnly;
  if ("partitioned" in o && o.partitioned !== undefined) init.partitioned = !!o.partitioned;
  if ("sameSite" in o && o.sameSite != null) init.sameSite = toSameSite(usv(o.sameSite), false);
  return init;
}

/** `Cookie.parse`: a Set-Cookie header (or the first `name=value` of a Cookie header) with its attributes. */
function parseSetCookie(header: string): Init {
  if (header.length < 2) throw typeError("Invalid cookie string: empty");
  const semi = header.indexOf(";");
  const pair = semi < 0 ? header : header.slice(0, semi);
  const eq = pair.indexOf("=");
  if (eq < 0) throw typeError("Invalid cookie string: no '=' found");
  const name = trim(pair.slice(0, eq));
  if (!name) throw typeError("Invalid cookie string: name cannot be empty");
  const init = defaults(name, trim(pair.slice(eq + 1)));
  if (semi >= 0) {
    for (const attr of header.slice(semi + 1).split(";")) {
      const a = trim(attr);
      const i = a.indexOf("=");
      const key = (i < 0 ? a : trim(a.slice(0, i))).toLowerCase();
      const val = i < 0 ? "" : trim(a.slice(i + 1));
      // Each attribute is recorded independently, the last one wins (RFC 6265 5.2).
      switch (key) {
        case "domain":
          if (val) init.domain = val.toLowerCase();
          break;
        case "path":
          if (val.startsWith("/")) init.path = val;
          break;
        case "expires": {
          const t = val ? parseLegacyDate(val) : NaN;
          if (Number.isFinite(t)) init.expires = Math.trunc(t);
          break;
        }
        case "max-age": {
          const m = /^[+-]?\d+/.exec(val);
          if (m && Math.abs(Number(m[0])) < 2 ** 63) init.maxAge = Number(m[0]);
          break;
        }
        case "secure":
          init.secure = true;
          break;
        case "httponly":
          init.httpOnly = true;
          break;
        case "partitioned":
          init.partitioned = true;
          break;
        case "samesite": {
          const s = val.toLowerCase();
          if (s === "strict" || s === "lax" || s === "none") init.sameSite = s;
          break;
        }
      }
    }
  }
  return checkInit(init);
}

/** Wraps an Init so static factories can reach the constructor. */
class Prepared {
  constructor(readonly init: Init) {}
}

export class Cookie {
  #i: Init;
  #date: Date | undefined;

  constructor(name: string, value: string, options?: CookieOptions);
  constructor(init: string | (CookieOptions & { name: string; value?: string }));
  /** @internal for the static factories */
  constructor(prepared: Prepared);
  constructor(...args: unknown[]) {
    if (args[0] instanceof Prepared) {
      this.#i = args[0].init;
      return;
    }
    const [a, b] = args;
    let init: Init;
    if (args.length === 1 && typeof a === "string") {
      const s = usv(a);
      if (!validHeaderValue(s)) throw typeError("cookie string is not a valid HTTP header value");
      init = parseSetCookie(s);
    } else if (args.length === 1 && isObject(a)) {
      init = checkInit(fromOptions(a, true));
    } else if (args.length >= 2) {
      const name = usv(a);
      if (!name) throw typeError("name is required");
      const value = usv(b);
      init = checkInit(args.length > 2 ? fromOptions(args[2], false, name, value) : defaults(name, value));
    } else {
      throw missingArgs();
    }
    this.#i = init;
  }

  /** Parses a Set-Cookie (or Cookie) header string. */
  static parse(cookie: string): Cookie {
    if (arguments.length < 1) throw missingArgs();
    const s = usv(cookie);
    if (!s) return new Cookie(new Prepared(checkInit(defaults()))); // throws: the name is empty
    if (!validHeaderValue(s)) throw typeError("cookie string is not a valid HTTP header value");
    return new Cookie(new Prepared(parseSetCookie(s)));
  }

  static from(name: string, value: string, options?: CookieOptions): Cookie {
    if (arguments.length < 2) throw missingArgs();
    const n = usv(name);
    if (!n) throw typeError("name is required");
    const v = usv(value);
    return new Cookie(new Prepared(checkInit(isObject(options) ? fromOptions(options, false, n, v) : defaults(n, v))));
  }

  get name(): string {
    return this.#i.name;
  }
  /** Read-only: assigning is silently ignored, as in Bun. */
  set name(_v: string) {}
  get value(): string {
    return this.#i.value;
  }
  set value(v: string) {
    this.#i.value = usv(v);
  }
  get domain(): string | null {
    return this.#i.domain || null;
  }
  set domain(v: string | null) {
    const s = usv(v);
    if (!validDomain(s)) throw typeError("Invalid cookie domain: contains invalid characters");
    this.#i.domain = s;
  }
  get path(): string {
    return this.#i.path;
  }
  set path(v: string) {
    const s = usv(v);
    if (!validPath(s)) throw typeError("Invalid cookie path: contains invalid characters");
    this.#i.path = s;
  }
  get expires(): Date | undefined {
    const ms = this.#i.expires;
    if (ms === undefined) return undefined;
    if (this.#date?.getTime() !== ms) this.#date = new Date(ms);
    return this.#date;
  }
  set expires(v: Date | number | string | undefined) {
    this.#i.expires = toExpires(v);
    this.#date = undefined;
  }
  get maxAge(): number | undefined {
    return this.#i.maxAge;
  }
  set maxAge(v: number | undefined) {
    const n = v === undefined || v === null ? NaN : Number(v);
    this.#i.maxAge = Number.isNaN(n) ? undefined : n;
  }
  get secure(): boolean {
    return this.#i.secure;
  }
  set secure(v: boolean) {
    this.#i.secure = !!v;
  }
  get httpOnly(): boolean {
    return this.#i.httpOnly;
  }
  set httpOnly(v: boolean) {
    this.#i.httpOnly = !!v;
  }
  get sameSite(): SameSite {
    return this.#i.sameSite;
  }
  set sameSite(v: SameSite) {
    this.#i.sameSite = toSameSite(usv(v), true);
  }
  get partitioned(): boolean {
    return this.#i.partitioned;
  }
  set partitioned(v: boolean) {
    this.#i.partitioned = !!v;
  }

  /** Max-Age wins over Expires (RFC 6265 5.3); a session cookie never expires. */
  isExpired(): boolean {
    const { maxAge, expires } = this.#i;
    if (maxAge !== undefined) return maxAge <= 0;
    return expires !== undefined && Date.now() > expires;
  }

  serialize(): string {
    return this.toString();
  }

  toString(): string {
    const i = this.#i;
    let s = `${i.name}=${encodeURIComponent(i.value)}`;
    if (i.domain) s += `; Domain=${i.domain}`;
    if (i.path) s += `; Path=${i.path}`;
    if (i.expires !== undefined) s += `; Expires=${new Date(i.expires).toUTCString()}`;
    if (i.maxAge !== undefined) s += `; Max-Age=${i.maxAge}`;
    if (i.secure) s += "; Secure";
    if (i.httpOnly) s += "; HttpOnly";
    if (i.partitioned) s += "; Partitioned";
    return `${s}; SameSite=${i.sameSite === "strict" ? "Strict" : i.sameSite === "lax" ? "Lax" : "None"}`;
  }

  toJSON(): Record<string, unknown> {
    const i = this.#i;
    const o: Record<string, unknown> = Object.create(null);
    o.name = i.name;
    o.value = i.value;
    if (i.domain) o.domain = i.domain;
    o.path = i.path;
    if (i.expires !== undefined) o.expires = new Date(i.expires);
    if (i.maxAge !== undefined) o.maxAge = i.maxAge;
    o.secure = i.secure;
    o.sameSite = i.sameSite;
    o.httpOnly = i.httpOnly;
    o.partitioned = i.partitioned;
    return o;
  }

  [inspectCustom](): Record<string, unknown> {
    return this.toJSON();
  }

  get [Symbol.toStringTag]() {
    return "Cookie";
  }
}

Object.defineProperty(Cookie, "length", { value: 2 });

export type CookieOptions = {
  domain?: string | null;
  path?: string | null;
  expires?: number | Date | string | null;
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  partitioned?: boolean;
  sameSite?: SameSite;
};

/** Port of Bun's decodeURIComponentSIMD over UTF-8 bytes: invalid escapes become U+FFFD, not errors. */
function decodeCookieValue(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const end = bytes.length;
  const dec = new TextDecoder();
  const hex = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : 255);
  /** The byte of the `%XX` at `p`, or -1 when it is not a (complete, valid) escape. */
  const escape = (p: number) => {
    if (p + 2 >= end || bytes[p] !== 37) return -1;
    const h = hex(bytes[p + 1]);
    const l = hex(bytes[p + 2]);
    return h > 15 || l > 15 ? -1 : (h << 4) | l;
  };
  let out = "";
  let p = 0;
  while (p < end) {
    if (bytes[p] !== 37) {
      let q = p;
      while (q < end && bytes[q] !== 37) q++;
      out += dec.decode(bytes.subarray(p, q));
      p = q;
      continue;
    }
    const b = escape(p);
    if (b < 0) {
      out += "�";
      p += p + 2 < end ? 3 : 1;
      continue;
    }
    if (b < 0x80) {
      out += String.fromCharCode(b);
      p += 3;
      continue;
    }
    const more = (b & 0xe0) === 0xc0 ? 1 : (b & 0xf0) === 0xe0 ? 2 : (b & 0xf8) === 0xf0 ? 3 : 0;
    if (!more) {
      out += "�";
      p += 3;
      continue;
    }
    let cp = b & (0xff >> (more + 2));
    p += 3;
    let ok = true;
    for (let k = 0; k < more; k++) {
      const c = escape(p);
      if (c < 0 || (c & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (c & 0x3f);
      p += 3;
    }
    const min = [0, 0x80, 0x800, 0x10000][more];
    const max = [0, 0x7ff, 0xffff, 0x10ffff][more];
    out += ok && cp >= min && cp <= max && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
  }
  return out;
}

type Pair = [string, string];
type IterKind = "entries" | "keys" | "values";

/** Live iterator over a CookieMap: an index into its changes, then its original cookies. */
class CookieMapIterator {
  #map: CookieMap;
  #kind: IterKind;
  #index = 0;
  #done = false;
  constructor(map: CookieMap, kind: IterKind) {
    this.#map = map;
    this.#kind = kind;
  }
  next(): IteratorResult<string | Pair> {
    if (!this.#done) {
      const [pair, next] = nextPair(this.#map, this.#index);
      this.#index = next;
      if (pair) return { value: this.#kind === "entries" ? pair : this.#kind === "keys" ? pair[0] : pair[1], done: false };
      this.#done = true;
    }
    return { value: undefined, done: true };
  }
  [Symbol.iterator]() {
    return this;
  }
  get [Symbol.toStringTag]() {
    return "CookieMap Iterator";
  }
}
Object.setPrototypeOf(CookieMapIterator.prototype, Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())));

// CookieMap's state is shared with its iterators.
const state = new WeakMap<CookieMap, { original: Pair[]; changes: Cookie[] }>();
const stateOf = (m: CookieMap) => {
  const s = state.get(m);
  if (!s) throw typeError("Value of \"this\" must be of type CookieMap");
  return s;
};

/** The `index`th entry: changes first (a deleted cookie, with an empty value, is skipped), then the originals. */
function nextPair(m: CookieMap, index: number): [Pair | undefined, number] {
  const { original, changes } = stateOf(m);
  while (index < changes.length + original.length) {
    if (index >= changes.length) return [original[index - changes.length], index + 1];
    const c = changes[index++];
    if (c.value) return [[c.name, c.value], index];
  }
  return [undefined, index];
}

function parseCookieHeader(header: string): Pair[] {
  const percent = header.includes("%");
  const pairs: Pair[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = trim(part.slice(0, eq));
    if (!name) continue;
    const value = trim(part.slice(eq + 1));
    pairs.push([name, percent ? decodeCookieValue(value) : value]);
  }
  return pairs;
}

/** ToString without the USV step, as the constructor's pairs go through. */
const plain = (v: unknown): string => {
  if (typeof v === "symbol") throw typeError("Cannot convert a symbol to a string");
  return `${v as string}`;
};

export class CookieMap {
  constructor(init?: string | string[][] | Record<string, string> | null) {
    let original: Pair[];
    if (init === undefined || init === null || init === "") {
      original = [];
    } else if (typeof init === "string") {
      original = parseCookieHeader(init);
    } else if (Array.isArray(init)) {
      original = [];
      for (const el of init as unknown[]) {
        if (!Array.isArray(el)) throw typeError("Expected each element to be an array of two strings");
        if (el.length !== 2) throw typeError("Expected arrays of exactly two strings");
        original.push([plain(el[0]), plain(el[1])]);
      }
    } else if (isObject(init)) {
      original = [];
      for (const key of Reflect.ownKeys(init)) {
        if (typeof key === "string") original.push([key, plain(init[key])]);
      }
    } else {
      throw typeError("Invalid initializer type");
    }
    state.set(this, { original, changes: [] });
  }

  get size(): number {
    const { original, changes } = stateOf(this);
    return original.length + changes.filter(c => c.value).length;
  }

  get(name: string): string | null {
    const { original, changes } = stateOf(this);
    if (arguments.length < 1) return null;
    const n = usv(name);
    const c = changes.find(c => c.name === n);
    // A set cookie with an empty value counts as absent: that is what delete() leaves.
    if (c) return c.value || null;
    return original.find(p => p[0] === n)?.[1] ?? null;
  }

  has(name: string): boolean {
    stateOf(this);
    return arguments.length >= 1 && this.get(name) !== null;
  }

  set(name: string, value: string, options?: CookieOptions): void;
  set(options: CookieOptions & { name: string; value?: string }): void;
  set(cookie: Cookie): void;
  set(...args: unknown[]): void {
    const s = stateOf(this);
    if (args.length < 1) return;
    const a = args[0];
    let cookie: Cookie;
    if (a instanceof Cookie) {
      cookie = a;
    } else if (isObject(a)) {
      cookie = new Cookie(new Prepared(checkInit(fromOptions(a, true))));
    } else {
      if (args.length < 2) throw missingArgs();
      const name = usv(a);
      const value = usv(args[1]);
      cookie = new Cookie(new Prepared(checkInit(args.length >= 3 ? fromOptions(args[2], false, name, value) : defaults(name, value))));
    }
    this.#remove(s, cookie.name);
    s.changes.push(cookie);
  }

  delete(name: string, options?: { domain?: string; path?: string }): void;
  delete(options: { name: string; domain?: string; path?: string }): void;
  delete(...args: unknown[]): void {
    const s = stateOf(this);
    if (args.length < 1) return;
    let nameArg: unknown;
    let options: unknown;
    if (isObject(args[0])) {
      options = args[0];
    } else {
      nameArg = args[0];
      if (args.length >= 2) {
        options = args[1];
        if (!isObject(options)) throw typeError("Options must be an object");
      }
    }
    let domain = "";
    let path = "/";
    if (isObject(options)) {
      if (nameArg === undefined) nameArg = options.name;
      if ("domain" in options && options.domain != null) domain = usv(options.domain);
      if ("path" in options && options.path != null) path = usv(options.path);
    }
    if (typeof nameArg !== "string") throw typeError("Cookie name is required");
    const name = usv(nameArg);
    this.#remove(s, name);
    // An expired cookie with no value: toSetCookieHeaders() then tells the client to drop it.
    const secure = /^__(secure|host)-/i.test(name);
    s.changes.push(new Cookie(new Prepared(checkInit({ ...defaults(name), domain, path, expires: 1, secure }))));
  }

  #remove(s: { original: Pair[]; changes: Cookie[] }, name: string) {
    s.original = s.original.filter(p => p[0] !== name);
    s.changes = s.changes.filter(c => c.name !== name);
  }

  /** One Set-Cookie header per cookie set or deleted. */
  toSetCookieHeaders(): string[] {
    return stateOf(this).changes.map(c => c.toString());
  }

  toJSON(): Record<string, string> {
    const { original, changes } = stateOf(this);
    const o: Record<string, string> = {};
    const seen = new Set<string>();
    const put = (k: string, v: string) => Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
    for (const c of changes) {
      if (!c.value) continue;
      seen.add(c.name);
      put(c.name, c.value);
    }
    for (const [k, v] of original) {
      if (!seen.has(k)) {
        seen.add(k);
        put(k, v);
      }
    }
    return o;
  }

  entries(): IterableIterator<Pair> {
    stateOf(this);
    return new CookieMapIterator(this, "entries") as unknown as IterableIterator<Pair>;
  }
  keys(): IterableIterator<string> {
    stateOf(this);
    return new CookieMapIterator(this, "keys") as unknown as IterableIterator<string>;
  }
  values(): IterableIterator<string> {
    stateOf(this);
    return new CookieMapIterator(this, "values") as unknown as IterableIterator<string>;
  }
  declare [Symbol.iterator]: () => IterableIterator<Pair>;

  forEach(callback: (value: string, key: string, map: CookieMap) => void, thisArg?: unknown): void {
    stateOf(this);
    if (typeof callback !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Cannot call callback on a non-function");
    for (const [k, v] of this.entries()) callback.call(thisArg, v, k, this);
  }

  [inspectCustom](): Record<string, string> {
    return this.toJSON();
  }

  get [Symbol.toStringTag]() {
    return "CookieMap";
  }
}
Object.defineProperty(CookieMap.prototype, Symbol.iterator, { value: CookieMap.prototype.entries, writable: true, configurable: true });
