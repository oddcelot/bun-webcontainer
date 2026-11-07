// "Run with local Bun": a runner on this machine (packages/connect, `bunx @runbun/connect --open`) runs the project
// with native Bun, sandboxed. Found two ways:
//   - the playground is served by the runner (http://127.0.0.1:7357/): it asks its own origin for the token, which
//     works in every browser, Safari included;
//   - `?connect=ws://127.0.0.1:7357/__connect/ws?token=…` on another origin (runbun.dev): Chrome and Firefox only,
//     as Safari blocks an https page's requests to http://localhost. Chrome asks first whether the site may reach
//     devices on the local network, so connecting waits for that answer.
import type { ClientMessage, ConnectInfo, ServerMessage } from "@runbun/connect/protocol";
import { BASE } from "./base";

export interface LocalBun {
  /** Native Bun's version and how runs are sandboxed (bwrap, sandbox-exec, none). */
  bun: string;
  sandbox: string;
  send(m: ClientMessage): void;
  /** Calls `fn` with every message from the runner; returns the unsubscribe. */
  on(fn: (m: ServerMessage) => void): () => void;
  /** Resolves when the connection drops (the runner was stopped). */
  closed: Promise<void>;
}

/** Once the socket is open, the runner says hello at once; a server that doesn't isn't the runner. */
const HELLO_TIMEOUT = 5000;
/** A connection still pending after this is most likely waiting on the browser's permission prompt. */
const WAITING_AFTER = 1500;

/** Whether `url` is a WebSocket on this machine: the runner never lives elsewhere, and anything else would get the project. */
export function isLoopbackWs(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "ws:" || u.protocol === "wss:") && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** The runner's WebSocket URL for this page, if it has one: `?connect=` (on this machine only), or the runner serving this page. */
export async function findLocalBun(params: URLSearchParams): Promise<string | undefined> {
  const url = params.get("connect");
  if (url) {
    if (isLoopbackWs(url)) return url;
    // A link could point this page at someone else's server, which would be sent the project on Run.
    console.warn("[local] ignoring ?connect=: the runner must be on this machine (ws://127.0.0.1, ws://localhost or ws://[::1])");
    return;
  }
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  // The playground's own dev server (localhost:5173) has no runner: a 404, or Vite's index.html.
  const info = await fetch(`${BASE}__connect/info`, { cache: "no-store" })
    .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? (r.json() as Promise<ConnectInfo>) : undefined))
    .catch(() => undefined);
  return info?.ws;
}

/**
 * Connects to the runner at `url`; undefined if it isn't there or the browser refused. There is no time limit before
 * the socket opens (a stopped runner fails at once; a permission prompt takes as long as the reader does): `onWaiting`
 * is called if it takes a while.
 */
export function connectLocalBun(url: string, onWaiting?: () => void): Promise<LocalBun | undefined> {
  return new Promise((resolve) => {
    if (!isLoopbackWs(url)) return resolve(undefined);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return resolve(undefined);
    }
    const listeners = new Set<(m: ServerMessage) => void>();
    let local: LocalBun | undefined;
    let closed!: () => void;
    const waiting = setTimeout(() => onWaiting?.(), WAITING_AFTER);
    let hello: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      clearTimeout(waiting);
      clearTimeout(hello);
      if (!local) resolve(undefined);
    };
    ws.onopen = () => {
      clearTimeout(waiting);
      hello = setTimeout(() => (ws.close(), fail()), HELLO_TIMEOUT);
    };
    ws.onerror = fail;
    ws.onclose = () => (local ? closed() : fail());
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (m.t === "hello" && !local) {
        clearTimeout(hello);
        local = {
          bun: m.bun,
          sandbox: m.sandbox,
          send: (msg) => ws.send(JSON.stringify(msg)),
          on(fn) {
            listeners.add(fn);
            return () => void listeners.delete(fn);
          },
          closed: new Promise((r) => (closed = r)),
        };
        return resolve(local);
      }
      for (const fn of listeners) fn(m);
    };
  });
}
