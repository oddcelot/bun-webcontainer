import EventEmitter from "events";

// node:readline and node:readline/promises over any readable `input` (process.stdin, a stream, a Readable.from).
// Lines are what Node's non-terminal interface gives: split at \n, \r\n or \r, `line` per line, the unterminated rest at
// EOF, then `close`. The console echoes what the reader types, so nothing is echoed here (as for a pipe). Not here: a
// terminal mode (history, line editing, `completer`, Tab, keypress events): `terminal` is always false.

type Stream = { write?(chunk: string): unknown; on?: (...a: any[]) => unknown; pause?(): unknown; resume?(): unknown; removeListener?: (...a: any[]) => unknown };
type Options = { input?: Stream; output?: Stream; prompt?: string; crlfDelay?: number; terminal?: boolean; signal?: AbortSignal; history?: string[]; historySize?: number; escapeCodeTimeout?: number; tabSize?: number; completer?: unknown };

/** `ERR_USE_AFTER_CLOSE`, as Node throws it for `question` on a closed interface. */
function closedError() {
  return Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
}

export class Interface extends EventEmitter {
  terminal = false;
  line = "";
  cursor = 0;
  history: string[] = [];
  closed = false;
  input: Stream;
  output?: Stream;
  #prompt: string;
  #paused = false;
  #asked?: { query: string; cb: (answer: string) => void };
  #rest = "";
  #dec = new TextDecoder();
  #skipLf = false;
  #sub: [string, (...a: any[]) => void][] = [];

  constructor(input?: Stream | Options, output?: Stream, completer?: unknown, terminal?: boolean) {
    super();
    const opts: Options = input && typeof (input as Options).input === "object" && !("on" in input) ? (input as Options) : { input: input as Stream, output, completer, terminal };
    if (!opts.input) throw Object.assign(new TypeError('The "input" argument must be an instance of Stream'), { code: "ERR_INVALID_ARG_TYPE" });
    this.input = opts.input;
    this.output = opts.output;
    this.#prompt = opts.prompt ?? "> ";
    const on = (event: string, fn: (...a: any[]) => void) => {
      this.#sub.push([event, fn]);
      this.input.on?.(event, fn);
    };
    on("data", (chunk: string | Uint8Array) => this.#feed(typeof chunk === "string" ? chunk : this.#dec.decode(chunk, { stream: true })));
    on("end", () => {
      if (this.#rest) {
        const last = this.#rest;
        this.#rest = "";
        this.#line(last);
      }
      this.close();
    });
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
      this.#line(text.slice(at, m.index));
      at = m.index + m[0].length;
      // A \r at the very end may be the start of \r\n: the \n then comes in the next chunk and is skipped.
      if (m[0] === "\r" && at === text.length) this.#skipLf = true;
      if (this.closed) return;
    }
    this.#rest = text.slice(at);
    this.line = this.#rest;
  }

  #line(line: string) {
    const asked = this.#asked;
    if (asked) {
      this.#asked = undefined;
      asked.cb(line);
    } else this.emit("line", line);
  }

  getPrompt() {
    return this.#prompt;
  }
  setPrompt(prompt: string) {
    this.#prompt = prompt;
  }
  prompt(_preserveCursor?: boolean) {
    if (this.closed) throw closedError();
    if (this.#paused) this.resume();
    this.output?.write?.(this.#prompt);
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
    if (signal) signal.addEventListener("abort", () => (this.#asked?.cb === done ? (this.#asked = undefined) : undefined), { once: true });
    this.output?.write?.(query);
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

  /** Text as if typed (without a terminal, Node feeds it to the line splitter as well). */
  write(data?: string | Uint8Array | null) {
    if (this.closed) throw closedError();
    if (data == null) return;
    this.#feed(typeof data === "string" ? data : this.#dec.decode(data));
  }

  getCursorPos() {
    return { rows: 0, cols: this.cursor };
  }

  close() {
    if (this.closed) return;
    this.pause();
    for (const [event, fn] of this.#sub) this.input.removeListener?.(event, fn);
    this.#sub = [];
    this.closed = true;
    this.emit("close");
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

/** Node writes the escape sequence to the stream (the console's own streams, fd 1 and 2, take no cursor movement here). */
type Out = (Stream & { fd?: number }) | null | undefined;
const w = (stream: Out, code: string, cb?: () => void) => {
  if (stream && stream.fd !== 1 && stream.fd !== 2) stream.write?.(code);
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
/** Keypresses need a terminal in raw mode: there is none here, so no `keypress` event is ever emitted. */
const emitKeypressEvents = (_stream?: unknown, _iface?: unknown) => undefined;

const promises = {
  Interface: PromisesInterface,
  createInterface: (...args: unknown[]) => new PromisesInterface(...options(args)),
};

export default { Interface, createInterface, clearLine, clearScreenDown, cursorTo, moveCursor, emitKeypressEvents, promises };
export { promises };
