// `Bun.JSONL`: `parse` and `parseChunk`, as Bun's (BunObject.cpp over JSC's `streamingJSONParse`, LiteralParser.cpp):
// one JSON value per line. A value's end is found by a scan that fails where JSC's lexer does, so that a value cut off
// by the end of the input (more data needed) is told from one that is wrong (an error); the value itself is
// `JSON.parse`d. No imports: the data-API tests import this file outside the playground.

type Status = "complete" | "more" | "error";
type Result = { values: unknown[]; consumed: number; status: Status };

/** Where a value's scan failed: the lexer's position after the bad token (at the input's end: more data needed). */
class Fail {
  constructor(public at: number) {}
}

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isIdent = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x24;
/** JSC's one-character tokens: `{ } [ ] : , ( ) . = ;`. */
const PUNCTUATION = "{}[]:,().=;";

/** A token: its kind (`string`; `value` for a number or literal; `end`; `bad` for what isn't JSON; else the punctuation) and where it ends. */
type Token = { kind: string; end: number };

/**
 * JSC's `Lexer::lex` from `i`: a bad token ends where the lexer stopped (an identifier-like run is consumed, other
 * characters are not), and a string or number that can't be lexed throws a Fail where the lexer stopped.
 */
function lex(s: string, i: number): Token {
  const n = s.length;
  while (i < n && isSpace(s.charCodeAt(i))) i++;
  if (i >= n) return { kind: "end", end: n };
  const c = s.charCodeAt(i);
  if (c === 0x22) {
    for (let j = i + 1; j < n; j++) {
      const d = s.charCodeAt(j);
      if (d === 0x22) return { kind: "string", end: j + 1 };
      if (d < 0x20) throw new Fail(j);
      if (d === 0x5c) {
        j++;
        if (j >= n) throw new Fail(n);
        const e = s[j];
        if (e === "u") {
          if (n - j < 5) throw new Fail(j);
          for (let k = 1; k < 5; k++) if (!isHex(s.charCodeAt(j + k))) throw new Fail(j);
          j += 4;
        } else if (!'"\\/bfnrt'.includes(e)) throw new Fail(j);
      }
    }
    throw new Fail(n);
  }
  if (c === 0x2d || isDigit(c)) {
    let j = i;
    if (c === 0x2d && ++j >= n) throw new Fail(n);
    if (!isDigit(s.charCodeAt(j))) throw new Fail(j);
    if (s.charCodeAt(j) === 0x30) j++;
    else while (j < n && isDigit(s.charCodeAt(j))) j++;
    if (s.charCodeAt(j) === 0x2e) {
      j++;
      if (j >= n) throw new Fail(n);
      if (!isDigit(s.charCodeAt(j))) throw new Fail(j);
      while (j < n && isDigit(s.charCodeAt(j))) j++;
    }
    const e = s.charCodeAt(j);
    if (e === 0x65 || e === 0x45) {
      // An exponent only with its digits; else the number ends before the `e`.
      let k = j + 1;
      if (s.charCodeAt(k) === 0x2b || s.charCodeAt(k) === 0x2d) k++;
      if (isDigit(s.charCodeAt(k))) {
        while (k < n && isDigit(s.charCodeAt(k))) k++;
        j = k;
      }
    }
    return { kind: "value", end: j };
  }
  for (const word of ["true", "false", "null"]) if (s.startsWith(word, i)) return { kind: "value", end: i + word.length };
  if (isIdent(c)) {
    let j = i;
    while (j < n && isIdent(s.charCodeAt(j))) j++;
    return { kind: "bad", end: j };
  }
  if (PUNCTUATION.includes(s[i])) return { kind: s[i], end: i + 1 };
  return { kind: "bad", end: i };
}

/** The end of the JSON value at `i`, or throws a Fail. */
function scanValue(s: string, i: number): number {
  const value = (t: Token): number => {
    if (t.kind === "value" || t.kind === "string") return t.end;
    if (t.kind === "{" || t.kind === "[") {
      const close = t.kind === "{" ? "}" : "]";
      let next = lex(s, t.end);
      if (next.kind === close) return next.end;
      for (;;) {
        if (close === "}") {
          // A key: a string, then `:`.
          if (next.kind !== "string") throw new Fail(next.end);
          next = lex(s, next.end);
          if (next.kind !== ":") throw new Fail(next.end);
          next = lex(s, next.end);
        }
        const end = value(next);
        next = lex(s, end);
        if (next.kind === close) return next.end;
        if (next.kind !== ",") throw new Fail(next.end);
        next = lex(s, next.end);
      }
    }
    throw new Fail(t.end);
  };
  return value(lex(s, i));
}

/** JSC's `tryStreamingParse`: the values, how far the last one reaches (`consumed`), and why it stopped. */
function streamingParse(s: string): Result {
  const values: unknown[] = [];
  let consumed = 0;
  let i = 0;
  for (;;) {
    while (i < s.length && isSpace(s.charCodeAt(i))) i++;
    if (i >= s.length) return { values, consumed, status: "complete" };
    let end: number;
    try {
      end = scanValue(s, i);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      return { values, consumed, status: e.at >= s.length ? "more" : "error" };
    }
    values.push(JSON.parse(s.slice(i, end)));
    consumed = end;
    // One value per line: only white space up to the newline.
    const nl = s.indexOf("\n", end);
    const rest = nl === -1 ? s.length : nl;
    for (let k = end; k < rest; k++) if (!isSpace(s.charCodeAt(k))) return { values, consumed, status: "error" };
    if (nl === -1) return { values, consumed, status: "complete" };
    i = nl + 1;
  }
}

const isTypedArray = (v: unknown): v is ArrayBufferView => ArrayBuffer.isView(v) && !(v instanceof DataView);

function bytesOf(v: ArrayBufferView): Uint8Array {
  // A detached buffer has byteLength 0 and `detached` set.
  if ((v.buffer as ArrayBuffer & { detached?: boolean }).detached) throw new TypeError("ArrayBuffer is detached");
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const hasBom = (b: Uint8Array) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;

/** The UTF-8 length of `s`'s first `n` UTF-16 code units. */
function utf8Length(s: string, n: number): number {
  let len = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) len += 1;
    else if (c < 0x800) len += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < n && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      len += 4;
      i++;
    } else len += 3;
  }
  return len;
}

/** `Bun.JSONL.parse(input)`: the values of the lines; a value that's wrong ends them, and throws if it's the first. */
function parse(input: unknown): unknown[] {
  if (input === undefined || input === null) throw new TypeError("JSONL.parse requires a string argument");
  let text: string;
  if (isTypedArray(input)) {
    let b = bytesOf(input);
    if (hasBom(b)) b = b.subarray(3);
    text = decoder.decode(b);
  } else text = `${input as string}`;
  const r = streamingParse(text);
  if (r.status === "error" && r.values.length === 0) throw new SyntaxError("Failed to parse JSONL");
  return r.values;
}

type Chunk = { values: unknown[]; read: number; done: boolean; error: SyntaxError | null };

/**
 * `Bun.JSONL.parseChunk(input, start?, end?)`: the values of the complete lines in `input[start, end)` (byte offsets of
 * a buffer, UTF-16 offsets of a string), `read` where the last value ends, `done` if nothing was left over, and the
 * error that stopped it.
 */
function parseChunk(input: unknown, start?: unknown, end?: unknown): Chunk {
  if (input === undefined || input === null) throw new TypeError("JSONL.parseChunk requires a string argument");
  const offsets = (length: number): [number, number] => {
    let s = 0;
    let e = length;
    if (typeof start === "number" && start > 0) s = Math.trunc(Math.min(start, length));
    if (typeof end === "number" && end >= 0) e = Math.trunc(Math.min(end, length));
    return [Math.min(s, e), e];
  };
  let r: Result;
  let read: number;
  if (isTypedArray(input)) {
    const bytes = bytesOf(input);
    const [s, e] = offsets(bytes.length);
    let slice = bytes.subarray(s, e);
    let bom = 0;
    if (s === 0 && hasBom(slice)) {
      slice = slice.subarray(3);
      bom = 3;
    }
    const text = decoder.decode(slice);
    r = streamingParse(text);
    read = s + bom + utf8Length(text, r.consumed);
  } else {
    const text = `${input as string}`;
    const [s, e] = offsets(text.length);
    r = streamingParse(s !== 0 || e !== text.length ? text.slice(s, e) : text);
    read = s + r.consumed;
  }
  return { values: r.values, read, done: r.status === "complete", error: r.status === "error" ? new SyntaxError("Failed to parse JSONL") : null };
}

/** `Bun.JSONL`. */
export function makeJSONL(): object {
  const jsonl = {
    parse: (input: unknown) => parse(input),
    parseChunk: (input: unknown, _start?: unknown, _end?: unknown) => parseChunk(input, _start, _end),
  };
  for (const k of ["parse", "parseChunk"] as const) Object.defineProperty(jsonl[k], "length", { value: 1 });
  Object.defineProperty(jsonl, Symbol.toStringTag, { value: "JSONL" });
  return jsonl;
}
