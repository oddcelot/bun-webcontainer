// Snapshots of `bun:test` (test.ts): Bun's serialization of a value, the `__snapshots__/<file>.snap` format and the
// rewriting of `toMatchInlineSnapshot(...)` arguments in the test's source, all as `bun test` does them (including a
// few oddities of its serializer, which make the files differ from Jest's when copied byte for byte).

const HEADER = "// Bun Snapshot v1, https://bun.sh/docs/test/snapshots\n";

/** What the matchers' asymmetric values (`expect.any(Number)`) print as: their `label` (see test.ts Asym). */
type Labelled = { label: string; test: (v: unknown) => boolean };
const isAsym = (v: unknown): v is Labelled => typeof v === "object" && v !== null && typeof (v as Labelled).test === "function" && typeof (v as Labelled).label === "string";

// ---- serializing ----

const TYPED = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];

/** Bun's `pretty-format`: keys quoted and sorted, two-space indent, trailing commas. */
export function serialize(v: unknown, ind = "", seen: unknown[] = []): string {
  switch (typeof v) {
    case "string":
      return `"${v}"`;
    case "number":
      return Object.is(v, -0) ? "-0" : String(v);
    case "bigint":
      return `${v}n`;
    case "symbol":
    case "boolean":
    case "undefined":
      return String(v);
    case "function": {
      const src = Function.prototype.toString.call(v);
      if (/^class\b/.test(src)) return `[class ${v.name || "(anonymous)"}]`;
      // (An arrow function prints without the name its binding gave it.)
      return v.name && !/^(async\s*)?(\([^)]*\)|[\w$]+)\s*=>/.test(src) ? `[Function: ${v.name}]` : "[Function]";
    }
  }
  if (v === null) return "null";
  if (isAsym(v)) return v.label;
  if (seen.includes(v)) return "[Circular]";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
  if (v instanceof RegExp) return String(v);
  if (v instanceof Error) return `[${v.name}: ${v.message}]`;
  const inner = [...seen, v];
  const next = ind + "  ";
  /** One entry's value: the oddities of Bun's output, a multi-line string, Map or Set printed on lines of its own. */
  const child = (x: unknown) => {
    const s = serialize(x, next, inner);
    if (typeof x === "string" && x.includes("\n")) return `\n${s}\n`;
    if (x instanceof Map) return `\n${s}\n`;
    if (x instanceof Set) return `${next}\n${s}\n`;
    return s;
  };
  const list = (open: string, close: string, items: string[]) => (items.length ? `${open}\n${items.map((i) => `${next}${i},\n`).join("")}${ind}${close}` : `${open}${close}`);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return serialize({ type: "Buffer", data: [...v] }, ind, seen);
  if (Array.isArray(v)) return list("[", "]", Array.from(v, (x) => child(x)));
  if (v instanceof Map) return list("Map {", "}", [...v].map(([k, x]) => `${child(k)} => ${child(x)}`));
  if (v instanceof Set) return list("Set {", "}", [...v].map((x) => child(x)));
  if (v instanceof ArrayBuffer) return list("ArrayBuffer [", "]", [...new Uint8Array(v)].map(String));
  if (TYPED.some((t) => v instanceof t)) return list(`${(v as object).constructor.name} [`, "]", [...(v as unknown as Iterable<unknown>)].map((x) => child(x)));
  const proto = Object.getPrototypeOf(v);
  const name = proto === null ? "" : (proto.constructor?.name ?? "");
  const prefix = name && name !== "Object" ? `${name} ` : "";
  const obj = v as Record<string | symbol, unknown>;
  const keys = Object.keys(obj).sort();
  const items = [...keys.map((k) => `${JSON.stringify(k)}: ${child(obj[k])}`), ...Object.getOwnPropertySymbols(obj).filter((s) => Object.prototype.propertyIsEnumerable.call(obj, s)).map((s) => `[${String(s)}]: ${child(obj[s])}`)];
  return list(`${prefix}{`, "}", items);
}

/** A value with the properties a matcher object names replaced by its matchers (`{ id: expect.any(Number) }`). */
export function withMatchers(received: unknown, props: unknown): unknown {
  if (isAsym(props) || typeof props !== "object" || props === null || typeof received !== "object" || received === null) return isAsym(props) ? props : received;
  const out = Array.isArray(received) ? [...received] : { ...received };
  for (const k of Object.keys(props)) (out as Record<string, unknown>)[k] = withMatchers((received as Record<string, unknown>)[k], (props as Record<string, unknown>)[k]);
  return out;
}

// ---- the .snap file ----

const escapeText = (s: string) =>
  s
    .replace(/[\\`]|\$\{/g, (m) => `\\${m}`)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const unescapeText = (s: string) => s.replace(/\\(x[0-9a-fA-F]{2}|[\\`$])/g, (_, c: string) => (c.length === 3 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c));

/** The text of an entry in the file: a value on several lines is set off by line breaks. */
const entryText = (key: string, value: string) => `exports[\`${escapeText(key)}\`] = \`${value.includes("\n") ? `\n${escapeText(value)}\n` : escapeText(value)}\`;\n`;

/** `exports[`key`] = `value`;` entries of a .snap file, in file order. The value without the line breaks around it. */
function parseSnap(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /exports\[`((?:[^`\\]|\\[^])*)`\] = `((?:[^`\\]|\\[^])*)`;/g;
  for (const m of text.matchAll(re)) out.set(unescapeText(m[1]), unescapeText(m[2]).replace(/^\n/, "").replace(/\n$/, ""));
  return out;
}

export type SnapshotIO = { read(path: string): string | undefined; write(path: string, text: string): void };
export type SnapshotCounts = { passed: number; added: number; failed: number };

/** A test file's snapshots: what its .snap file held, what the run matched, added and replaced. */
export class SnapshotFile {
  private raw: string | undefined;
  private old: Map<string, string>;
  /** The run's entries in the order the tests asked for them (what `--update-snapshots` writes). */
  private seen = new Map<string, string>();
  private fresh: string[] = [];
  private counters = new Map<string, number>();
  private changed = false;
  /** A snapshot was asked for: the file exists after the run, even with no entry in it. */
  private asked = false;
  private inline: { start: number; end: number; text: string }[] = [];
  private source: string | undefined;
  constructor(
    private io: SnapshotIO,
    public file: string,
    private update: boolean,
    private counts: SnapshotCounts,
  ) {
    this.raw = io.read(this.snapPath());
    this.old = this.raw === undefined ? new Map() : parseSnap(this.raw);
  }
  private snapPath() {
    const i = this.file.lastIndexOf("/");
    return `${this.file.slice(0, i + 1)}__snapshots__/${this.file.slice(i + 1)}.snap`;
  }
  /** The key of the test's next snapshot: `describe test name[: hint] N`. */
  key(test: string, hint?: string) {
    const base = hint ? `${test}: ${hint}` : test;
    const n = (this.counters.get(base) ?? 0) + 1;
    this.counters.set(base, n);
    return `${base} ${n}`;
  }
  /**
   * Checks a value against the entry: "ok" (matched, or written now); an `{ expected }` when it differs; "ci" where a
   * new entry isn't allowed.
   */
  check(key: string, value: string, ci: boolean): "ok" | "ci" | { expected: string } {
    const had = this.old.get(key);
    this.asked = true;
    if (had === value && this.update) {
      this.counts.added++;
      this.seen.set(key, value);
      return "ok";
    }
    if (had === value) {
      this.counts.passed++;
      this.seen.set(key, value);
      return "ok";
    }
    if (had === undefined) {
      if (ci && !this.update) return "ci";
      this.counts.added++;
      this.seen.set(key, value);
      this.fresh.push(entryText(key, value));
      this.changed = true;
      return "ok";
    }
    if (this.update) {
      this.counts.added++;
      this.seen.set(key, value);
      this.changed = true;
      return "ok";
    }
    this.counts.failed++;
    return { expected: had };
  }
  /** Writes the file: new entries appended; with `--update-snapshots`, every entry of the run, in its order. */
  flush() {
    const path = this.snapPath();
    if (this.update) {
      if (!this.changed && [...this.old.keys()].every((k) => this.seen.has(k))) return;
      this.io.write(path, HEADER + [...this.seen].map(([k, v]) => `\n${entryText(k, v)}`).join(""));
    } else if (this.fresh.length || (this.asked && this.raw === undefined)) this.io.write(path, (this.raw ?? HEADER) + this.fresh.map((e) => `\n${e}`).join(""));
    this.writeInline();
  }

  // ---- inline snapshots ----

  /**
   * The edit that makes the `toMatchInlineSnapshot` call at `line:column` (1-based; the method's name) carry `value`:
   * recorded now, applied to the source when the file's run ends.
   */
  rewriteInline(line: number, column: number, value: string) {
    this.source ??= this.io.read(this.file) ?? "";
    const edit = inlineEdit(this.source, line, column, value);
    if (edit) this.inline.push(edit);
  }
  private writeInline() {
    if (!this.inline.length || this.source === undefined) return;
    let text = this.source;
    for (const e of [...this.inline].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    this.io.write(this.file, text);
  }
}

/** The snapshot an inline template holds: its added indentation and the line breaks around it removed. */
export function dedent(s: string): string {
  if (!s.startsWith("\n")) return s;
  const lines = s.slice(1).replace(/\n[ \t]*$/, "").split("\n");
  const min = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return lines.map((l) => (l.trim() ? l.slice(min) : l)).join("\n");
}

/** End of the string, template or comment starting at `i`, or `i` itself when none does. */
function skipLiteral(src: string, i: number): number {
  const c = src[i];
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === c) return j + 1;
    }
  } else if (c === "`") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === "`") return j + 1;
      else if (src[j] === "$" && src[j + 1] === "{") j = skipBalanced(src, j + 1) - 1;
    }
  } else if (c === "/" && src[i + 1] === "/") return src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
  else if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) < 0 ? src.length : src.indexOf("*/", i + 2) + 2;
  return i;
}

/** The index after the bracket that closes the one at `i`. */
function skipBalanced(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const skipped = skipLiteral(src, j);
    if (skipped !== j) j = skipped - 1;
    else if ("([{".includes(src[j])) depth++;
    else if (")]}".includes(src[j]) && --depth === 0) return j + 1;
  }
  return src.length;
}

function inlineEdit(src: string, line: number, column: number, value: string): { start: number; end: number; text: string } | undefined {
  let lineStart = 0;
  for (let n = 1; n < line; n++) lineStart = src.indexOf("\n", lineStart) + 1;
  const name = "toMatchInlineSnapshot";
  let at = src.indexOf(name, lineStart + column - 1);
  if (at < 0 || at > src.indexOf("\n", lineStart + column - 1) + 200) return undefined;
  let open = at + name.length;
  while (/\s/.test(src[open] ?? "")) open++;
  if (src[open] !== "(") return undefined;
  const close = skipBalanced(src, open) - 1;
  // The arguments: [start, end) of each, at the top level.
  const args: [number, number][] = [];
  let start = open + 1;
  for (let j = open + 1; j < close; j++) {
    const skipped = skipLiteral(src, j);
    if (skipped !== j) j = skipped - 1;
    else if ("([{".includes(src[j])) j = skipBalanced(src, j) - 1;
    else if (src[j] === ",") (args.push([start, j]), (start = j + 1));
  }
  if (src.slice(start, close).trim()) args.push([start, close]);
  const trimmed = args.map(([s, e]) => {
    const t = src.slice(s, e);
    return [s + t.length - t.trimStart().length, e - (t.length - t.trimEnd().length)] as [number, number];
  });
  const isText = (a: [number, number]) => /^[`"']/.test(src[a[0]] ?? "");
  const indent = /^[ \t]*/.exec(src.slice(src.lastIndexOf("\n", at) + 1))![0];
  const literal = value.includes("\n") ? `\`\n${escapeText(value).split("\n").map((l) => (l ? `${indent}  ${l}` : l)).join("\n")}\n${indent}\`` : `\`${escapeText(value)}\``;
  const last = trimmed.at(-1);
  if (last && isText(last)) {
    // Replacing a snapshot on lines of its own keeps the indentation it had.
    const old = src.slice(last[0], last[1]);
    if (!value.includes("\n") || !old.startsWith("`\n")) return { start: last[0], end: last[1], text: literal };
    const lines = old.slice(2, -1).split("\n");
    const close = /^[ \t]*/.exec(lines.at(-1)!)![0];
    const filled = lines.slice(0, -1).filter((l) => l.trim());
    const body = filled.length ? Math.min(...filled.map((l) => /^[ \t]*/.exec(l)![0].length)) : close.length + 2;
    const pad = filled.length ? /^[ \t]*/.exec(filled[0])![0].slice(0, body) : " ".repeat(body);
    return { start: last[0], end: last[1], text: `\`\n${escapeText(value).split("\n").map((l) => (l ? pad + l : l)).join("\n")}\n${close}\`` };
  }
  if (last) return { start: last[1], end: last[1], text: `, ${literal}` };
  return { start: close, end: close, text: literal };
}
