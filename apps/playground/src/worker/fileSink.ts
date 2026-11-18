// `Bun.stdout.writer()` / `Bun.stderr.writer()`: Bun's FileSink onto the console. Writes are buffered and go out on
// `flush()`, `end()`, or once the current task and its microtasks are done (before the next timer), as in Bun.

type Chunk = string | ArrayBuffer | ArrayBufferView;

const bytesOf = (c: Chunk) =>
  typeof c === "string" ? new TextEncoder().encode(c) : c instanceof ArrayBuffer ? new Uint8Array(c) : new Uint8Array(c.buffer, c.byteOffset, c.byteLength).slice();

export class FileSink {
  #parts: Uint8Array[] = [];
  #pending = 0;
  #scheduled = false;
  #ended = false;
  readonly #out: (bytes: Uint8Array) => void;

  constructor(out: (bytes: Uint8Array) => void) {
    this.#out = out;
  }

  /** Buffers `chunk`; the bytes buffered. After `end()` it writes nothing and returns true, as Bun's does. */
  write(chunk: Chunk): number | boolean {
    if (this.#ended) return true;
    const b = bytesOf(chunk);
    if (!b.byteLength) return 0;
    this.#parts.push(b);
    this.#pending += b.byteLength;
    if (!this.#scheduled) {
      this.#scheduled = true;
      setTimeout(() => {
        this.#scheduled = false;
        this.#drain();
      }, 0);
    }
    return b.byteLength;
  }

  #drain(): number {
    const n = this.#pending;
    if (!n) return 0;
    const all = new Uint8Array(n);
    let o = 0;
    for (const p of this.#parts) all.set(p, (o += p.byteLength) - p.byteLength);
    this.#parts = [];
    this.#pending = 0;
    this.#out(all);
    return n;
  }

  /** Writes what is buffered; the bytes written. */
  flush(): number | boolean {
    return this.#ended ? true : this.#drain();
  }

  end(): number {
    if (this.#ended) return 0;
    const n = this.#drain();
    this.#ended = true;
    return n;
  }

  ref() {}
  unref() {}
  start() {}
}
