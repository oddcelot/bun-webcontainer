import EventEmitter from "events";

// node:readline and node:readline/promises over any readable `input` (process.stdin, a stream, a Readable.from).
// Two modes, as in Node. Without a terminal (`terminal` false: a pipe, a Readable.from) lines are what Node's
// non-terminal interface gives: split at \n, \r\n or \r, `line` per line, the unterminated rest at EOF, then `close`;
// the console echoes what the reader types, so nothing is echoed here. With a terminal (`terminal: true`, or an `output`
// that is a TTY: the console's stdout) the interface puts `input` in raw mode and edits the line itself, as Node does:
// `keypress` events from `emitKeypressEvents`, cursor movement, history (Up, Down), word and line deletion, the
// echo and the prompt drawn with escape sequences on `output`, SIGINT on Ctrl+C. Not here: `completer` (Tab inserts the
// tab) and kill-ring-style yanking.

type Stream = { write?(chunk: string): unknown; on?: (...a: any[]) => unknown; pause?(): unknown; resume?(): unknown; removeListener?: (...a: any[]) => unknown; isTTY?: boolean; columns?: number; setRawMode?: (mode: boolean) => unknown };
type Options = { input?: Stream; output?: Stream; prompt?: string; crlfDelay?: number; terminal?: boolean; signal?: AbortSignal; history?: string[]; historySize?: number; escapeCodeTimeout?: number; tabSize?: number; completer?: unknown };
type Key = { sequence?: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; code?: string };

/** `ERR_USE_AFTER_CLOSE`, as Node throws it for `question` on a closed interface. */
function closedError() {
  return Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
}

const ESC = "\x1b";
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** Terminal columns of one character: 0 for combining marks, 2 for East Asian wide characters and emoji. */
function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) return 0;
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
}

// ---- keypress events ----

const NAMED: Record<string, string> = {
  "[A": "up", "[B": "down", "[C": "right", "[D": "left", "[E": "clear", "[F": "end", "[H": "home",
  OA: "up", OB: "down", OC: "right", OD: "left", OE: "clear", OF: "end", OH: "home",
  OP: "f1", OQ: "f2", OR: "f3", OS: "f4", "[P": "f1", "[Q": "f2", "[R": "f3", "[S": "f4",
  "[[A": "f1", "[[B": "f2", "[[C": "f3", "[[D": "f4", "[[E": "f5", "[Z": "tab",
  "[1~": "home", "[2~": "insert", "[3~": "delete", "[4~": "end", "[5~": "pageup", "[6~": "pagedown", "[7~": "home", "[8~": "end",
  "[11~": "f1", "[12~": "f2", "[13~": "f3", "[14~": "f4", "[15~": "f5", "[17~": "f6", "[18~": "f7", "[19~": "f8", "[20~": "f9", "[21~": "f10", "[23~": "f11", "[24~": "f12",
  "[200~": "paste-start", "[201~": "paste-end",
};

/** The key a single character is (Node's `emitKeys`): control characters are Ctrl+letter, letters name themselves. */
function plainKey(ch: string): Key {
  const key: Key = { sequence: ch, name: undefined, ctrl: false, meta: false, shift: false };
  if (ch === "\r") key.name = "return";
  else if (ch === "\n") key.name = "enter";
  else if (ch === "\t") key.name = "tab";
  else if (ch === "\b" || ch === "\x7f") key.name = "backspace";
  else if (ch === ESC) (key.name = "escape"), (key.meta = true); // Node reports a lone Escape with meta
  else if (ch === " ") key.name = "space";
  else if (ch === "\0") (key.name = "space"), (key.ctrl = true);
  else if (ch <= "\x1a") (key.name = String.fromCharCode(ch.charCodeAt(0) + 96)), (key.ctrl = true);
  else if (/^[0-9A-Za-z]$/.test(ch)) (key.name = ch.toLowerCase()), (key.shift = /^[A-Z]$/.test(ch));
  return key;
}

/** Splits typed text into keys. `rest` is an escape sequence that stopped short (more of it may come). */
function parseKeys(text: string): { keys: Key[]; rest: string } {
  const keys: Key[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== ESC) {
      const ch = String.fromCodePoint(text.codePointAt(i)!);
      keys.push(plainKey(ch));
      i += ch.length;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      keys.push(plainKey(ESC));
      i++;
    } else if (next === "[" || next === "O") {
      let j = i + 2;
      if (text[j] === "[") j++;
      while (j < text.length && /[0-9;]/.test(text[j])) j++;
      if (j >= text.length) return { keys, rest: text.slice(i) };
      const final = text[j];
      const params = text.slice(i + 2, j).replace(/^\[/, "");
      const [first, mod] = params.split(";");
      const code = final === "~" ? `${next}${first}~` : text[i + 2] === "[" ? `[[${final}` : `${next}${final}`;
      const key: Key = { sequence: text.slice(i, j + 1), name: NAMED[code], ctrl: false, meta: false, shift: false, code };
      const m = mod ? Number(mod) - 1 : 0;
      if (m > 0) (key.shift = !!(m & 1)), (key.meta = !!(m & 2)), (key.ctrl = !!(m & 4));
      if (code === "[Z") key.shift = true;
      keys.push(key);
      i = j + 1;
    } else if (next === ESC) {
      keys.push({ sequence: ESC + ESC, name: "escape", ctrl: false, meta: true, shift: false });
      i += 2;
    } else {
      // Alt+key: the key after an escape.
      const ch = String.fromCodePoint(text.codePointAt(i + 1)!);
      const key = plainKey(ch);
      key.sequence = ESC + ch;
      key.meta = true;
      keys.push(key);
      i += 1 + ch.length;
    }
  }
  return { keys, rest: "" };
}

const decoders = new WeakSet<object>();

/**
 * Makes `stream` emit `keypress` events (`ch`, `{ sequence, name, ctrl, meta, shift }`) for what it receives, as Node does:
 * reading its data starts with the first `keypress` listener. Meant for a stream in raw mode (the console's stdin).
 */
export function emitKeypressEvents(stream: any, iface: { escapeCodeTimeout?: number } = {}) {
  if (!stream || decoders.has(stream) || typeof stream.on !== "function") return;
  decoders.add(stream);
  const dec = new TextDecoder();
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = (keys: Key[]) => {
    for (const key of keys) if (key.sequence) stream.emit("keypress", key.sequence.startsWith(ESC) ? undefined : key.sequence, key);
  };
  const onData = (input: string | Uint8Array) => {
    if (stream.listenerCount("keypress") === 0) {
      stream.removeListener("data", onData);
      stream.on("newListener", onNewListener);
      return;
    }
    clearTimeout(timer);
    const { keys, rest } = parseKeys(pending + (typeof input === "string" ? input : dec.decode(input, { stream: true })));
    pending = rest;
    emit(keys);
    // An escape sequence that stopped short: the rest of it may be coming; if not, it is an Escape and what follows it.
    if (rest) {
      timer = setTimeout(() => {
        const text = pending;
        pending = "";
        emit([plainKey(ESC), ...parseKeys(text.slice(1)).keys]);
      }, iface.escapeCodeTimeout ?? 500);
    }
  };
  const onNewListener = (event: string) => {
    if (event !== "keypress") return;
    stream.on("data", onData);
    stream.removeListener("newListener", onNewListener);
  };
  if (stream.listenerCount("keypress") > 0) stream.on("data", onData);
  else stream.on("newListener", onNewListener);
}

// ---- the interface ----

export class Interface extends EventEmitter {
  terminal = false;
  line = "";
  cursor = 0;
  history: string[] = [];
  historySize = 30;
  closed = false;
  input: Stream;
  output?: Stream;
  crlfDelay = 100;
  escapeCodeTimeout = 500;
  tabSize = 8;
  #prompt: string;
  #oldPrompt = "";
  #paused = false;
  #asked?: { query: string; cb: (answer: string) => void };
  #rest = "";
  #dec = new TextDecoder();
  #skipLf = false;
  #sub: [string, (...a: any[]) => void][] = [];
  #historyIndex = -1;
  #prevRows = 0;
  #sawReturn = 0;

  constructor(input?: Stream | Options, output?: Stream, completer?: unknown, terminal?: boolean) {
    super();
    const opts: Options = input && typeof (input as Options).input === "object" && !("on" in input) ? (input as Options) : { input: input as Stream, output, completer, terminal };
    if (!opts.input) throw Object.assign(new TypeError('The "input" argument must be an instance of Stream'), { code: "ERR_INVALID_ARG_TYPE" });
    this.input = opts.input;
    this.output = opts.output;
    this.#prompt = opts.prompt ?? "> ";
    this.crlfDelay = Math.max(100, opts.crlfDelay ?? 100);
    this.escapeCodeTimeout = opts.escapeCodeTimeout ?? 500;
    this.tabSize = opts.tabSize ?? 8;
    this.historySize = opts.historySize ?? 30;
    this.history = [...(opts.history ?? [])];
    this.terminal = opts.terminal ?? !!opts.output?.isTTY;
    const on = (event: string, fn: (...a: any[]) => void) => {
      this.#sub.push([event, fn]);
      this.input.on?.(event, fn);
    };
    on("end", () => {
      if (this.#rest) {
        const last = this.#rest;
        this.#rest = "";
        this.#deliver(last);
      }
      this.close();
    });
    if (this.terminal) {
      emitKeypressEvents(this.input, this);
      on("keypress", (s: string | undefined, key: Key) => this.#ttyWrite(s, key));
      if (this.output?.on) {
        const redraw = () => this.#refreshLine();
        this.output.on("resize", redraw);
        this.#sub.push(["resize", redraw]);
      }
      this.input.setRawMode?.(true);
      this.input.resume?.();
    } else on("data", (chunk: string | Uint8Array) => this.#feed(typeof chunk === "string" ? chunk : this.#dec.decode(chunk, { stream: true })));
    if (opts.signal) {
      if (opts.signal.aborted) queueMicrotask(() => this.close());
      else opts.signal.addEventListener("abort", () => this.close(), { once: true });
    }
  }

  #feed(text: string) {
    if (this.closed) return;
    if (this.#skipLf && text.startsWith("\n")) text = text.slice(1);
    this.#skipLf = false;
    text = this.#rest + text;
    let at = 0;
    for (const m of text.matchAll(/\r\n|\n|\r/g)) {
      this.#deliver(text.slice(at, m.index));
      at = m.index + m[0].length;
      // A \r at the very end may be the start of \r\n: the \n then comes in the next chunk and is skipped.
      if (m[0] === "\r" && at === text.length) this.#skipLf = true;
      if (this.closed) return;
    }
    this.#rest = text.slice(at);
    this.line = this.#rest;
  }

  /** A whole line: the answer to the question asked, else a `line` event. */
  #deliver(line: string) {
    const asked = this.#asked;
    if (asked) {
      this.#asked = undefined;
      if (this.terminal) this.#prompt = this.#oldPrompt;
      asked.cb(line);
    } else this.emit("line", line);
  }

  getPrompt() {
    return this.#prompt;
  }
  setPrompt(prompt: string) {
    this.#prompt = prompt;
  }
  prompt(preserveCursor?: boolean) {
    if (this.closed) throw closedError();
    if (this.#paused) this.resume();
    if (this.terminal) {
      if (!preserveCursor) this.cursor = 0;
      this.#refreshLine();
    } else this.output?.write?.(this.#prompt);
  }

  question(query: string, options?: { signal?: AbortSignal } | ((answer: string) => void), cb?: (answer: string) => void) {
    const done = typeof options === "function" ? options : cb;
    const signal = typeof options === "function" ? undefined : options?.signal;
    if (typeof done !== "function") throw Object.assign(new TypeError('The "cb" argument must be of type function'), { code: "ERR_INVALID_ARG_TYPE" });
    if (this.closed) throw closedError();
    if (signal?.aborted) return;
    // A question while one is open is ignored, as in Node: the first still gets the next line.
    if (this.#asked) return this.prompt();
    if (this.#paused) this.resume();
    this.#asked = { query, cb: done };
    if (signal)
      signal.addEventListener(
        "abort",
        () => {
          if (this.#asked?.cb !== done) return;
          this.#asked = undefined;
          if (this.terminal) this.#prompt = this.#oldPrompt;
        },
        { once: true },
      );
    if (this.terminal) {
      this.#oldPrompt = this.#prompt;
      this.#prompt = query;
      this.prompt();
    } else this.output?.write?.(query);
  }

  pause() {
    if (this.#paused) return this;
    this.input.pause?.();
    this.#paused = true;
    this.emit("pause");
    return this;
  }
  resume() {
    if (!this.#paused) return this;
    this.input.resume?.();
    this.#paused = false;
    this.emit("resume");
    return this;
  }

  /** Text as if typed, or a key (`write(null, { ctrl: true, name: "u" })`). In a terminal it is edited like typed input. */
  write(data?: string | Uint8Array | null, key?: Key) {
    if (this.closed) throw closedError();
    if (this.terminal) return void this.#ttyWrite(typeof data === "string" ? data : data == null ? undefined : this.#dec.decode(data), key ?? {});
    if (data == null) return;
    this.#feed(typeof data === "string" ? data : this.#dec.decode(data));
  }

  getCursorPos() {
    return this.#displayPos(this.#prompt + this.line.slice(0, this.cursor));
  }

  close() {
    if (this.closed) return;
    this.pause();
    if (this.terminal) this.input.setRawMode?.(false);
    for (const [event, fn] of this.#sub) (event === "resize" ? this.output : this.input)?.removeListener?.(event, fn);
    this.#sub = [];
    this.closed = true;
    this.emit("close");
  }

  // The terminal: where the cursor is, and redrawing the line on `output`.

  #columns() {
    const n = this.output?.columns;
    return typeof n === "number" && n > 0 ? n : Infinity;
  }
  #out(text: string) {
    this.output?.write?.(text);
  }
  /** Where a string ends on screen (rows below its start, column), with the width of what is in it as a terminal draws it. */
  #displayPos(text: string) {
    const columns = this.#columns();
    let rows = 0;
    let offset = 0;
    for (const ch of text.replace(CSI, "")) {
      if (ch === "\n") (rows++, (offset = 0));
      else if (ch === "\t") offset += this.tabSize - (offset % this.tabSize);
      else {
        const w = charWidth(ch);
        if (w === 2 && (offset + 1) % columns === 0) offset++;
        offset += w;
      }
    }
    const cols = columns === Infinity ? offset : offset % columns;
    return { rows: rows + (columns === Infinity ? 0 : (offset - cols) / columns), cols };
  }
  /** The prompt and the line again from the line's first row, the cursor where it is in the line. */
  #refreshLine() {
    if (!this.output) return;
    const end = this.#displayPos(this.#prompt + this.line);
    const at = this.getCursorPos();
    if (this.#prevRows > 0) this.#out(`${ESC}[${this.#prevRows}A`);
    this.#out(`${ESC}[1G${ESC}[0J${this.#prompt}${this.line}`);
    // A line that ends at the right edge leaves the cursor waiting to wrap: a space moves it to the next row.
    if (end.cols === 0 && end.rows > 0) this.#out(" ");
    this.#out(`${ESC}[${at.cols + 1}G`);
    if (end.rows > at.rows) this.#out(`${ESC}[${end.rows - at.rows}A`);
    this.#prevRows = at.rows;
  }
  /** `cursor` moved to `to`: on the screen too (a redraw when it goes to another row). */
  #moveTo(to: number) {
    const before = this.getCursorPos();
    this.cursor = Math.max(0, Math.min(this.line.length, to));
    const after = this.getCursorPos();
    if (before.rows === after.rows) {
      const dx = after.cols - before.cols;
      if (dx) this.#out(`${ESC}[${Math.abs(dx)}${dx < 0 ? "D" : "C"}`);
      this.#prevRows = after.rows;
    } else this.#refreshLine();
  }
  #insert(text: string) {
    if (!text) return;
    const tail = this.line.slice(this.cursor);
    this.line = this.line.slice(0, this.cursor) + text + tail;
    this.cursor += text.length;
    if (tail) return this.#refreshLine();
    if (this.getCursorPos().cols === 0) this.#refreshLine();
    else this.#out(text);
  }
  #edit(from: number, to: number) {
    this.line = this.line.slice(0, from) + this.line.slice(to);
    this.cursor = from;
    this.#refreshLine();
  }
  #history(by: number) {
    const next = this.#historyIndex + by;
    if (next < -1 || next >= this.history.length) return;
    this.#historyIndex = next;
    this.line = next === -1 ? "" : this.history[next];
    this.cursor = this.line.length;
    this.#refreshLine();
  }
  /** Enter: the line goes to the history and to its reader, and the cursor to the row below. */
  #submit() {
    let line = this.line;
    if (!line.trim()) line = "";
    else if (this.history[0] !== line) {
      this.history.unshift(line);
      if (this.history.length > this.historySize) this.history.pop();
    }
    this.#historyIndex = -1;
    this.#moveTo(this.line.length);
    this.#out("\r\n");
    this.line = "";
    this.cursor = 0;
    this.#prevRows = 0;
    this.#deliver(line);
  }

  /** One key (or text, without one) of a terminal's input, as Node's `_ttyWrite` handles it. */
  #ttyWrite(s: string | undefined, key: Key = {}) {
    if (this.closed) return;
    const { ctrl, meta, shift, name } = key;
    const line = this.line;
    const at = this.cursor;
    const wordLeft = () => at - (line.slice(0, at).match(/(?:[^\w\s]+|\w+|)\s*$/)?.[0].length ?? 0);
    const wordRight = () => at + (line.slice(at).match(/^(?:\s+|[^\w\s]+|\w+)\s*/)?.[0].length ?? 0);
    const left = () => (at > 1 && /[\udc00-\udfff]/.test(line[at - 1]) ? at - 2 : at - 1);
    const right = () => (/[\ud800-\udbff]/.test(line[at] ?? "") ? at + 2 : at + 1);
    if (name !== "enter") this.#sawReturn = this.#sawReturn && name === "return" ? this.#sawReturn : 0;
    if (ctrl && shift) {
      if (name === "backspace") this.#edit(0, at);
      else if (name === "delete") this.#edit(at, line.length);
    } else if (ctrl) {
      switch (name) {
        case "c":
          if (this.listenerCount("SIGINT") > 0) this.emit("SIGINT");
          else this.close();
          break;
        case "h":
          if (at > 0) this.#edit(left(), at);
          break;
        case "d":
          if (!at && !line.length) this.close();
          else if (at < line.length) this.#edit(at, right());
          break;
        case "u":
          this.#edit(0, at);
          break;
        case "k":
          this.#edit(at, line.length);
          break;
        case "a":
          this.#moveTo(0);
          break;
        case "e":
          this.#moveTo(line.length);
          break;
        case "b":
          this.#moveTo(left());
          break;
        case "f":
          this.#moveTo(right());
          break;
        case "l":
          this.#out(`${ESC}[1;1H${ESC}[0J`);
          this.#prevRows = 0;
          this.#refreshLine();
          break;
        case "n":
          this.#history(-1);
          break;
        case "p":
          this.#history(1);
          break;
        case "w":
        case "backspace":
          if (at > 0) this.#edit(wordLeft(), at);
          break;
        case "delete":
          if (at < line.length) this.#edit(at, wordRight());
          break;
        case "left":
          this.#moveTo(wordLeft());
          break;
        case "right":
          this.#moveTo(wordRight());
          break;
      }
    } else if (meta) {
      switch (name) {
        case "b":
          this.#moveTo(wordLeft());
          break;
        case "f":
          this.#moveTo(wordRight());
          break;
        case "d":
          if (at < line.length) this.#edit(at, wordRight());
          break;
        case "backspace":
          if (at > 0) this.#edit(wordLeft(), at);
          break;
      }
    } else {
      switch (name) {
        case "return":
          this.#sawReturn = Date.now();
          this.#submit();
          break;
        case "enter":
          // The \n of a \r\n: the line was sent at the \r.
          if (!this.#sawReturn || Date.now() - this.#sawReturn > this.crlfDelay) this.#submit();
          this.#sawReturn = 0;
          break;
        case "backspace":
          if (at > 0) this.#edit(left(), at);
          break;
        case "delete":
          if (at < line.length) this.#edit(at, right());
          break;
        case "left":
          this.#moveTo(left());
          break;
        case "right":
          this.#moveTo(right());
          break;
        case "home":
          this.#moveTo(0);
          break;
        case "end":
          this.#moveTo(line.length);
          break;
        case "up":
          this.#history(1);
          break;
        case "down":
          this.#history(-1);
          break;
        default:
          // Text (a character, a paste, `write("abc")`), and Tab, which this interface does not complete.
          if (typeof s === "string" && s && !s.startsWith(ESC)) {
            const parts = s.split(/\r\n|\n|\r/);
            parts.forEach((part, i) => {
              if (i > 0) this.#submit();
              this.#insert(part);
            });
          }
      }
    }
  }

  /** The lines as an async iterator, from the call on; it ends when the interface closes. */
  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const queue: string[] = [];
    const waiting: ((r: IteratorResult<string>) => void)[] = [];
    let done = this.closed;
    const finish = () => {
      done = true;
      for (const w of waiting.splice(0)) w({ value: undefined, done: true });
    };
    const onLine = (line: string) => {
      const w = waiting.shift();
      if (w) w({ value: line, done: false });
      else queue.push(line);
    };
    this.on("line", onLine);
    this.once("close", finish);
    const stop = () => {
      this.off("line", onLine);
      this.off("close", finish);
      finish();
      this.close();
    };
    return {
      next: () => (queue.length ? Promise.resolve({ value: queue.shift()!, done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waiting.push(r))),
      return: async () => (stop(), { value: undefined, done: true }),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as AsyncIterableIterator<string>;
  }
}

/** `readline/promises`' interface: `question` returns the answer. */
class PromisesInterface extends Interface {
  question(query: string, options?: { signal?: AbortSignal }): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        super.question(query, options ?? {}, resolve);
      } catch (err) {
        reject(err);
      }
    });
  }
}

const options = (a: unknown[]) => a as [Stream | Options, Stream?, unknown?, boolean?];

export function createInterface(...args: unknown[]) {
  return new Interface(...options(args));
}

/** Node writes the escape sequence to the stream, whichever it is. */
type Out = Stream | null | undefined;
const w = (stream: Out, code: string, cb?: () => void) => {
  stream?.write?.(code);
  if (typeof cb === "function") queueMicrotask(cb);
  return true;
};

const clearLine = (stream: Out, dir: number, cb?: () => void) => w(stream, dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K", cb);
const clearScreenDown = (stream: Out, cb?: () => void) => w(stream, "\x1b[0J", cb);
const cursorTo = (stream: Out, x: unknown, y?: unknown, cb?: () => void) => {
  if (typeof y === "function") (cb = y as () => void), (y = undefined);
  return w(stream, typeof y !== "number" ? `\x1b[${Number(x) + 1}G` : `\x1b[${y + 1};${Number(x) + 1}H`, cb);
};
const moveCursor = (stream: Out, dx: number, dy: number, cb?: () => void) => w(stream, (dx < 0 ? `\x1b[${-dx}D` : dx > 0 ? `\x1b[${dx}C` : "") + (dy < 0 ? `\x1b[${-dy}A` : dy > 0 ? `\x1b[${dy}B` : ""), cb);

const promises = {
  Interface: PromisesInterface,
  createInterface: (...args: unknown[]) => new PromisesInterface(...options(args)),
};

export default { Interface, createInterface, clearLine, clearScreenDown, cursorTo, moveCursor, emitKeypressEvents, promises };
export { promises };
