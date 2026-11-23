// The content origin's page (host.html): the editor frames it hidden. It registers the service worker on this origin,
// starts the runtime Worker, and relays the Worker's messages and the service worker's asks (modules, previews,
// WebSockets) to the editor over a MessagePort, which answers them with the handlers it has always had. Nothing the
// editor holds (OPFS, IndexedDB, cookies) is on this origin. Protocol: contentProtocol.ts.
import { BASE } from "../base";
import { PreviewCookies } from "../previewCookies";
import { EDITOR_ORIGINS } from "../contentOrigin";
import { answerStore, serveLazyRead, type LazyRead } from "../pkgStore";
import { envelope, isMessage, type HandshakeMessage, type ToEditor, type ToHost } from "../contentProtocol";
import { SyncRelay } from "../worker/syncChannel";
import { CommandQueue, CTL_INTS, DEBUG_BUFFER_BYTES, type DebugCommand, type DebugStart } from "../debugProtocol";

// The editor names its origin (`?editor=`), but only a configured editor origin is answered: any site can frame this
// page, and the relay (a Worker, the service worker's asks, fetch) must serve only the playground.
const asked = new URLSearchParams(location.search).get("editor") ?? "";
const EDITOR = EDITOR_ORIGINS.has(asked) ? asked : "";
const workers = new Map<number, Worker>();
/** Each Worker's channel for a synchronous child it waits on (worker/syncChannel.ts). */
const relays = new WeakMap<Worker, SyncRelay>();
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
/** The browser's preview cookies, through blank pages under the preview's base (previewCookies.ts). */
let cookiePages: PreviewCookies | undefined;

const cookieBase = () => `${BASE}__preview/@${myId}`;

/**
 * Tells the preview pages on this origin that their server is gone, as the editor's channel does for its own origin
 * (runner.ts stop, previewWebSocket in swPage.ts): a BroadcastChannel doesn't cross to this origin from the editor's.
 */
const previewChannel = new BroadcastChannel("bun-preview");

/** Dev check (host frame only): the lazy reads the Worker asked and this frame answered. */
const lazyReads = { asked: 0, ok: 0, failed: 0, bytes: 0 };
if (import.meta.env.DEV) (globalThis as any).__runbunLazyReads = lazyReads;
async function answerLazyRead(m: LazyRead) {
  lazyReads.asked++;
  // The Worker runs project code, which can post anything: only a shared buffer big enough for what it asks is served.
  const { ref, sab } = m ?? ({} as LazyRead);
  if (!(sab instanceof SharedArrayBuffer) || sab.byteLength < 8) return void lazyReads.failed++;
  if (typeof ref?.lazy !== "string" || !/^[\w.@-]{1,300}$/.test(ref.lazy) || !Number.isSafeInteger(ref.at) || !Number.isSafeInteger(ref.size) || ref.at < 0 || ref.size < 0 || sab.byteLength < 8 + ref.size) {
    const state = new Int32Array(sab, 0, 1);
    Atomics.store(state, 0, 2);
    Atomics.notify(state, 0);
    return void lazyReads.failed++;
  }
  await serveLazyRead(undefined, m);
  if (Atomics.load(new Int32Array(sab, 0, 1), 0) === 1) (lazyReads.ok++, (lazyReads.bytes += ref.size));
  else lazyReads.failed++;
}

/** A debug run's command queue (debugSession.ts): its buffer is made here, in the Worker's agent cluster. */
const debugQueues = new Map<Worker, CommandQueue>();

/** A debug run's start gets the buffer; the editor's commands for it go into it. True if `d` was taken. */
function relayDebug(w: Worker, d: { type?: string; debug?: DebugStart; cmd?: DebugCommand }): boolean {
  if (d?.type === "start" && d.debug?.host) {
    const sab = new SharedArrayBuffer(CTL_INTS * 4 + DEBUG_BUFFER_BYTES);
    debugQueues.set(w, new CommandQueue(sab));
    d.debug = { sab, breakpoints: d.debug.breakpoints };
    return false;
  }
  if (d?.type !== "dbg-command" || !d.cmd) return false;
  debugQueues.get(w)?.push(d.cmd);
  return true;
}

const reply = (port: MessagePort, m: ToEditor, transfer: Transferable[] = []) => port.postMessage(envelope(m), transfer);

/**
 * A worker_threads thread's start, kept here while its spawn goes round through the editor (Runner.spawn): its
 * `thread` (`workerData`, often shared memory, such as a threaded wasm binding's) and its channel to the Worker, with
 * what it transfers. Shared memory can't reach the editor's origin, and a port that went through it no longer carries
 * any (it delivers `null`), so the editor gets `{ [KEPT]: id }` for both and a Worker's start gets them back.
 */
const KEPT = "__runbunKept";
const keptThreads = new Map<number, { owner: Worker; thread: unknown; port: MessagePort; transfer: MessagePort[] }>();
let keptIds = 0;

/** A Worker's spawn of a thread, for the editor: the thread's start kept here. */
function keepThread(owner: Worker, d: { type?: string; thread?: unknown; port?: unknown }, ports: readonly MessagePort[]): { d: unknown; ports: MessagePort[] } {
  if (d?.type !== "spawn" || !d.thread || !(d.port instanceof MessagePort)) return { d, ports: [...ports] };
  keptThreads.set(++keptIds, { owner, thread: d.thread, port: d.port, transfer: ports.filter((p) => p !== d.port) });
  return { d: { ...d, thread: { [KEPT]: keptIds }, port: { [KEPT]: keptIds } }, ports: [] };
}

/** The editor's start of a thread with what was kept for it put back, and the ports it transfers. */
function startThread(d: { type?: string; thread?: unknown; port?: unknown }): { d: unknown; ports: MessagePort[] } {
  const id = d?.type === "start" ? (d.thread as Record<string, unknown> | undefined)?.[KEPT] : undefined;
  const kept = typeof id === "number" ? keptThreads.get(id) : undefined;
  if (!kept) return { d, ports: [] };
  keptThreads.delete(id as number);
  return { d: { ...d, thread: kept.thread, port: kept.port }, ports: [kept.port, ...kept.transfer] };
}

/** A Worker ended: the threads it started that never did go too. */
function dropThreads(owner: Worker) {
  for (const [id, k] of keptThreads) if (k.owner === owner) keptThreads.delete(id), k.port.close();
}

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
      relays.set(worker, new SyncRelay());
      worker.onmessage = (we) => {
        // The Worker blocks on a lazy package file: answered here, in its own agent cluster (a shared buffer can't go to the editor).
        if (we.data?.type === "lazy-read") return void answerLazyRead(we.data);
        // Or on a synchronous child: what the editor sends it meanwhile goes through the relay's buffer, for the same reason.
        if (relays.get(worker)?.fromWorker(we.data)) return;
        const out = keepThread(worker, we.data, we.ports);
        reply(port, { kind: "w", g, d: out.d }, out.ports);
      };
      worker.onerror = (we) => reply(port, { kind: "werr", g, message: we.message });
    } else if (m.kind === "w") {
      // Ports ride in the transfer list (a request's reply port, a WebSocket); the message itself is cloned.
      const w = workers.get(m.g);
      const start = keptThreads.size ? startThread(m.d as Parameters<typeof startThread>[0]) : { d: m.d, ports: [] };
      if (w && !relayDebug(w, start.d as Parameters<typeof relayDebug>[1]) && !relays.get(w)?.toWorker(start.d)) w.postMessage(start.d, [...e.ports, ...start.ports]);
    } else if (m.kind === "kill") {
      const killed = workers.get(m.g);
      if (killed) debugQueues.delete(killed), dropThreads(killed);
      killed?.terminate();
      workers.delete(m.g);
    } else if (m.kind.startsWith("store-")) {
      const out = e.ports[0];
      const res = (await answerStore(m as Extract<ToHost, { kind: `store-${string}` }>)) as { buf?: ArrayBuffer };
      out?.postMessage(res, res.buf ? [res.buf] : []);
    } else if (m.kind === "stopped") {
      previewChannel.postMessage("stopped");
    } else if (m.kind === "reload") {
      previewChannel.postMessage({ reload: m.base });
    } else if (m.kind === "ping") {
      reply(port, { kind: "pong", n: m.n, workers: workers.size });
    } else if (m.kind === "cookies") {
      const out = e.ports[0];
      cookieQueue = cookieQueue.then(async () => {
        try {
          // Only the preview of this frame's own server: the cookies' path is its base.
          if (m.base !== cookieBase()) throw new Error("not this host's preview base");
          cookiePages ??= new PreviewCookies(cookieBase());
          if (m.op === "write") await cookiePages.write(m.lines);
          else out?.postMessage({ cookie: await cookiePages.read(m.dir), usable: await cookiePages.usable() });
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
    window.parent.postMessage(envelope<HandshakeMessage>({ kind: "host-ready", id, isolated: crossOriginIsolated === true && typeof SharedArrayBuffer === "function" }), EDITOR);
  },
  (err) => window.parent.postMessage(envelope<HandshakeMessage>({ kind: "host-error", message: String(err) }), EDITOR),
);
