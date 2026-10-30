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

/**
 * The window client with this id, if any. Not clients.get(): Firefox makes it wait until the client is execution-ready,
 * and a module worker isn't until its imports have loaded, so asking about the worker's own imports deadlocks.
 */
async function windowClient(id) {
  if (!id) return undefined;
  return (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).find((c) => c.id === id);
}

/**
 * How long a module request, or a preview response's head, waits for the page. A fetch that never settles keeps this
 * worker busy, and a new sw.js stays "waiting" behind it despite skipWaiting().
 */
const ASK_TIMEOUT = 30_000;
const timedOut = () => `No answer from the playground within ${ASK_TIMEOUT / 1000}s`;

/** Asks `owner` (the page a module URL names), else the playground page. */
async function ask(msg, owner) {
  const client = owner ?? (await host());
  if (!client) throw new Error("playground page not found");
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => {
      ch.port1.close();
      resolve({ status: 504, statusText: "", headers: [["content-type", "text/plain"]], body: new TextEncoder().encode(timedOut()).buffer });
    }, ASK_TIMEOUT);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    client.postMessage(msg, [ch.port2]);
  });
}

/**
 * A preview request: resolves with the response's head and its body as a stream, fed as the server produces it
 * (`head`, `chunk`…, `end` or `error`; see sendResponse in worker/runtime.ts). Cancelling the stream tells the server.
 */
async function askStream(msg, owner) {
  const client = owner ?? (await host());
  if (!client) throw new Error("playground page not found");
  const ch = new MessageChannel();
  const port = ch.port1;
  let ctrl;
  const body = new ReadableStream({
    start: (c) => void (ctrl = c),
    cancel: () => {
      port.postMessage({ type: "cancel" });
      port.close();
    },
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      port.close();
      ctrl.enqueue(new TextEncoder().encode(timedOut()));
      ctrl.close();
      resolve({ head: { status: 504, statusText: "", headers: [["content-type", "text/plain"]] }, body });
    }, ASK_TIMEOUT);
    port.onmessage = ({ data }) => {
      if (data.type === "head") {
        clearTimeout(timer);
        resolve({ head: data, body });
      } else if (data.type === "chunk") ctrl.enqueue(new Uint8Array(data.data));
      else {
        port.close();
        if (data.type === "end") ctrl.close();
        else ctrl.error(new Error(data.message));
      }
    };
    client.postMessage(msg, [ch.port2]);
  });
}

async function serveModule(url, clientId) {
  let path = decodeURIComponent(url.pathname.slice(VFS.length));
  // `@<client id>/`: the page whose project this is (moduleServer.ts setVfsOwner); playgrounds in other tabs, or
  // other embeds on the same page, share this worker.
  const at = /^@([^/]+)\//.exec(path);
  const owner = at ? await windowClient(at[1]) : undefined;
  if (at) path = path.slice(at[0].length);
  if (at && !owner) return new Response("The playground page that served this module is gone", isolated({ status: 410, headers: { "content-type": "text/plain" } }));
  // The worker runs the program (Bun's runtime conditions); a page gets the browser's.
  const r = await ask({ type: "module", path, target: (await windowClient(clientId)) ? "browser" : "bun" }, owner);
  // A stylesheet as a `<link>` loads it, CSS imported from code is a module (`__css/<path>`).
  const type = url.pathname.endsWith(".css") && !path.startsWith("__css/") ? "text/css" : "text/javascript";
  return new Response(r.body, isolated({
    status: r.status,
    headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" },
  }));
}

const NO_PLAYGROUND = `<!doctype html><meta name="color-scheme" content="light dark"><title>Preview unavailable</title>
<body style="font: 15px system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.3rem">The playground isn't open</h1>
<p>This preview's server runs in the playground's tab. Open <a href="${BASE}">the playground</a>, press Run, then reload this page.</p>`;

/**
 * `/__preview/@<client id>/…`: the page whose server a preview shows (preview.ts setPreviewOwner), so previews of
 * playgrounds in other tabs, or of other embeds on the same page, reach their own server.
 */
const previewOwnerOf = (pathname) => (pathname.startsWith(`${PREVIEW}/@`) ? pathname.slice(PREVIEW.length + 2).split("/")[0] : undefined);
const previewBase = (id) => (id ? `${PREVIEW}/@${id}` : PREVIEW);

async function servePreview(req, url, path, ownerId = previewOwnerOf(url.pathname)) {
  const base = previewBase(ownerId);
  path ??= (url.pathname.slice(base.length) || "/") + url.search;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : null;
  let asked;
  try {
    const owner = ownerId ? await windowClient(ownerId) : undefined;
    if (ownerId && !owner) throw new Error("gone");
    asked = await askStream({
      type: "preview",
      // A 304 would reach the page as an empty response (we answer from memory, nothing is cached), so never ask for one.
      req: { path, method: req.method, headers: [...req.headers].filter(([k]) => k !== "if-none-match" && k !== "if-modified-since"), body },
    }, owner);
  } catch {
    // The server runs in the playground's tab: a preview opened in its own tab needs that one open.
    return new Response(NO_PLAYGROUND, isolated({ status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }));
  }
  const { head, body: stream } = asked;
  const nullBody = [101, 204, 205, 304].includes(head.status);
  const headers = new Headers(head.headers);
  // Redirects to an absolute path stay inside the preview (`redirect("/")` from a form post).
  const location = headers.get("location");
  if (location?.startsWith("/") && !location.startsWith("//") && !location.startsWith(PREVIEW)) headers.set("location", base + location);
  let out = stream;
  if (nullBody) {
    out = null;
    stream.cancel().catch(() => {});
  } else if (headers.get("content-type")?.startsWith("text/html")) {
    // The preview scripts go into <head>, so an HTML page is read whole first.
    out = withPreviewScripts(await new Response(stream).text(), base);
    headers.delete("content-length");
  }
  return new Response(out, isolated({ status: head.status, statusText: head.statusText, headers }));
}

/**
 * Runs first in every preview page: same-host WebSockets go to the worker's `Bun.serve` instead of the
 * network, and the page follows the playground's color scheme toggle.
 */
function withPreviewScripts(html, base) {
  const script =
    `<script>(${previewWebSocket})(${JSON.stringify(base)})</script>` +
    `<script>(${previewColorScheme})()</script>`;
  const head = html.match(/<head\b[^>]*>/i);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? doctype[0] + script + html.slice(doctype[0].length) : script + html;
}

// Serialized into the page, so it may only use what it declares.
// The playground's mode (theme.ts): system leaves the page to the OS preference; light or dark narrows a page
// that supports both schemes, or declares none, to that one. `prefers-color-scheme` still follows the OS:
// no page can set it for a frame.
function previewColorScheme() {
  const meta = Object.assign(document.createElement("meta"), { name: "color-scheme" });
  const style = document.createElement("style");
  const apply = (mode) => {
    meta.content = mode === "light" || mode === "dark" ? mode : "light dark";
    style.textContent = meta.content.includes(" ") ? "" : `:root { color-scheme: ${meta.content} !important; }`;
  };
  try {
    apply(JSON.parse(localStorage.getItem("theme-selection") ?? "{}").mode);
  } catch {
    apply("system");
  }
  document.head.append(meta, style);
  const channel = new BroadcastChannel("bun-color-scheme");
  channel.onmessage = (e) => apply(e.data);
  // The playground calls this directly on its preview iframes, so a theme transition captures them switched.
  window.__bunColorScheme = apply;
  // A page that supports only one scheme keeps it.
  addEventListener("load", () => {
    style.sheet.disabled = true;
    const css = getComputedStyle(document.documentElement).colorScheme;
    style.sheet.disabled = false;
    const own = [...document.querySelectorAll('meta[name="color-scheme"]')].find((m) => m !== meta)?.content;
    const declared = css !== "normal" ? css : own;
    if (declared && !(declared.includes("light") && declared.includes("dark"))) {
      meta.remove();
      style.remove();
      channel.close();
      delete window.__bunColorScheme;
    }
  });
}

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
      // The page's own host is the preview server; another port on it, or on localhost, may be another Bun.serve in
      // the worker (devframe connects to `${location.hostname}:${port}`, which is runbun.dev:<port> when deployed).
      const local =
        u.host === location.host
          ? undefined
          : u.hostname === location.hostname || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
            ? Number(u.port || (u.protocol === "wss:" || u.protocol === "https:" ? 443 : 80))
            : null;
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

// A page asks which client it is (boot.ts), to put in its module URLs.
self.addEventListener("message", (e) => {
  if (e.data?.type === "whoami") e.ports[0]?.postMessage(e.source?.id);
});

// A preview page's WebSocket (see previewWebSocket): hand its port to the playground, which passes it to the worker.
self.addEventListener("message", (e) => {
  if (e.data?.type !== "ws") return;
  const ownerId = e.source?.url && previewOwnerOf(new URL(e.source.url).pathname);
  e.waitUntil((ownerId ? windowClient(ownerId) : host()).then((c) => (c ? c.postMessage(e.data, [e.ports[0]]) : e.ports[0].postMessage({ type: "close", code: 1011, reason: "playground page not found" }))));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(VFS)) e.respondWith(serveModule(url, e.clientId));
  // A link, form or redirect in the preview frame that leaves `/__preview` (`<a href="/entries/2">`): same server.
  else if (e.request.mode === "navigate" && e.request.destination === "iframe" && !url.pathname.startsWith(PREVIEW))
    e.respondWith(leavePreview(e.request, url));
  else if (url.pathname === PREVIEW || url.pathname.startsWith(`${PREVIEW}/`)) e.respondWith(servePreview(e.request, url));
  else if (e.clientId) e.respondWith(fromPreviewOrNetwork(e));
});

/** A preview frame navigating outside `/__preview` (a link to `/entries/2`): its own server, found from where it came from. */
function leavePreview(req, url) {
  const ownerId = req.referrer ? previewOwnerOf(new URL(req.referrer).pathname) : undefined;
  if (req.method === "GET") return Response.redirect(previewBase(ownerId) + url.pathname + url.search, 302);
  return servePreview(req, url, url.pathname + url.search, ownerId);
}

// The preview page is the app's origin: its absolute requests (`fetch("/api/hello")`) go to Bun.serve.
async function fromPreviewOrNetwork(e) {
  const client = await windowClient(e.clientId);
  if (client && new URL(client.url).pathname.startsWith(PREVIEW)) {
    const url = new URL(e.request.url);
    const ownerId = previewOwnerOf(new URL(client.url).pathname);
    if (e.request.mode === "navigate") {
      // A preview in its own tab following a link out of /__preview: with no playground open there's no server, so
      // it's the playground being opened; otherwise it's the app's own page, as for the iframe above.
      if (!(ownerId ? await windowClient(ownerId) : await host())) return fetch(e.request);
      if (e.request.method === "GET") return Response.redirect(previewBase(ownerId) + url.pathname + url.search, 302);
    }
    return servePreview(e.request, url, url.pathname + url.search, ownerId);
  }
  return fetch(e.request);
}
