import { Buffer } from "buffer";
import EventEmitter from "events";
import { upgradeRequests, type NodeSocketPeer } from "./serve";

type Any = any;

/** One accepted connection: the `ws` API over the page's socket (a MessagePort, see the runtime's ServerWebSocket). */
class ServerSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  binaryType = "nodebuffer";
  bufferedAmount = 0;
  protocol = "";
  extensions = "";
  constructor(private peer: NodeSocketPeer) {
    super();
  }
  send(data: string | ArrayBufferView | ArrayBuffer, a?: unknown, b?: unknown) {
    const cb = (typeof a === "function" ? a : b) as ((e?: Error) => void) | undefined;
    if (this.readyState !== 1) {
      const err = new Error("WebSocket is not open: readyState " + this.readyState);
      if (cb) cb(err);
      else throw err;
      return;
    }
    this.peer.send(data);
    cb?.();
  }
  ping() {}
  pong() {}
  close(code?: number, reason?: string) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.peer.close(code, reason);
  }
  terminate() {
    this.close(1006);
  }
  /** @internal The page's side closed, or `close` finished. */
  closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

/** A `ws` server over the playground's sockets: `handleUpgrade` accepts the page's WebSocket (what Vite's HMR uses). */
class WebSocketServer extends EventEmitter {
  clients = new Set<ServerSocket>();
  options: unknown;
  constructor(options?: unknown) {
    super();
    this.options = options;
  }
  handleUpgrade(req: object, socket: Any, head: unknown, cb: (ws: ServerSocket, req: object) => void) {
    let client: ServerSocket | undefined;
    const accepted = upgradeRequests.get(req)?.({
      open: (peer) => {
        client = new ServerSocket(peer);
        this.clients.add(client);
        client.once("close", () => this.clients.delete(client!));
        cb(client, req);
      },
      message: (data) => client?.emit("message", Buffer.from(data as Any), typeof data !== "string"),
      close: (code, reason) => client?.closed(code, reason),
    });
    if (!accepted) socket?.destroy?.();
  }
  shouldHandle() {
    return true;
  }
  close(cb?: (err?: Error) => void) {
    for (const c of this.clients) c.terminate();
    queueMicrotask(() => {
      this.emit("close");
      cb?.();
    });
  }
}

class WebSocket extends EventEmitter {
  constructor() {
    super();
    throw new Error("WebSocket client connections are not supported in the playground");
  }
}

export default { WebSocketServer, WebSocket, Server: WebSocketServer };
