import { Buffer } from "./node/buffer";
import { hold, release } from "./loop";

/**
 * How to connect a socket to the server of this program that has `url`, if one does: `port` is the server's end of
 * the channel, spoken as a preview page's socket speaks it (swPage.ts previewWebSocket, the runtime's openSocket).
 */
export type Connect = (url: URL) => ((headers: [string, string][], port: MessagePort) => void) | undefined;

const HANDLERS = ["open", "message", "error", "close"] as const;

/**
 * The program's `WebSocket`: to a server it started itself (`ws://localhost:<port>`), connected in-process as Bun's
 * client reaches it on a machine; anything else, the browser's (`Browser`). Like Bun's, it holds the program while it is
 * connecting or open, and its binary messages are Buffers until `binaryType` says otherwise.
 */
export function loopbackWebSocket(Browser: typeof WebSocket, connect: Connect): typeof WebSocket {
  class WebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    protocol = "";
    extensions = "";
    bufferedAmount = 0;
    binaryType: string = "nodebuffer";
    declare onopen: ((e: Event) => void) | null;
    declare onmessage: ((e: MessageEvent) => void) | null;
    declare onerror: ((e: Event) => void) | null;
    declare onclose: ((e: CloseEvent) => void) | null;
    declare readonly url: string;
    #port!: MessagePort;
    #opened = false;
    /** Sends in order (a Blob is read first). */
    #queue = Promise.resolve();

    constructor(url: string | URL, protocols?: string | string[]) {
      const u = new URL(url);
      const { port1, port2 } = new MessageChannel();
      const offered = ([] as string[]).concat(protocols ?? []);
      const headers: [string, string][] = [["host", u.host]];
      if (offered.length) headers.push(["sec-websocket-protocol", offered.join(", ")]);
      const start = u.protocol === "ws:" ? connect(u) : undefined;
      if (!start) return new Browser(url, protocols) as never;
      super();
      Object.defineProperty(this, "url", { value: u.href, enumerable: true });
      this.#port = port1;
      port1.onmessage = (e) => this.#receive(e.data);
      hold(this);
      // The handshake goes out a moment later, as over a network: closed before then, the server never hears of it.
      setTimeout(() => (this.readyState === 0 ? start(headers, port2) : this.#receive({ type: "close", code: 1006 })));
    }
    static [Symbol.hasInstance](x: unknown) {
      return x instanceof Browser || (typeof x === "object" && x !== null && #port in x);
    }
    #emit(event: Event) {
      this.dispatchEvent(event);
    }
    #receive(m: { type: string; protocol?: string; data?: string | ArrayBuffer; code?: number; reason?: string; status?: number }): void {
      if (m.type === "open") {
        // Closed while connecting: the connection fails.
        if (this.readyState !== 0) {
          this.#port.postMessage({ type: "close", code: 1006, reason: "" });
          return this.#receive({ type: "close", code: 1006 });
        }
        this.#opened = true;
        this.readyState = 1;
        this.protocol = m.protocol ?? "";
        this.#emit(new Event("open"));
      } else if (m.type === "message" && this.readyState === 1) {
        const d = m.data!;
        const data = typeof d === "string" || this.binaryType === "arraybuffer" ? d : this.binaryType === "blob" ? new Blob([d]) : Buffer.from(d);
        this.#emit(new MessageEvent("message", { data, origin: new URL(this.url).origin }));
      } else if (m.type === "close") {
        if (this.readyState === 3) return;
        const failed = !this.#opened;
        this.readyState = 3;
        this.#port.close();
        release(this);
        if (failed) this.#emit(new ErrorEvent("error", { message: `WebSocket connection to '${this.url}' failed${m.status ? `: Expected 101 status code: ${m.status}` : ""}` }));
        this.#emit(new CloseEvent("close", { code: m.code ?? 1006, reason: m.reason ?? "", wasClean: !failed }));
      }
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState === 0) throw new DOMException("The object is in an invalid state.", "InvalidStateError");
      if (this.readyState !== 1) return;
      this.#queue = this.#queue.then(async () => {
        const payload =
          data instanceof Blob ? await data.arrayBuffer() : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : typeof data === "string" ? data : data.slice(0);
        if (this.readyState === 1) this.#port.postMessage({ type: "message", data: payload });
      });
    }
    /** Without a code, the server hears 1005 (no status), as from Bun's client. */
    close(code?: number, reason?: string) {
      if (this.readyState >= 2) return;
      const connecting = this.readyState === 0;
      this.readyState = 2;
      if (connecting) return;
      this.#queue.then(() => this.#port.postMessage({ type: "close", code: code ?? 1005, reason: reason ?? "" }));
    }
    ping() {}
    pong() {}
    terminate() {
      this.close(1006);
    }
  }
  // `onopen` and the others are listeners from their first assignment on, ordered among the others as in a browser.
  for (const type of HANDLERS) {
    const handlers = new WeakMap<object, ((e: Event) => void) | null>();
    Object.defineProperty(WebSocket.prototype, "on" + type, {
      get(this: WebSocket) {
        return handlers.get(this) ?? null;
      },
      set(this: WebSocket, fn: ((e: Event) => void) | null) {
        if (!handlers.has(this)) this.addEventListener(type, (e) => handlers.get(this)?.call(this, e));
        handlers.set(this, typeof fn === "function" ? fn : null);
      },
      configurable: true,
      enumerable: true,
    });
  }
  return WebSocket as unknown as typeof globalThis.WebSocket;
}
