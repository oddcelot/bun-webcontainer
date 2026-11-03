import { format, inspect } from "./node/util";

type Level = "log" | "info" | "warn" | "error" | "debug";
type Emit = (level: Level, text: string) => void;

/** Terminal columns a string takes: East Asian wide characters and emoji take two, combining marks none. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

const cell = (v: unknown) => (typeof v === "string" ? v : inspect(v));
const isObject = (v: unknown): v is object => (typeof v === "object" && v !== null) || typeof v === "function";

/** `console.table`'s box, as Bun draws it: an unlabeled index column, the rows' keys, then `Values` for primitives. */
export function table(data: object, properties?: string[]): string {
  const rows: [index: string, value: unknown, key?: unknown][] = [];
  if (data instanceof Map) {
    let i = 0;
    for (const [k, v] of data) rows.push([String(i++), v, k]);
  } else if (data instanceof Set) {
    let i = 0;
    for (const v of data) rows.push([String(i++), v]);
  } else for (const k of Object.keys(data)) rows.push([k, (data as Record<string, unknown>)[k]]);
  const isMap = data instanceof Map;
  let columns: string[] = properties ? properties.map(String) : [];
  let values = false;
  if (!properties) {
    const seen = new Set<string>();
    for (const [, v] of rows) {
      if (isMap || !isObject(v)) values = true;
      else for (const k of Object.keys(v)) if (!seen.has(k)) seen.add(k), columns.push(k);
    }
  }
  if (isMap) columns = [];
  const head = ["", ...(isMap ? ["Key"] : []), ...columns, ...(values ? ["Values"] : [])];
  const body = rows.map(([index, v, key]) => {
    const r = [index];
    if (isMap) r.push(cell(key));
    for (const c of columns) r.push(isObject(v) && Object.prototype.hasOwnProperty.call(v, c) ? cell((v as Record<string, unknown>)[c]) : "");
    if (values) r.push(isMap || !isObject(v) ? cell(v) : "");
    return r;
  });
  const widths = head.map((h, i) => Math.max(1, width(h), ...body.map((r) => width(r[i]))));
  const line = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const row = (r: string[]) => "│" + r.map((c, i) => ` ${c}${" ".repeat(widths[i] - width(c))} `).join("│") + "│";
  return [line("┌", "┬", "┐"), row(head), line("├", "┼", "┤"), ...body.map(row), line("└", "┴", "┘")].join("\n");
}

/**
 * Forwards the global console to the playground's console pane (`emit`), keeping the browser's own output. Text and
 * quirks follow Bun's: `group` indents formatted values but not the lines inside a string and `groupCollapsed` doesn't indent;
 * `table`, `count` and `time*` aren't indented; unknown `countReset`/`timeEnd` labels are ignored.
 * `fmt` formats one argument the way `console.log` does; `frame` rewrites a stack frame's location (`console.trace`).
 */
export function installConsole(emit: Emit, fmt: (v: unknown) => string, frame: (line: string) => string) {
  const c = console as unknown as Record<string, (...args: unknown[]) => void>;
  const orig = (name: string) => (c[name] ?? (() => {})).bind(console);
  let depth = 0;
  /** A message's text inside the current groups: formatted values are indented throughout, strings only where they start. */
  const out = (args: unknown[]) => {
    const pad = "  ".repeat(depth);
    if (typeof args[0] === "string" && /%[sdifjoOc%]/.test(args[0])) return pad + format(...args);
    return pad + args.map((a) => (typeof a === "string" ? a : fmt(a).replaceAll("\n", "\n" + pad))).join(" ");
  };
  const wrap = (name: string, fn: (...args: unknown[]) => void) => {
    const o = orig(name);
    c[name] = (...args: unknown[]) => {
      o(...args);
      fn(...args);
    };
  };

  for (const level of ["log", "info", "warn", "error", "debug"] as const) wrap(level, (...args) => emit(level, out(args)));
  wrap("dir", (v) => emit("log", out([v])));
  wrap("assert", (cond, ...args) => {
    if (!cond) emit("error", out(args.length ? args : ["Assertion failed"]));
  });
  wrap("table", (...args) => {
    if (!args.length) return;
    const [data, properties] = args;
    if (args.length > 1 && !Array.isArray(properties)) throw new TypeError('The "properties" argument must be an instance of Array.');
    emit("log", isObject(data) ? table(data, properties as string[] | undefined) : fmt(data));
  });

  const counts = new Map<string, number>();
  wrap("count", (label = "default") => {
    const k = String(label);
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    emit("log", `${k}: ${n}`);
  });
  wrap("countReset", (label = "default") => void counts.delete(String(label)));

  const timers = new Map<string, number>();
  const elapsed = (k: string, extra: unknown[]) => emit("log", [`[${(performance.now() - timers.get(k)!).toFixed(2)}ms] ${k}`, ...extra.map(fmt)].join(" "));
  wrap("time", (label = "default") => {
    const k = String(label);
    if (!timers.has(k)) timers.set(k, performance.now());
  });
  wrap("timeLog", (label = "default", ...extra) => {
    const k = String(label);
    if (timers.has(k)) elapsed(k, extra);
  });
  wrap("timeEnd", (label = "default") => {
    const k = String(label);
    if (timers.has(k)) elapsed(k, []), timers.delete(k);
  });

  wrap("group", (...labels) => {
    if (labels.length) emit("log", out(labels));
    depth++;
  });
  wrap("groupCollapsed", (...labels) => {
    if (labels.length) emit("log", out(labels));
  });
  wrap("groupEnd", () => void (depth = Math.max(0, depth - 1)));

  wrap("trace", (...args) => {
    // V8 frames read `    at fn (url:1:2)`, SpiderMonkey/JSC ones `fn@url:1:2`; drop this function and the wrapper.
    const frames = (new Error().stack ?? "")
      .split("\n")
      .map((l) => (/^\s+at /.test(l) ? l.replace(/^\s+at /, "") : /^(.*)@(.+)$/.test(l) ? l.replace(/^(.*)@(.+)$/, (_, fn, loc) => (fn ? `${fn} (${loc})` : loc)) : ""))
      .filter(Boolean)
      .slice(2);
    const stack = frames.map((l) => "      at " + frame(l));
    emit("log", [...(args.length ? [out(args)] : []), ...stack].join("\n"));
  });
}
