import { hold, release } from "./loop";
import { Buffer } from "./node/buffer";
import { ReadStream, ttyState } from "./node/tty";
import { readLineSync } from "./processes";

// The program's stdin: one source behind process.stdin, Bun.stdin and `for await (const line of console)`. What the
// page sends (the console's input, or a parent process's writes) is pushed into it; null is end of input. Reading it
// holds the program as an open pipe does, and the page is told while something waits for it, so the console sends
// what is typed there (runner.ts `stdin-wait`) instead of running it as a command.

let post: (msg: unknown) => void = () => {};
let notify = true;
/** `post` reaches the page; `notify` is false in a child process, whose stdin is its parent's, not the console's. */
export function setStdinPost(fn: (msg: unknown) => void, tellPage: boolean) {
  post = fn;
  notify = tellPage;
}

export const stdinStream = (() => {
  const stdin = Object.assign(new ReadStream(), {
    // On the console's terminal, raw mode sends each key as it is typed (the page, runner.ts `stdin-raw`): no line
    // editing, no echo, Ctrl+C and Ctrl+D as bytes. A pipe has no modes, so it is a no-op there.
    setRawMode: (mode: boolean) => {
      if (!ttyState.on) return stdin;
      const on = !!mode;
      if (on !== stdin.isRaw && notify) post({ type: "stdin-raw", on });
      stdin.isRaw = on;
      return stdin;
    },
    ref() {},
    unref() {},
  });
  let waiting = false;
  let paused = false;
  /** Whether something reads it: a `data` or `readable` listener (an async iterator is one), not paused, not at its end. */
  const sync = (adding?: string) => {
    const readers = stdin.listenerCount("data") + stdin.listenerCount("readable") + (adding === "data" || adding === "readable" ? 1 : 0);
    const want = readers > 0 && !paused && !stdin.readableEnded && !stdin.destroyed;
    if (want === waiting) return;
    waiting = want;
    if (want) hold(stdin);
    else release(stdin);
    if (notify) post({ type: "stdin-wait", on: want });
  };
  stdin.on("newListener", (event: string) => sync(event));
  stdin.on("removeListener", () => sync());
  // `pause()` lets the program end (readline's `close()` does it); `resume()` and a new reader hold it again.
  const { pause, resume } = stdin;
  stdin.pause = () => {
    paused = true;
    const r = pause.call(stdin);
    sync();
    return r;
  };
  stdin.resume = () => {
    paused = false;
    const r = resume.call(stdin);
    sync();
    return r;
  };
  stdin.on("end", () => sync());
  stdin.on("close", () => sync());
  return stdin;
})();

/** What the page sent: bytes, or null for the end of input. */
export const pushStdin = (data: Uint8Array | null) => void stdinStream.push(data === null ? null : Buffer.from(data));

/** The chunks of stdin as bytes until its end. Ending the loop early leaves the stream open for the next reader. */
async function* chunks(): AsyncGenerator<Uint8Array> {
  const it = (stdinStream as unknown as { iterator(o: object): AsyncIterableIterator<string | Uint8Array> }).iterator({ destroyOnReturn: false });
  const enc = new TextEncoder();
  for await (const c of it) yield typeof c === "string" ? enc.encode(c) : c;
}

/** `Bun.stdin`: a Blob-like over stdin. Reading takes what is typed, and `text()` and the others settle at the end of input. */
export class StdinFile extends Blob {
  readonly name = undefined;
  get size() {
    return Infinity;
  }
  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const it = chunks();
    return new ReadableStream({
      async pull(c) {
        const r = await it.next();
        if (r.done) c.close();
        else c.enqueue(r.value as Uint8Array<ArrayBuffer>);
      },
      cancel: () => void it.return(undefined),
    });
  }
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    const parts: Uint8Array[] = [];
    let n = 0;
    for await (const c of chunks()) (parts.push(c), (n += c.length));
    const all = new Uint8Array(n);
    let at = 0;
    for (const p of parts) (all.set(p, at), (at += p.length));
    return all;
  }
  async arrayBuffer() {
    return (await this.bytes()).buffer;
  }
  async text() {
    return new TextDecoder().decode(await this.bytes());
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

/**
 * `for await (const line of console)`: the pieces of stdin between its newlines, as Bun's are: the last one too, so
 * input that ends with a newline ends with an empty line; no input at all gives none. A `\r` stays in its line.
 */
export async function* consoleLines(): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let rest = "";
  let any = false;
  for await (const c of chunks()) {
    any ||= c.length > 0;
    rest += dec.decode(c, { stream: true });
    const parts = rest.split("\n");
    rest = parts.pop()!;
    for (const line of parts) yield line;
  }
  rest += dec.decode();
  if (any) yield rest;
}

/**
 * Bun's `prompt`, `confirm` and `alert`: the question goes to the console and one line of stdin answers it. They are
 * synchronous, so the program blocks until the page sends the line, which needs a cross-origin isolated page (see
 * `readLineSync`); elsewhere they throw a NotIsolatedError.
 */
export function installDialogs(target: Record<string, unknown>, write: (text: string) => void) {
  const ask = (api: string, question: string) => {
    write(question);
    return readLineSync(api);
  };
  Object.assign(target, {
    prompt: (message?: unknown, defaultValue?: unknown) => {
      const text = message === undefined ? "Prompt" : String(message);
      const line = ask("prompt()", defaultValue === undefined ? `${text} ` : `${text} [${String(defaultValue)}] `);
      return line === null || line === "" ? (defaultValue === undefined ? null : String(defaultValue)) : line;
    },
    confirm: (message?: unknown) => /^y/i.test(ask("confirm()", `${message === undefined ? "Confirm" : String(message)} [y/N] `) ?? ""),
    alert: (message?: unknown) => void ask("alert()", `${message === undefined ? "Alert" : String(message)} [Enter] `),
  });
}
