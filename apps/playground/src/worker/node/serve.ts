export type FetchHandler = (req: Request, server: unknown) => Response | Promise<Response>;

/** The worker's one preview request handler: `Bun.serve` and `http.Server#listen` both register through the runtime's hook. */
export const hooks: { set: (h: FetchHandler | undefined) => void; get: () => FetchHandler | undefined } = { set() {}, get: () => undefined };

/** What a node `ws` connection hears from the page's socket; the runtime routes a `server.upgrade` accepted with these as `data`. */
export type NodeSocket = { open(ws: NodeSocketPeer): void; message(data: string | Uint8Array): void; close(code: number, reason: string): void };
export type NodeSocketPeer = { send(data: string | ArrayBuffer | ArrayBufferView): number; close(code?: number, reason?: string): void };

/** Upgrade requests handed to a node:http server's "upgrade" listeners: `ws`'s `handleUpgrade` accepts one through this. */
export const upgradeRequests = new WeakMap<object, (socket: NodeSocket) => boolean>();
