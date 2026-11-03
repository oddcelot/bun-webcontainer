// `Bun.YAML.stringify` / `Bun.TOML.stringify` / `Bun.JSON5.stringify`: ports of Bun's Stringifiers
// (bun/src/runtime/api/YAMLObject.rs, TOMLObject.rs, JSON5Object.rs) so the output is byte-identical.

type Obj = Record<string, unknown>;

/** `JSValue::unwrap_boxed_primitive`: `new Number(1)` etc. become their primitive. */
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

/** The own enumerable string keys, as `JSPropertyIterator` yields them. */
const keysOf = (o: object): string[] => Object.keys(o);
const isObj = (v: unknown): v is object => typeof v === "object" && v !== null;
const skipped = (v: unknown) => v === undefined || typeof v === "symbol" || typeof v === "function";

// ── YAML ──────────────────────────────────────────────────────────────────────

type AnchorName = { kind: "root" } | { kind: "item"; counter: number } | { kind: "prop"; propName: string; counter: number };
type Anchor = { anchored: boolean; used: boolean; name: AnchorName };
type Origin = { kind: "root" } | { kind: "item" } | { kind: "prop"; propName: string };
type Space = { kind: "min" } | { kind: "num"; n: number } | { kind: "str"; s: string };

function yamlSpace(spaceValue: unknown): Space {
  const space = unbox(spaceValue);
  if (typeof space === "number") {
    if (Number.isNaN(space) || space < 1) return { kind: "min" };
    return { kind: "num", n: space > 10 ? 10 : Math.trunc(space) };
  }
  if (typeof space === "string") return space.length === 0 ? { kind: "min" } : { kind: "str", s: space };
  return { kind: "min" };
}

/** `Bun.YAML.stringify(value, replacer?, space?)`; `undefined` where Bun returns it. */
export function yamlStringify(value: unknown, replacer?: unknown, space?: unknown): string | undefined {
  if (skipped(value)) return undefined;
  if (replacer !== undefined && replacer !== null) throw new Error("YAML.stringify does not support the replacer argument");
  const s = new YamlStringifier(yamlSpace(space));
  s.findAnchors(value, { kind: "root" });
  s.stringify(value);
  return s.out;
}

class YamlStringifier {
  out = "";
  indent = 0;
  /** Columns added by the `- ` prefixes of the enclosing sequence items. */
  itemOffset = 0;
  known = new Map<object, Anchor>();
  arrayItemCounter = 0;
  // always rename anchors named "root" to avoid collision with the root anchor
  propNames = new Map<string, number>([["root", 0]]);

  constructor(readonly space: Space) {}

  findAnchors(value: unknown, origin: Origin): void {
    const u = unbox(value);
    if (u === null || typeof u === "number" || typeof u === "boolean" || typeof u === "string") return;
    if (typeof u === "bigint") throw new Error("YAML.stringify cannot serialize BigInt");
    const obj = u as object;

    const existing = this.known.get(obj);
    if (existing) {
      if (existing.used) return;
      existing.used = true;
      const name = existing.name;
      if (name.kind === "item") {
        name.counter = this.arrayItemCounter++;
      } else if (name.kind === "prop") {
        const key = canUsePropNameAsAnchor(name.propName) ? name.propName : "value";
        const prev = this.propNames.get(key);
        const n = prev === undefined ? 0 : prev + 1;
        this.propNames.set(key, n);
        name.counter = n;
      }
      return;
    }

    this.known.set(obj, {
      anchored: false,
      used: false,
      name: origin.kind === "root" ? { kind: "root" } : origin.kind === "item" ? { kind: "item", counter: 0 } : { kind: "prop", propName: origin.propName, counter: 0 },
    });

    if (Array.isArray(obj)) {
      const len = obj.length;
      for (let i = 0; i < len; i++) {
        const item = obj[i];
        if (skipped(item)) continue;
        this.findAnchors(item, { kind: "item" });
      }
      return;
    }
    for (const k of keysOf(obj)) {
      const v = (obj as Obj)[k];
      if (skipped(v)) continue;
      this.findAnchors(v, { kind: "prop", propName: k });
    }
  }

  stringify(value: unknown): void {
    this.stringifyUnwrapped(unbox(value), false);
  }

  /** With `afterKey` the value follows a block-style mapping key and writes its own separator after the `:`. */
  stringifyUnwrapped(u: unknown, afterKey: boolean): void {
    if (afterKey && !isObj(u)) this.out += " ";

    if (u === null) {
      this.out += "null";
      return;
    }
    if (typeof u === "number") {
      if (u === Infinity) this.out += ".inf";
      else if (u === -Infinity) this.out += "-.inf";
      else if (Number.isNaN(u)) this.out += ".nan";
      else if (Object.is(u, -0)) this.out += "-0";
      else this.out += String(u);
      return;
    }
    if (typeof u === "bigint") throw new Error("YAML.stringify cannot serialize BigInt");
    if (typeof u === "boolean") {
      this.out += u ? "true" : "false";
      return;
    }
    if (typeof u === "string") {
      this.appendString(u);
      return;
    }

    const obj = u as object;
    let anchor = this.known.get(obj);
    if (anchor && !anchor.used) anchor = undefined;

    // An anchor or alias starts on the line after the key.
    if (anchor && afterKey) {
      afterKey = false;
      this.newline();
    }

    if (anchor) {
      this.out += anchor.anchored ? "*" : "&";
      const name = anchor.name;
      if (name.kind === "root") this.out += "root";
      else if (name.kind === "item") this.out += `item${name.counter}`;
      else if (!canUsePropNameAsAnchor(name.propName)) this.out += `value${name.counter}`;
      else {
        this.out += name.propName;
        if (name.counter !== 0) this.out += name.counter;
      }
      if (anchor.anchored) return;
      anchor.anchored = true;
      if (this.space.kind === "min") this.out += " ";
      else this.newline();
    }

    if (Array.isArray(obj)) {
      const len = obj.length;
      if (len === 0) {
        if (afterKey) this.out += " ";
        this.out += "[]";
        return;
      }
      if (this.space.kind === "min") {
        this.out += "[";
        let first = true;
        for (let i = 0; i < len; i++) {
          const item = obj[i];
          if (skipped(item)) continue;
          if (!first) this.out += ",";
          first = false;
          this.stringify(item);
        }
        this.out += "]";
      } else {
        let first = true;
        for (let i = 0; i < len; i++) {
          const item = obj[i];
          if (skipped(item)) continue;
          if (!first || afterKey) this.newline();
          first = false;
          this.out += "- ";
          this.itemOffset += 2;
          this.stringify(item);
          this.itemOffset -= 2;
        }
        if (first) {
          if (afterKey) this.out += " ";
          this.out += "[]";
        }
      }
      return;
    }

    const keys = keysOf(obj);
    if (keys.length === 0) {
      if (afterKey) this.out += " ";
      this.out += "{}";
      return;
    }
    if (this.space.kind === "min") {
      this.out += "{";
      let first = true;
      for (const k of keys) {
        const v = (obj as Obj)[k];
        if (skipped(v)) continue;
        if (!first) this.out += ",";
        first = false;
        this.appendString(k);
        this.out += ": ";
        this.stringify(v);
      }
      this.out += "}";
    } else {
      let first = true;
      for (const k of keys) {
        const v = (obj as Obj)[k];
        if (skipped(v)) continue;
        if (!first || afterKey) this.newline();
        first = false;
        this.appendString(k);
        this.out += ":";
        this.indent++;
        this.stringifyUnwrapped(unbox(v), true);
        this.indent--;
      }
      if (first) {
        if (afterKey) this.out += " ";
        this.out += "{}";
      }
    }
  }

  newline(): void {
    const sp = this.space;
    if (sp.kind === "num") {
      this.out += "\n" + " ".repeat(this.indent * sp.n);
    } else if (sp.kind === "str") {
      this.out += "\n" + sp.s.slice(0, 10).repeat(this.indent);
    }
    if (sp.kind !== "min") this.out += " ".repeat(this.itemOffset);
  }

  appendString(s: string): void {
    this.out += stringNeedsQuotes(s) ? doubleQuoted(s) : s;
  }
}

const YAML_ESCAPES: Record<number, string> = {
  0x00: "\\0", 0x07: "\\a", 0x08: "\\b", 0x09: "\\t", 0x0a: "\\n", 0x0b: "\\v", 0x0c: "\\f", 0x0d: "\\r", 0x1b: "\\e",
  0x22: '\\"', 0x5c: "\\\\", 0x7f: "\\x7f", 0x85: "\\N", 0xa0: "\\_", 0x2028: "\\L", 0x2029: "\\P",
};

function doubleQuoted(s: string): string {
  let r = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const e = YAML_ESCAPES[c];
    if (e !== undefined) r += e;
    else if (c < 0x20) r += "\\x" + c.toString(16).padStart(2, "0");
    else r += s[i];
  }
  return r + '"';
}

/** Anchor names can't be quoted, so only unambiguously safe names are reused. */
function canUsePropNameAsAnchor(s: string): boolean {
  return s.length > 0 && /^[0-9A-Za-z\-._]*$/.test(s) && !/^(?:value|item|root)[0-9]+$/.test(s);
}

const YAML_KEYWORDS = new Set([
  "true", "True", "TRUE", "false", "False", "FALSE", "yes", "Yes", "YES", "no", "No", "NO", "on", "On", "ON", "off", "Off", "OFF",
  "n", "N", "y", "Y", "null", "Null", "NULL", "~", ".inf", ".Inf", ".INF", ".nan", ".NaN", ".NAN",
]);

function stringNeedsQuotes(s: string): boolean {
  const len = s.length;
  if (len === 0) return true;
  const at = (i: number) => s.charCodeAt(i);
  switch (s[len - 1]) {
    case " ": case "\t": case "\n": case "\r": case ":":
      return true;
  }
  if ("&*?|-<>!%@:,[]{}#'\"` \t\n\r﻿".includes(s[0]!)) return true;
  if (YAML_KEYWORDS.has(s)) return true;

  const ws = (c: number) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
  const wsOrFlow = (c: number) => ws(c) || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2c;
  for (let i = 0; i < len; ) {
    const c = at(i);
    switch (c) {
      case 0x7b: case 0x7d: case 0x5b: case 0x5d: case 0x2c:
        return true;
      case 0x3a:
        if (i + 1 < len && ws(at(i + 1))) return true;
        i++;
        break;
      case 0x23: case 0x60: case 0x27:
        return true;
      case 0x2d: case 0x2e:
        if (i + 2 < len && at(i + 1) === c && at(i + 2) === c) {
          if (i + 3 >= len) return true;
          if (wsOrFlow(at(i + 3))) return true;
        }
        if (i === 0 && stringIsNumber(s)) return true;
        i++;
        break;
      case 0x2b:
        if (i === 0 && stringIsNumber(s)) return true;
        i++;
        break;
      default:
        if ((c >= 0x30 && c <= 0x39) && i === 0 && stringIsNumber(s)) return true;
        if (c <= 0x1f || c === 0x22 || c === 0x7f || c === 0x85 || c === 0xa0 || c === 0x2028 || c === 0x2029) return true;
        i++;
    }
  }
  return false;
}

/** Whether `YAML.parse` might read `s` back as a number (errs towards quoting). */
function stringIsNumber(s: string): boolean {
  const len = s.length;
  if (len === 0) return false;
  let i = 0;
  const first = s[0];
  if (first === "+" || first === "-") {
    i = 1;
    if (i >= len) return false;
    if (s[i] === "." && isInfSuffix(s, i)) return true;
  }
  let base: "dec" | "hex" | "oct" = "dec";
  if (i + 1 < len && s[i] === "0") {
    const n = s[i + 1];
    if (n === "x" || n === "X") {
      base = "hex";
      i += 2;
      if (i >= len) return false;
    } else if (n === "o" || n === "O") {
      base = "oct";
      i += 2;
      if (i >= len) return false;
    }
  }
  let sawDot = false;
  let sawExp = false;
  let sawMinus = false;
  for (; i < len; i++) {
    const c = s[i]!;
    if (c >= "0" && c <= "9") continue;
    if ((c >= "a" && c <= "d") || c === "f" || (c >= "A" && c <= "D") || c === "F") {
      if (base !== "hex") return false;
    } else if (c === "e" || c === "E") {
      if (base === "dec") {
        if (sawExp) return false;
        sawExp = true;
      }
    } else if (c === ".") {
      if (sawDot || base !== "dec") return false;
      sawDot = true;
    } else if (c === "+") {
      if (base === "hex") return false;
    } else if (c === "-") {
      if (sawMinus) return false;
      sawMinus = true;
    } else return false;
  }
  return true;
}

function isInfSuffix(s: string, i: number): boolean {
  if (i + 4 > s.length) return false;
  const t = s.slice(i + 1, i + 4);
  return t === "inf" || t === "Inf" || t === "INF";
}

// ── TOML ──────────────────────────────────────────────────────────────────────

type TemporalKind = "Instant" | "PlainDateTime" | "PlainDate" | "PlainTime" | "ZonedDateTime" | "PlainYearMonth" | "PlainMonthDay" | "Duration";
const TEMPORAL_KINDS: TemporalKind[] = ["Instant", "PlainDateTime", "PlainDate", "PlainTime", "ZonedDateTime", "PlainYearMonth", "PlainMonthDay", "Duration"];
type TemporalNs = Record<string, (new () => object) | undefined>;

function temporalKind(v: unknown): TemporalKind | undefined {
  const ns = (globalThis as { Temporal?: TemporalNs }).Temporal;
  if (!isObj(v) || !ns) return undefined;
  for (const k of TEMPORAL_KINDS) {
    const C = ns[k];
    if (C && v instanceof C) return k;
  }
  return undefined;
}

const isDate = (v: unknown): v is Date => v instanceof Date;
/** A value that becomes a `[section]` / `[[element]]`: a non-null, non-array, non-Date, non-Temporal object. */
const isPlainTable = (v: unknown): v is object =>
  isObj(v) && !Array.isArray(v) && !isDate(v) && temporalKind(v) === undefined;

type Layout = "keyval" | "temporal" | "table" | "aot" | "skip";

type Path = { parent: Path | undefined; key: string };

/** `Bun.TOML.stringify(value, replacer?)`; `undefined` where Bun returns it. */
export function tomlStringify(value: unknown, replacer?: unknown): string | undefined {
  if (skipped(value)) return undefined;
  if (replacer !== undefined && replacer !== null) throw new Error("TOML.stringify does not support the replacer argument");
  const root = unbox(value);
  if (!isObj(root) || Array.isArray(root) || isDate(root) || temporalKind(root) !== undefined) {
    throw new Error("TOML.stringify expects an object at the top level (a TOML document is a table)");
  }
  const s = new TomlStringifier();
  s.markVisiting(root);
  s.tableBody(root, undefined, false);
  s.visiting.delete(root);
  return s.out;
}

class TomlStringifier {
  out = "";
  visiting = new Set<object>();
  /** Whether any line has been written (controls blank lines before headers). */
  wrote = false;

  markVisiting(v: object): void {
    if (this.visiting.has(v)) throw new Error("Converting circular structure to TOML");
    this.visiting.add(v);
  }

  layoutOf(value: unknown): Layout {
    if (skipped(value)) return "skip";
    if (Array.isArray(value)) {
      const len = value.length;
      if (len === 0) return "keyval";
      for (let i = 0; i < len; i++) {
        if (!isPlainTable(unbox(value[i]))) return "keyval";
      }
      return "aot";
    }
    if (isObj(value) && !isDate(value)) return temporalKind(value) !== undefined ? "temporal" : "table";
    return "keyval";
  }

  /** `key = value` lines first, then `[sub.table]` / `[[array.of.tables]]` sections. */
  tableBody(table: object, path: Path | undefined, ownHeader: boolean): void {
    let headerPending = ownHeader;

    for (const k of keysOf(table)) {
      const value = unbox((table as Obj)[k]);
      if (value === null) throw nullValue(k);
      const layout = this.layoutOf(value);
      if (layout === "table" || layout === "aot" || layout === "skip") continue;
      if (headerPending) {
        headerPending = false;
        this.header(path, false);
      }
      this.out += keySegment(k) + " = ";
      this.inlineValue(value);
      this.out += "\n";
      this.wrote = true;
    }

    for (const k of keysOf(table)) {
      const value = unbox((table as Obj)[k]);
      const layout = this.layoutOf(value);
      if (layout === "table") {
        headerPending = false;
        const t = value as object;
        this.markVisiting(t);
        this.tableBody(t, { parent: path, key: k }, true);
        this.visiting.delete(t);
      } else if (layout === "aot") {
        headerPending = false;
        const arr = value as unknown[];
        this.markVisiting(arr);
        const child: Path = { parent: path, key: k };
        for (let i = 0; i < arr.length; i++) {
          const item = unbox(arr[i]);
          if (!isPlainTable(item)) throw new Error("TOML.stringify cannot serialize a value that changed during serialization");
          this.markVisiting(item);
          this.header(child, true);
          this.tableBody(item, child, false);
          this.visiting.delete(item);
        }
        this.visiting.delete(arr);
      }
    }

    // An empty table is materialized only by its header.
    if (headerPending) this.header(path, false);
  }

  inlineValue(value: unknown): void {
    if (typeof value === "boolean") {
      this.out += value ? "true" : "false";
      return;
    }
    if (typeof value === "number") {
      this.out += tomlNumber(value);
      return;
    }
    if (typeof value === "bigint") throw new Error("TOML.stringify cannot serialize BigInt");
    if (typeof value === "string") {
      this.out += basicQuoted(value);
      return;
    }
    if (isDate(value)) {
      this.out += tomlDate(value);
      return;
    }
    const tk = temporalKind(value);
    if (tk !== undefined) {
      this.out += tomlTemporal(value as object, tk);
      return;
    }
    if (Array.isArray(value)) {
      this.markVisiting(value);
      this.out += "[";
      for (let i = 0; i < value.length; i++) {
        if (i > 0) this.out += ", ";
        const item = unbox(value[i]);
        if (item === null || skipped(item)) {
          const what = item === null ? "null" : item === undefined ? "undefined" : typeof item === "symbol" ? "a symbol" : "a function";
          throw new Error(`TOML cannot represent ${what} in an array`);
        }
        this.inlineValue(item);
      }
      this.out += "]";
      this.visiting.delete(value);
      return;
    }

    // A plain object inside an inline context becomes an inline table.
    const obj = value as object;
    this.markVisiting(obj);
    let first = true;
    for (const k of keysOf(obj)) {
      const pv = unbox((obj as Obj)[k]);
      if (skipped(pv)) continue;
      if (pv === null) throw nullValue(k);
      this.out += first ? "{ " : ", ";
      first = false;
      this.out += keySegment(k) + " = ";
      this.inlineValue(pv);
    }
    this.out += first ? "{}" : " }";
    this.visiting.delete(obj);
  }

  /** `[a.b.c]` or `[[a.b.c]]`, preceded by a blank line when the document already has content. */
  header(path: Path | undefined, arrayOfTables: boolean): void {
    if (this.wrote) this.out += "\n";
    this.out += arrayOfTables ? "[[" : "[";
    if (path) {
      const chain: string[] = [];
      for (let p: Path | undefined = path; p; p = p.parent) chain.push(keySegment(p.key));
      this.out += chain.reverse().join(".");
    }
    this.out += arrayOfTables ? "]]\n" : "]\n";
    this.wrote = true;
  }
}

const nullValue = (key: string) => new Error(`TOML cannot represent null (key '${key}'); remove the key or use a sentinel value`);

const keySegment = (name: string): string => (/^[A-Za-z0-9_-]+$/.test(name) ? name : basicQuoted(name));

function tomlNumber(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0";
  let s = String(n);
  // Integral doubles beyond the safe range would read back as out-of-range integers; mark them as floats.
  if (Number.isInteger(n) && Math.abs(n) > Number.MAX_SAFE_INTEGER && Math.abs(n) < 1e21) s += ".0";
  return s;
}

function tomlDate(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error("TOML.stringify cannot serialize an invalid Date");
  const iso = d.toISOString();
  if (!/^\d/.test(iso)) throw new Error("TOML.stringify cannot serialize a Date outside years 0000-9999");
  // Trim trailing fraction zeros (and a bare `.`) like Temporal.Instant spells the same instant.
  return iso.slice(0, 19) + iso.slice(19, 23).replace(/\.?0*$/, "") + "Z";
}

type TemporalLike = { toString(options?: object): string };

function tomlTemporal(v: object, kind: TemporalKind): string {
  const name = `Temporal.${kind}`;
  if (kind === "PlainYearMonth" || kind === "PlainMonthDay" || kind === "Duration") {
    throw new Error(`TOML.stringify cannot serialize ${name} (it has no TOML representation)`);
  }
  const t = v as TemporalLike;
  const s = kind === "ZonedDateTime" ? t.toString({ timeZoneName: "never", calendarName: "never" }) : kind === "PlainTime" || kind === "Instant" ? t.toString() : t.toString({ calendarName: "never" });
  if (kind !== "PlainTime" && !/^\d{4}-/.test(s)) throw new Error(`TOML.stringify cannot serialize a ${name} outside years 0000-9999`);
  return s;
}

/** TOML basic string. Unpaired surrogates become U+FFFD. */
function basicQuoted(s: string): string {
  let r = '"';
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x08: r += "\\b"; break;
      case 0x09: r += "\\t"; break;
      case 0x0a: r += "\\n"; break;
      case 0x0c: r += "\\f"; break;
      case 0x0d: r += "\\r"; break;
      case 0x22: r += '\\"'; break;
      case 0x5c: r += "\\\\"; break;
      default:
        if (c <= 0x1f || c === 0x7f) r += "\\u00" + c.toString(16).padStart(2, "0");
        else if (c >= 0xd800 && c <= 0xdbff) {
          const n = i + 1 < len ? s.charCodeAt(i + 1) : 0;
          if (n >= 0xdc00 && n <= 0xdfff) {
            r += s[i]! + s[i + 1]!;
            i++;
          } else r += "�";
        } else if (c >= 0xdc00 && c <= 0xdfff) r += "�";
        else r += s[i];
    }
  }
  return r + '"';
}

// ── JSON5 ─────────────────────────────────────────────────────────────────────

/** `Bun.JSON5.stringify(value, replacer?, space?)`; `undefined` where Bun returns it. No `toJSON`, as in Bun. */
export function json5Stringify(value: unknown, replacer?: unknown, space?: unknown): string | undefined {
  if (skipped(value)) return undefined;
  if (replacer !== undefined && replacer !== null) throw new Error("JSON5.stringify does not support the replacer argument");
  const sp = yamlSpace(space);
  const unit = sp.kind === "num" ? " ".repeat(sp.n) : sp.kind === "str" ? sp.s.slice(0, 10) : "";
  const visiting = new Set<object>();
  let out = "";
  let indent = 0;
  const newline = () => {
    if (sp.kind !== "min") out += "\n" + unit.repeat(indent);
  };
  const item = (v: unknown) => (skipped(v) ? (out += "null") : write(v));
  const write = (value: unknown): void => {
    const v = unbox(value);
    if (v === null) out += "null";
    else if (typeof v === "number") out += String(v);
    else if (typeof v === "bigint") throw new Error("JSON5.stringify cannot serialize BigInt");
    else if (typeof v === "boolean") out += v ? "true" : "false";
    else if (typeof v === "string") out += json5Quoted(v);
    else if (isObj(v)) {
      if (visiting.has(v)) throw new Error("Converting circular structure to JSON5");
      visiting.add(v);
      if (Array.isArray(v)) {
        if (v.length === 0) out += "[]";
        else {
          out += "[";
          indent++;
          for (let i = 0; i < v.length; i++) {
            if (i > 0) out += ",";
            newline();
            item(v[i]);
          }
          if (sp.kind !== "min") out += ",";
          indent--;
          newline();
          out += "]";
        }
      } else {
        const keys = keysOf(v);
        if (keys.length === 0) out += "{}";
        else {
          out += "{";
          indent++;
          let first = true;
          for (const k of keys) {
            const u = (v as Obj)[k];
            if (skipped(u)) continue;
            if (!first) out += ",";
            first = false;
            newline();
            out += (isJson5Identifier(k) ? k : json5Quoted(k)) + (sp.kind === "min" ? ":" : ": ");
            write(u);
          }
          indent--;
          if (!first && sp.kind !== "min") {
            out += ",";
            newline();
          }
          out += "}";
        }
      }
      visiting.delete(v);
    }
  };
  write(value);
  return out;
}

const ID_START = /[\p{ID_Start}$_]/u;
const ID_CONTINUE = /[\p{ID_Continue}$\u200c\u200d]/u;
/** `lexer::is_identifier_start`/`_continue` per UTF-16 unit, so a key with an astral character is quoted, as in Bun. */
function isJson5Identifier(k: string): boolean {
  if (!k || !ID_START.test(k[0]!)) return false;
  for (let i = 1; i < k.length; i++) if (!ID_CONTINUE.test(k[i]!)) return false;
  return true;
}

const JSON5_ESCAPES: Record<number, string> = { 0: "\\0", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r", 0x27: "\\'", 0x5c: "\\\\", 0x2028: "\\u2028", 0x2029: "\\u2029" };
function json5Quoted(s: string): string {
  let r = "'";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const e = JSON5_ESCAPES[c];
    if (e) r += e;
    else if (c < 0x20 || c === 0x7f) r += "\\x" + c.toString(16).padStart(2, "0");
    else r += s[i];
  }
  return r + "'";
}
