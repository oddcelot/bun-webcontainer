/// <reference lib="webworker" />
// Built to <base>sw.js as one classic script (vite.config.ts serviceWorker). Page-side code lives in swPage.ts.
import { previewColorScheme, previewWebSocket } from "#sw-page";
import { HEADERS_HEADER, PANEL_COOKIE, mergeHeaders, unpackHeaders } from "./request";

declare const self: ServiceWorkerGlobalScope;

type HeaderList = [string, string][];
/** What a page answers a `module` request with (moduleServer.ts). */
interface ModuleReply {
  status: number;
  statusText?: string;
  headers: HeaderList;
  body: BodyInit | null;
}
/** What a page sends back over a preview request's port (see sendResponse in worker/runtime.ts). */
type StreamMessage = { type: "head"; status: number; statusText: string; headers: HeaderList } | { type: "chunk"; data: ArrayBuffer } | { type: "end" } | { type: "error"; message: string };
interface StreamHead {
  status: number;
  statusText: string;
  headers: HeaderList;
}
interface PreviewRequest {
  path: string;
  method: string;
  headers: HeaderList;
  body: ArrayBuffer | null;
}
/** Sent to a page. */
type Ask = { type: "module"; path: string; target: "browser" | "bun" } | { type: "preview"; req: PreviewRequest };
/** A preview page's WebSocket, from previewWebSocket (swPage.ts). */
interface WsRequest {
  type: "ws";
  path: string;
  headers: HeaderList;
  port: number | undefined;
}

// The app's base path: the worker is served at <base>sw.js.
const BASE = new URL("./", self.location.href).pathname;
const VFS = `${BASE}__vfs/`;
const PREVIEW = `${BASE}__preview`;
/** Pages other sites frame (embed.html, configure.html): an iframe navigating to one isn't a preview leaving `/__preview`. */
const FRAMED = new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(embed|configure)(\\.html)?$`);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Cross-origin isolation: every response we synthesize needs COEP (documents/workers) and CORP (subresources).
function isolated(init: ResponseInit): ResponseInit {
  const headers = new Headers(init.headers);
  headers.set("cross-origin-embedder-policy", "credentialless");
  headers.set("cross-origin-resource-policy", "same-origin");
  return { ...init, headers };
}

async function host(): Promise<Client | undefined> {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => !new URL(c.url).pathname.startsWith(PREVIEW));
}

/**
 * The window client with this id, if any. Not clients.get(): Firefox makes it wait until the client is execution-ready,
 * and a module worker isn't until its imports have loaded, so asking about the worker's own imports deadlocks.
 */
async function windowClient(id?: string): Promise<Client | undefined> {
  if (!id) return undefined;
  return (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).find((c) => c.id === id);
}

/**
 * How long a module request, or a preview response's head, waits for the page. A fetch that never settles keeps this
 * worker busy, and a new service worker stays "waiting" behind it despite skipWaiting().
 */
const ASK_TIMEOUT = 30_000;
const timedOut = () => `No answer from the playground within ${ASK_TIMEOUT / 1000}s`;

/** Asks `owner` (the page a module URL names), else the playground page. */
async function ask(msg: Ask, owner?: Client): Promise<ModuleReply> {
  const client = owner ?? (await host());
  if (!client) throw new Error("playground page not found");
  return new Promise<ModuleReply>((resolve) => {
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
async function askStream(msg: Ask, owner?: Client): Promise<{ head: StreamHead; body: ReadableStream<Uint8Array> }> {
  const client = owner ?? (await host());
  if (!client) throw new Error("playground page not found");
  const ch = new MessageChannel();
  const port = ch.port1;
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
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
    port.onmessage = ({ data }: MessageEvent<StreamMessage>) => {
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

async function serveModule(url: URL, clientId: string): Promise<Response> {
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
const previewOwnerOf = (pathname: string): string | undefined => (pathname.startsWith(`${PREVIEW}/@`) ? pathname.slice(PREVIEW.length + 2).split("/")[0] : undefined);
const previewBase = (id?: string) => (id ? `${PREVIEW}/@${id}` : PREVIEW);

/**
 * The request panel's headers (request.ts) for the page load that follows an HTML GET sent with them, by owner and
 * path: the playground loads the page in its frame with a second GET, and a navigation can't carry headers. Taken by
 * the first navigation to that path, if it comes within HANDOFF_MS; the page's own loads (scripts, fetches, links) go
 * without them.
 */
const handoff = new Map<string, { headers: [string, string][]; at: number }>();
const HANDOFF_MS = 10_000;

async function servePreview(req: Request, url: URL, path?: string, ownerId = previewOwnerOf(url.pathname)): Promise<Response> {
  const base = previewBase(ownerId);
  path ??= (url.pathname.slice(base.length) || "/") + url.search;
  const key = `${ownerId ?? ""} ${path}`;
  let extra = unpackHeaders(req.headers.get(HEADERS_HEADER));
  if (!extra.length && req.mode === "navigate") {
    const left = handoff.get(key);
    handoff.delete(key);
    if (left && Date.now() - left.at < HANDOFF_MS) extra = left.headers;
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : null;
  let asked: Awaited<ReturnType<typeof askStream>>;
  try {
    const owner = ownerId ? await windowClient(ownerId) : undefined;
    if (ownerId && !owner) throw new Error("gone");
    asked = await askStream({
      type: "preview",
      // A 304 would reach the page as an empty response (we answer from memory, nothing is cached), so never ask for one.
      req: {
        path,
        method: req.method,
        headers: mergeHeaders(
          [...req.headers].filter(([k]) => k !== "if-none-match" && k !== "if-modified-since" && k !== HEADERS_HEADER),
          extra.map(([k, v]) => [k.toLowerCase() === "cookie" ? PANEL_COOKIE : k, v]),
        ),
        body,
      },
    }, owner);
  } catch {
    // The server runs in the playground's tab: a preview opened in its own tab needs that one open.
    return new Response(NO_PLAYGROUND, isolated({ status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }));
  }
  const { head, body: stream } = asked;
  const nullBody = [101, 204, 205, 304].includes(head.status);
  const headers = new Headers(head.headers);
  if (extra.length && req.method === "GET" && req.mode !== "navigate" && headers.get("content-type")?.startsWith("text/html")) handoff.set(key, { headers: extra, at: Date.now() });
  // Redirects to an absolute path stay inside the preview (`redirect("/")` from a form post).
  const location = headers.get("location");
  if (location?.startsWith("/") && !location.startsWith("//") && !location.startsWith(PREVIEW)) headers.set("location", base + location);
  let out: BodyInit | null = stream;
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
function withPreviewScripts(html: string, base: string): string {
  const script =
    `<script>(${previewWebSocket})(${JSON.stringify(base)})</script>` +
    `<script>(${previewColorScheme})()</script>`;
  const head = html.match(/<head\b[^>]*>/i);
  if (head) return html.slice(0, head.index! + head[0].length) + script + html.slice(head.index! + head[0].length);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? doctype[0] + script + html.slice(doctype[0].length) : script + html;
}

// A page asks which client it is (boot.ts), to put in its module URLs.
self.addEventListener("message", (e) => {
  if (e.data?.type === "whoami") e.ports[0]?.postMessage((e.source as Client | null)?.id);
});

// A preview page's WebSocket (see previewWebSocket): hand its port to the playground, which passes it to the worker.
self.addEventListener("message", (e) => {
  if (e.data?.type !== "ws") return;
  const data: WsRequest = e.data;
  const url = (e.source as Client | null)?.url;
  const ownerId = url && previewOwnerOf(new URL(url).pathname);
  e.waitUntil((ownerId ? windowClient(ownerId) : host()).then((c) => (c ? c.postMessage(data,[e.ports[0]]) : e.ports[0].postMessage({ type: "close", code: 1011, reason: "playground page not found" }))));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(VFS)) e.respondWith(serveModule(url, e.clientId));
  // A link, form or redirect in the preview frame that leaves `/__preview` (`<a href="/entries/2">`): same server.
  // Not the pages other sites frame.
  else if (e.request.mode === "navigate" && e.request.destination === "iframe" && !url.pathname.startsWith(PREVIEW) && !FRAMED.test(url.pathname))
    e.respondWith(leavePreview(e.request, url));
  else if (url.pathname === PREVIEW || url.pathname.startsWith(`${PREVIEW}/`)) e.respondWith(servePreview(e.request, url));
  else if (e.clientId) e.respondWith(fromPreviewOrNetwork(e));
});

/** A preview frame navigating outside `/__preview` (a link to `/entries/2`): its own server, found from where it came from. */
function leavePreview(req: Request, url: URL): Response | Promise<Response> {
  const ownerId = req.referrer ? previewOwnerOf(new URL(req.referrer).pathname) : undefined;
  if (req.method === "GET") return Response.redirect(previewBase(ownerId) + url.pathname + url.search, 302);
  return servePreview(req, url, url.pathname + url.search, ownerId);
}

// The preview page is the app's origin: its absolute requests (`fetch("/api/hello")`) go to Bun.serve.
async function fromPreviewOrNetwork(e: FetchEvent): Promise<Response> {
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
