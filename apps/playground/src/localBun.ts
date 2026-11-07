// "Run with local Bun": a runner on this machine (packages/connect, `bunx @runbun/connect --open`) runs the project
// with native Bun, sandboxed. Found two ways:
//   - the playground is served by the runner (http://localhost:7357/): it asks its own origin for the token, which
//     works in every browser, Safari included;
//   - `?connect=ws://127.0.0.1:7357/__connect/ws?token=…` on another origin (runbun.dev): Chrome and Firefox only,
//     as Safari blocks an https page's requests to http://localhost.
import type { ClientMessage, ConnectInfo, ServerMessage } from "@runbun/connect/protocol";
import { BASE } from "./base";

export interface LocalBun {
  /** Native Bun's version and how runs are sandboxed (bwrap, sandbox-exec, none). */
  bun: string;
  sandbox: string;
  send(m: ClientMessage): void;
  /** Calls `fn` with every message from the runner; returns the unsubscribe. */
  on(fn: (m: ServerMessage) => void): () => void;
  /** Called once if the connection drops (the runner was stopped). */
  onClose?: () => void;
}

const HELLO_TIMEOUT = 3000;

/** Connects to the local runner, if there is one for this page; undefined otherwise (the in-browser runtime runs). */
export async function connectLocalBun(params: URLSearchParams): Promise<LocalBun | undefined> {
  let url = params.get("connect") ?? undefined;
  if (!url && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    // The playground's own dev server (localhost:5173) has no runner: a 404, or Vite's index.html.
    const info = await fetch(`${BASE}__connect/info`, { cache: "no-store" })
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? (r.json() as Promise<ConnectInfo>) : undefined))
      .catch(() => undefined);
    url = info?.ws;
  }
  if (!url) return;
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return resolve(undefined);
    }
    const listeners = new Set<(m: ServerMessage) => void>();
    const timer = setTimeout(() => (ws.close(), resolve(undefined)), HELLO_TIMEOUT);
    let local: LocalBun | undefined;
    ws.onerror = () => {
      clearTimeout(timer);
      if (!local) resolve(undefined);
    };
    ws.onclose = () => local?.onClose?.();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (m.t === "hello" && !local) {
        clearTimeout(timer);
        local = {
          bun: m.bun,
          sandbox: m.sandbox,
          send: (msg) => ws.send(JSON.stringify(msg)),
          on(fn) {
            listeners.add(fn);
            return () => void listeners.delete(fn);
          },
        };
        return resolve(local);
      }
      for (const fn of listeners) fn(m);
    };
  });
}
