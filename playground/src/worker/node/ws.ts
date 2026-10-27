import EventEmitter from "events";

/** Stand-in for Bun's built-in `ws` (what Vite's `import.meta.require("ws")` gets): a server without sockets, so no client ever connects. */
class WebSocketServer extends EventEmitter {
  clients = new Set();
  options: unknown;
  constructor(options?: unknown) {
    super();
    this.options = options;
  }
  handleUpgrade() {}
  shouldHandle() {
    return false;
  }
  close(cb?: () => void) {
    queueMicrotask(() => {
      this.emit("close");
      cb?.();
    });
  }
}

class WebSocket extends EventEmitter {
  constructor() {
    super();
    throw new Error("WebSocket connections are not supported in the playground");
  }
}

export default { WebSocketServer, WebSocket, Server: WebSocketServer };
