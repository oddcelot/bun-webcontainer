// The app's base path: sw.js sits at <base>sw.js (Vite copies public/ to the base).
const BASE = new URL("./", self.location.href).pathname;
const VFS = `${BASE}__vfs/`;
const PREVIEW = `${BASE}__preview`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Cross-origin isolation: every response we synthesize needs COEP (documents/workers) and CORP (subresources).
function isolated(init) {
  const headers = new Headers(init.headers);
  headers.set("cross-origin-embedder-policy", "credentialless");
  headers.set("cross-origin-resource-policy", "same-origin");
  return { ...init, headers };
}

async function host() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => !new URL(c.url).pathname.startsWith(PREVIEW));
}

async function ask(msg) {
  const client = await host();
  if (!client) throw new Error("playground page not found");
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data);
    client.postMessage(msg, [ch.port2]);
  });
}

async function serveModule(url, clientId) {
  const path = decodeURIComponent(url.pathname.slice(VFS.length));
  // The worker runs the program (Bun's runtime conditions); a page gets the browser's.
  const client = clientId && (await self.clients.get(clientId));
  const r = await ask({ type: "module", path, target: client?.type === "window" ? "browser" : "bun" });
  const type = url.pathname.endsWith(".css") ? "text/css" : "text/javascript";
  return new Response(r.body, isolated({
    status: r.status,
    headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" },
  }));
}

async function servePreview(req, url, path = (url.pathname.slice(PREVIEW.length) || "/") + url.search) {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : null;
  const r = await ask({
    type: "preview",
    // A 304 would reach the page as an empty response (we answer from memory, nothing is cached), so never ask for one.
    req: { path, method: req.method, headers: [...req.headers].filter(([k]) => k !== "if-none-match" && k !== "if-modified-since"), body },
  });
  const nullBody = [101, 204, 205, 304].includes(r.status);
  const headers = new Headers(r.headers);
  let out = r.body;
  if (!nullBody && headers.get("content-type")?.startsWith("text/html")) {
    out = withWebSocketShim(new TextDecoder().decode(out));
    headers.delete("content-length");
  }
  return new Response(nullBody ? null : out, isolated({ status: r.status, statusText: r.statusText, headers }));
}

/** Runs first in every preview page: same-host WebSockets go to the worker's `Bun.serve` instead of the network. */
function withWebSocketShim(html) {
  const script = `<script>(${previewWebSocket})(${JSON.stringify(PREVIEW)})</script>`;
  const head = html.match(/<head\b[^>]*>/i);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? doctype[0] + script + html.slice(doctype[0].length) : script + html;
}

// Serialized into the page, so it may only use what it declares.
function previewWebSocket(prefix) {
  const Native = window.WebSocket;
  /** Connected sockets, each with what drops it. */
  const open = new Map();
  class PreviewWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    protocol = "";
    extensions = "";
    bufferedAmount = 0;
    binaryType = "blob";
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    #port;
    #queue = Promise.resolve();
    constructor(url, protocols) {
      const u = new URL(url, location.href);
      // The page's own host is the preview server; `localhost:<port>` may be another Bun.serve in the worker.
      const local = u.host === location.host ? undefined : ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ? Number(u.port || 80) : null;
      if (local === null) return new Native(url, protocols);
      super();
      u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
      this.url = u.href;
      const path = (u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) || "/" : u.pathname) + u.search;
      const { port1, port2 } = new MessageChannel();
      this.#port = port1;
      port1.onmessage = (e) => this.#receive(e.data);
      const headers = [["origin", location.origin]];
      if (protocols?.length) headers.push(["sec-websocket-protocol", [].concat(protocols).join(", ")]);
      const sw = navigator.serviceWorker;
      (sw.controller ? Promise.resolve(sw.controller) : sw.ready.then((r) => r.active)).then((c) => c.postMessage({ type: "ws", path, headers, port: local }, [port2]));
    }
    #emit(event) {
      this.dispatchEvent(event);
      this["on" + event.type]?.call(this, event);
    }
    #receive(m) {
      if (m.type === "open") {
        this.readyState = 1;
        this.protocol = m.protocol ?? "";
        open.set(this, () => this.#receive({ type: "close", code: 1006, reason: "" }));
        this.#emit(new Event("open"));
      } else if (m.type === "message") {
        const data = typeof m.data === "string" || this.binaryType === "arraybuffer" ? m.data : new Blob([m.data]);
        this.#emit(new MessageEvent("message", { data, origin: new URL(this.url).origin }));
      } else if (m.type === "close") {
        if (this.readyState === 3) return;
        const failed = this.readyState === 0;
        this.readyState = 3;
        open.delete(this);
        this.#port.close();
        if (failed) this.#emit(new Event("error"));
        this.#emit(new CloseEvent("close", { code: m.code ?? 1006, reason: m.reason ?? "", wasClean: !failed }));
      }
    }
    send(data) {
      if (this.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      if (this.readyState !== 1) return;
      // Blobs read asynchronously; the queue keeps messages in order.
      this.#queue = this.#queue.then(async () => {
        const payload = data instanceof Blob ? await data.arrayBuffer() : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
        this.#port.postMessage({ type: "message", data: payload });
      });
    }
    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      this.#queue.then(() => this.#port.postMessage({ type: "close", code, reason }));
    }
  }
  // Leaving the page: tell the server, as a closing tab would.
  addEventListener("pagehide", () => open.forEach((_, ws) => ws.close(1001)));
  // The playground stopped the worker (Run restarts it): the connection dropped, so the page can reconnect.
  new BroadcastChannel("bun-preview").onmessage = (e) => e.data === "stopped" && open.forEach((drop) => drop());
  window.WebSocket = PreviewWebSocket;
}

// A preview page's WebSocket (see previewWebSocket): hand its port to the playground, which passes it to the worker.
self.addEventListener("message", (e) => {
  if (e.data?.type !== "ws") return;
  e.waitUntil(host().then((c) => (c ? c.postMessage(e.data, [e.ports[0]]) : e.ports[0].postMessage({ type: "close", code: 1011, reason: "playground page not found" }))));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(VFS)) e.respondWith(serveModule(url, e.clientId));
  else if (url.pathname === PREVIEW || url.pathname.startsWith(`${PREVIEW}/`)) e.respondWith(servePreview(e.request, url));
  else if (e.clientId) e.respondWith(fromPreviewOrNetwork(e));
});

// The preview page is the app's origin: its absolute requests (`fetch("/api/hello")`) go to Bun.serve.
async function fromPreviewOrNetwork(e) {
  const client = await self.clients.get(e.clientId);
  if (client && new URL(client.url).pathname.startsWith(PREVIEW)) {
    const url = new URL(e.request.url);
    return servePreview(e.request, url, url.pathname + url.search);
  }
  return fetch(e.request);
}
