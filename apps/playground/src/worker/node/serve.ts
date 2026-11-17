export type FetchHandler = (req: Request, server: unknown) => Response | Promise<Response>;

/** A node:http server the runtime serves, as it does a `Bun.serve`: on `port`, until `stop()`. */
export type NodeListener = { port: number; stop(): void };

/**
 * `http.Server#listen` registers its handler through the runtime's hook: on `port` (0: one of its own), reachable
 * like a `Bun.serve` (the preview, loopback fetches). Throws Bun's EADDRINUSE error for a port already served.
 */
export const hooks: { listen: (h: FetchHandler, port: number) => NodeListener } = {
  listen() {
    throw new Error("node:http servers need the playground's runtime");
  },
};

/** What a node `ws` connection hears from the page's socket; the runtime routes a `server.upgrade` accepted with these as `data`. */
export type NodeSocket = { open(ws: NodeSocketPeer): void; message(data: string | Uint8Array): void; close(code: number, reason: string): void };
export type NodeSocketPeer = { send(data: string | ArrayBuffer | ArrayBufferView): number; close(code?: number, reason?: string): void };

/** Upgrade requests handed to a node:http server's "upgrade" listeners: `ws`'s `handleUpgrade` accepts one through this. */
export const upgradeRequests = new WeakMap<object, (socket: NodeSocket) => boolean>();
