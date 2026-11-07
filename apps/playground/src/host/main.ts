// The content origin's page (host.html): the editor frames it hidden. It registers the service worker on this origin,
// starts the runtime Worker, and relays the Worker's messages and the service worker's asks (modules, previews,
// WebSockets) to the editor over a MessagePort, which answers them with the handlers it has always had. Nothing the
// editor holds (OPFS, IndexedDB, cookies) is on this origin. Protocol: contentHost.ts.
import { BASE } from "../base";
import { EDITOR_ORIGINS } from "../contentOrigin";

// The editor names its origin (`?editor=`), but only a configured editor origin is answered: any site can frame this
// page, and the relay (a Worker, the service worker's asks, fetch) must serve only the playground.
const asked = new URLSearchParams(location.search).get("editor") ?? "";
const EDITOR = EDITOR_ORIGINS.has(asked) ? asked : "";
const workers = new Map<number, Worker>();
/** Set once the handshake may begin (host-ready sent); cleared by the first connect. */
let started = false;

/** Registers the same sw.js as the editor (the `content` query marks this origin, see sw.ts) and returns this frame's client id. */
async function whoami(): Promise<string> {
  const reg = await navigator.serviceWorker.register(`${BASE}sw.js?content`, { scope: BASE });
  await reg.update().catch(() => {});
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await Promise.race([new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })), new Promise((r) => setTimeout(r, 3000))]);
  const sw = navigator.serviceWorker.controller;
  if (!sw) throw new Error("service worker is not controlling the host frame");
  const ch = new MessageChannel();
  const answer = new Promise<string>((r) => (ch.port1.onmessage = (e) => r(e.data)));
  sw.postMessage({ type: "whoami" }, [ch.port2]);
  return answer;
}

function connect(port: MessagePort) {
  // The service worker's asks (a page-owned module, a preview request, a preview WebSocket): the editor answers on the
  // reply port it is handed.
  navigator.serviceWorker.onmessage = (e) => port.postMessage({ t: "sw", d: e.data }, [...e.ports]);
  port.onmessage = async (e) => {
    const m = e.data;
    if (m.t === "spawn") {
      const g: number = m.g;
      const worker = new Worker(new URL("../worker/runtime.ts", import.meta.url), { type: "module" });
      workers.set(g, worker);
      worker.onmessage = (we) => port.postMessage({ t: "w", g, d: we.data }, [...we.ports]);
      worker.onerror = (we) => port.postMessage({ t: "werr", g, message: we.message });
    } else if (m.t === "w") {
      // Ports ride in the transfer list (a request's reply port, a WebSocket); the message itself is cloned.
      workers.get(m.g)?.postMessage(m.d, [...e.ports]);
    } else if (m.t === "kill") {
      workers.get(m.g)?.terminate();
      workers.delete(m.g);
    } else if (m.t === "fetch") {
      // The editor can't fetch from this origin's service worker (it doesn't control the editor); this frame does.
      const reply = e.ports[0];
      try {
        const res = await fetch(m.url, { method: m.method, headers: m.headers, body: m.body });
        const body = await res.arrayBuffer();
        reply.postMessage({ status: res.status, statusText: res.statusText, headers: [...res.headers], body }, [body]);
      } catch (err) {
        reply.postMessage({ error: String(err) });
      }
    }
  };
}

window.addEventListener("message", (e) => {
  // Only the editor that framed us, once.
  if (e.source !== window.parent || e.origin !== EDITOR || e.data?.v !== 1 || e.data.kind !== "connect" || !e.ports[0]) return;
  if (!started) return;
  started = false;
  connect(e.ports[0]);
});
if (!EDITOR) throw new Error(`host.html: ${asked || "no editor"} is not a configured editor origin`);
whoami().then(
  (id) => {
    started = true;
    window.parent.postMessage({ v: 1, kind: "host-ready", id }, EDITOR);
  },
  (err) => window.parent.postMessage({ v: 1, kind: "host-error", message: String(err) }, EDITOR),
);
