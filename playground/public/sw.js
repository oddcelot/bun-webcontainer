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
  return all.find((c) => !new URL(c.url).pathname.startsWith("/__preview"));
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

async function serveModule(url) {
  const path = decodeURIComponent(url.pathname.slice("/__vfs/".length));
  const r = await ask({ type: "module", path });
  const type = url.pathname.endsWith(".css") ? "text/css" : "text/javascript";
  return new Response(r.body, isolated({
    status: r.status,
    headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" },
  }));
}

async function servePreview(req, url, path = (url.pathname.slice("/__preview".length) || "/") + url.search) {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : null;
  const r = await ask({
    type: "preview",
    // A 304 would reach the page as an empty response (we answer from memory, nothing is cached), so never ask for one.
    req: { path, method: req.method, headers: [...req.headers].filter(([k]) => k !== "if-none-match" && k !== "if-modified-since"), body },
  });
  const nullBody = [101, 204, 205, 304].includes(r.status);
  return new Response(nullBody ? null : r.body, isolated({ status: r.status, statusText: r.statusText, headers: r.headers }));
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/__vfs/")) e.respondWith(serveModule(url));
  else if (url.pathname === "/__preview" || url.pathname.startsWith("/__preview/")) e.respondWith(servePreview(e.request, url));
  else if (e.clientId) e.respondWith(fromPreviewOrNetwork(e));
});

// The preview page is the app's origin: its absolute requests (`fetch("/api/hello")`) go to Bun.serve.
async function fromPreviewOrNetwork(e) {
  const client = await self.clients.get(e.clientId);
  if (client && new URL(client.url).pathname.startsWith("/__preview")) {
    const url = new URL(e.request.url);
    return servePreview(e.request, url, url.pathname + url.search);
  }
  return fetch(e.request);
}
