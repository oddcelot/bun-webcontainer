// The content origin's page (host.html): the editor frames it hidden. It registers the service worker on this origin,
// starts the runtime Worker, and relays the Worker's messages and the service worker's asks (modules, previews,
// WebSockets) to the editor over a MessagePort, which answers them with the handlers it has always had. Nothing the
// editor holds (OPFS, IndexedDB, cookies) is on this origin. Protocol: contentProtocol.ts.
import { BASE } from "../base";
import { EDITOR_ORIGINS } from "../contentOrigin";
import { envelope, isMessage, type HandshakeMessage, type ToEditor, type ToHost } from "../contentProtocol";

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

/** This frame's client id (the preview base's `@<id>`), once known. */
let myId = "";
/** The editor's cookie requests run one at a time, in the order they came. */
let cookieQueue: Promise<unknown> = Promise.resolve();
/** The blank page under the preview's base whose document.cookie is the browser's preview cookies (sw.ts serves it). */
let cookiePage: Promise<Document> | undefined;

const cookieBase = () => `${BASE}__preview/@${myId}`;
function cookieDocument(): Promise<Document> {
  return (cookiePage ??= new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    // Same origin as this page: its document is readable here, and it is the one at the cookies' path.
    frame.onload = () => (frame.contentDocument ? resolve(frame.contentDocument) : reject(new Error("the cookie page did not load")));
    frame.onerror = () => reject(new Error("the cookie page did not load"));
    frame.src = `${cookieBase()}/__runbun_cookies__`;
    document.body.append(frame);
  }));
}

const reply = (port: MessagePort, m: ToEditor, transfer: Transferable[] = []) => port.postMessage(envelope(m), transfer);

function connect(port: MessagePort) {
  // The service worker's asks (a page-owned module, a preview request, a preview WebSocket): the editor answers on the
  // reply port it is handed.
  navigator.serviceWorker.onmessage = (e) => reply(port, { kind: "sw", d: e.data }, [...e.ports]);
  // A message the editor sent could not be read here (shared memory across origins): the editor says so to its Runs.
  port.onmessageerror = () => reply(port, { kind: "merr" });
  port.onmessage = async (e) => {
    if (!isMessage<ToHost>(e.data, "host")) return;
    const m = e.data;
    if (m.kind === "spawn") {
      const g = m.g;
      // A repeated id (it shouldn't be) replaces the old Worker rather than leaking it.
      workers.get(g)?.terminate();
      const worker = new Worker(new URL("../worker/runtime.ts", import.meta.url), { type: "module" });
      workers.set(g, worker);
      worker.onmessage = (we) => reply(port, { kind: "w", g, d: we.data }, [...we.ports]);
      worker.onerror = (we) => reply(port, { kind: "werr", g, message: we.message });
    } else if (m.kind === "w") {
      // Ports ride in the transfer list (a request's reply port, a WebSocket); the message itself is cloned.
      workers.get(m.g)?.postMessage(m.d, [...e.ports]);
    } else if (m.kind === "kill") {
      workers.get(m.g)?.terminate();
      workers.delete(m.g);
    } else if (m.kind === "ping") {
      reply(port, { kind: "pong", n: m.n, workers: workers.size });
    } else if (m.kind === "cookies") {
      const out = e.ports[0];
      cookieQueue = cookieQueue.then(async () => {
        try {
          // Only the preview of this frame's own server: the cookies' path is its base.
          if (m.base !== cookieBase()) throw new Error("not this host's preview base");
          const doc = await cookieDocument();
          if (m.op === "write") for (const line of m.lines) doc.cookie = line;
          else out?.postMessage({ cookie: doc.cookie });
        } catch (err) {
          out?.postMessage({ error: String(err) });
        }
      });
    } else if (m.kind === "fetch") {
      // The editor can't fetch from this origin's service worker (it doesn't control the editor); this frame does.
      const out = e.ports[0];
      try {
        const res = await fetch(m.url, { method: m.method, headers: m.headers, body: m.body });
        const body = await res.arrayBuffer();
        out.postMessage({ status: res.status, statusText: res.statusText, headers: [...res.headers], body }, [body]);
      } catch (err) {
        out.postMessage({ error: String(err) });
      }
    }
  };
  // The editor went away (a reload, a navigation): its Workers go with this frame; stop them now rather than at teardown.
  addEventListener("pagehide", () => {
    for (const w of workers.values()) w.terminate();
    workers.clear();
  });
}

window.addEventListener("message", (e) => {
  // Only the editor that framed us, once.
  if (e.source !== window.parent || e.origin !== EDITOR || !isMessage<HandshakeMessage>(e.data, "host") || e.data.kind !== "connect" || !e.ports[0]) return;
  if (!started) return;
  started = false;
  connect(e.ports[0]);
});
if (!EDITOR) throw new Error(`host.html: ${asked || "no editor"} is not a configured editor origin`);
whoami().then(
  (id) => {
    myId = id;
    started = true;
    window.parent.postMessage(envelope<HandshakeMessage>({ kind: "host-ready", id }), EDITOR);
  },
  (err) => window.parent.postMessage(envelope<HandshakeMessage>({ kind: "host-error", message: String(err) }), EDITOR),
);
