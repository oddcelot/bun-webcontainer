import EventEmitter from "events";
import { Readable } from "./stream";

// node:tty and the state behind `isTTY`. The main program's stdin, stdout and stderr are the console's terminal
// (xterm.js, which renders the escape sequences a TTY program writes): a terminal of the console's size with
// colors. A child process's are pipes, so there it stays off.

/** Whether the standard streams are a terminal, and its size (the console's, sent by the page). */
export const ttyState = { on: false, cols: 80, rows: 24 };
const resizeListeners = new Set<() => void>();
/** The standard streams are the console's terminal from now on (the main program, at its start). */
export function enableTTY(cols?: number, rows?: number) {
  ttyState.on = true;
  if (cols && rows) (ttyState.cols = cols), (ttyState.rows = rows);
}
/** The console changed size: `process.stdout` and `process.stderr` emit `resize`. */
export function resizeTTY(cols: number, rows: number) {
  if (cols === ttyState.cols && rows === ttyState.rows) return;
  ttyState.cols = cols;
  ttyState.rows = rows;
  for (const fn of resizeListeners) fn();
}
export const onTTYResize = (fn: () => void) => void resizeListeners.add(fn);

/** `process.stdin` when the console is a terminal: the stream is `isTTY`, and `setRawMode` (stdin.ts) switches the console to raw input. */
export class ReadStream extends Readable {
  fd = 0;
  isRaw = false;
  constructor() {
    super({ read() {} });
  }
  get isTTY() {
    return ttyState.on;
  }
  setRawMode(mode: boolean) {
    this.isRaw = !!mode;
    return this;
  }
}

/** The shape of `process.stdout` and `process.stderr` as a terminal (process.ts gives them this prototype). */
export class WriteStream extends EventEmitter {
  fd = 1;
  get isTTY() {
    return ttyState.on;
  }
  get columns() {
    return ttyState.cols;
  }
  get rows() {
    return ttyState.rows;
  }
  getWindowSize(): [number, number] {
    return [ttyState.cols, ttyState.rows];
  }
  getColorDepth(): number {
    return ttyState.on && !(globalThis as { process?: { env?: Record<string, string> } }).process?.env?.NO_COLOR ? 24 : 1;
  }
  hasColors(count = 16): boolean {
    return count <= 2 ** this.getColorDepth();
  }
  cursorTo(x: number, y?: number | (() => void), cb?: () => void) {
    return this.#move(typeof y === "number" ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`, typeof y === "function" ? y : cb);
  }
  moveCursor(dx: number, dy: number, cb?: () => void) {
    return this.#move((dx < 0 ? `\x1b[${-dx}D` : dx > 0 ? `\x1b[${dx}C` : "") + (dy < 0 ? `\x1b[${-dy}A` : dy > 0 ? `\x1b[${dy}B` : ""), cb);
  }
  clearLine(dir: number, cb?: () => void) {
    return this.#move(dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K", cb);
  }
  clearScreenDown(cb?: () => void) {
    return this.#move("\x1b[0J", cb);
  }
  #move(code: string, cb?: () => void) {
    (this as unknown as { write(s: string): unknown }).write(code);
    if (typeof cb === "function") queueMicrotask(cb);
    return true;
  }
}

/** `tty.isatty(fd)`: the console is a terminal for stdin, stdout and stderr. */
const isatty = (fd: number) => ttyState.on && (fd === 0 || fd === 1 || fd === 2);

export default { isatty, ReadStream, WriteStream };
