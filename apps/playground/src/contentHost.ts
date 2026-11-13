import { BASE } from "./base";
import { CONTENT_ORIGIN } from "./contentOrigin";
import { envelope, isMessage, type HandshakeMessage, type ToEditor, type ToHost } from "./contentProtocol";

// The editor's end of the content origin (host.html, src/host/main.ts): one hidden iframe per tab, a MessagePort to it,
// and a Worker-like proxy for the runtime Worker that lives there. The messages are in contentProtocol.ts.
//
// The frame's life: created by the first `connectHost()`; it is dropped (and the next call makes a new one) when it
// doesn't answer, reports an error, reloads, or stops answering the heartbeat. Workers it ran then fail with an error,
// so a Run that was waiting on one ends and the next Run starts clean. Closing the tab needs nothing: the frame is a
// child of this document.

export interface Host {
  /** The host frame's client id on the content origin: the `@<id>` of module and preview URLs. */
  id: string;
  port: MessagePort;
}

/** How long the frame gets to load, register its service worker and say it is ready. */
const HANDSHAKE_TIMEOUT = 20_000;
/** A ping each interval; the host is gone after this many without an answer. */
const PING_INTERVAL = 3_000;
const PING_MISSES = 3;

/** How long a request to the host frame (fetch) may take: the service worker answers within 30s, so this is for a host that went quiet. */
const ASK_TIMEOUT = 45_000;
/** What fails each request still waiting for the host frame, with why: the frame was lost. */
const asking = new Set<(reason: string) => void>();

let host: Promise<Host> | undefined;
let nextGen = 0;
const workers = new Map<number, HostWorker>();
/** Answers the content service worker's asks (module, preview, ws), as Runner.onSw does for the editor's own. */
let onAsk: ((e: { data: any; ports: readonly MessagePort[] }) => void) | undefined;
export const answerAsks = (fn: typeof onAsk) => void (onAsk = fn);
/** Told of each host frame that becomes ready (the first, and any after a loss): module and preview URLs name its id. */
const hostListeners = new Set<(h: Host) => void>();
export const onHost = (fn: (h: Host) => void) => void hostListeners.add(fn);
/** Told when the host frame is lost, with why. */
let onLost: ((reason: string) => void) | undefined;
export const whenLost = (fn: typeof onLost) => void (onLost = fn);

/** Whether the current host frame is cross-origin isolated (its handshake); false until one is ready. */
let hostIsolated = false;
export const isHostIsolated = () => hostIsolated;

/** What the host last reported (its Worker count), for the dev check that Stop and Run leave none behind. */
let lastWorkers = 0;
if (import.meta.env.DEV) (globalThis as any).__runbunHost = { workers: () => lastWorkers, editorWorkers: () => workers.size };

const send = (port: MessagePort, m: ToHost, transfer: Transferable[] = []) => port.postMessage(envelope(m), transfer);

/** The host frame, started on first use (and again after it was lost). */
export function connectHost(): Promise<Host> {
  const attempt = (host ??= startHost());
  // A failed attempt is forgotten, so the next Run tries again.
  attempt.catch(() => {
    if (host === attempt) host = undefined;
  });
  return attempt;
}

function startHost(): Promise<Host> {
  return new Promise<Host>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.title = "runtime host";
    frame.setAttribute("aria-hidden", "true");
    // The embedded document is cross-origin isolated too (SharedArrayBuffer for its Worker) only if we allow it.
    frame.allow = "cross-origin-isolated";
    let settled = false;
    let port: MessagePort | undefined;
    let pings: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(pings);
      removeEventListener("message", onMessage);
    };
    /** Gives the frame up: it never became ready (reject), or it did and is gone (fail its Workers). */
    const lose = (reason: string) => {
      const was = settled;
      cleanup();
      port?.close();
      frame.remove();
      if (!was) {
        settled = true;
        reject(new Error(reason));
        return;
      }
      host = undefined;
      for (const fail of [...asking]) fail(reason);
      for (const w of [...workers.values()]) w.lost(reason);
      onLost?.(reason);
    };
    const timer = setTimeout(() => lose(`the content origin ${CONTENT_ORIGIN} did not answer within ${HANDSHAKE_TIMEOUT / 1000}s (is it reachable, and does it allow this page to frame it?)`), HANDSHAKE_TIMEOUT);

    let loads = 0;
    frame.addEventListener("load", () => {
      // The first load is the page we asked for; another one means the frame reloaded or navigated: it lost its Workers.
      if (++loads > 1) lose("the content host frame reloaded");
    });

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== CONTENT_ORIGIN || !isMessage<HandshakeMessage>(e.data, "editor")) return;
      if (e.data.kind === "host-error") return lose(`the content host failed to start: ${e.data.message}`);
      if (e.data.kind !== "host-ready" || port) return;
      clearTimeout(timer);
      const { port1, port2 } = new MessageChannel();
      port = port1;
      let seen = true;
      let missed = 0;
      let n = 0;
      port1.onmessage = (m: MessageEvent) => {
        if (!isMessage<ToEditor>(m.data, "editor")) return;
        const d = m.data;
        if (d.kind === "sw") onAsk?.({ data: d.d, ports: m.ports });
        else if (d.kind === "w") workers.get(d.g)?.deliver(d.d, m.ports);
        else if (d.kind === "werr") workers.get(d.g)?.fail(d.message);
        else if (d.kind === "pong") {
          seen = true;
          lastWorkers = d.workers;
        } else if (d.kind === "merr") {
          for (const w of workers.values()) w.fail("couldn't send a message to the runtime: shared memory can't cross origins");
        }
      };
      port1.onmessageerror = () => {
        for (const w of workers.values()) w.fail("a message from the runtime could not be read");
      };
      pings = setInterval(() => {
        if (seen) (seen = false), (missed = 0);
        else if (++missed >= PING_MISSES) return lose("the content host stopped answering");
        send(port1, { kind: "ping", n: ++n });
      }, PING_INTERVAL);
      frame.contentWindow!.postMessage(envelope<HandshakeMessage>({ kind: "connect" }), CONTENT_ORIGIN!, [port2]);
      settled = true;
      hostIsolated = (e.data as { isolated?: boolean }).isolated === true;
      const h = { id: (e.data as { id: string }).id, port: port1 };
      resolve(h);
      for (const fn of hostListeners) fn(h);
    };
    addEventListener("message", onMessage);
    frame.src = `${CONTENT_ORIGIN}${BASE}host.html?editor=${encodeURIComponent(location.origin)}`;
    document.body.append(frame);
  });
}

/** The part of `Worker` that Runner uses, over the host's port. */
class HostWorker extends EventTarget {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  readonly #g = nextGen++;
  #dead = false;
  constructor(private port: MessagePort) {
    super();
    workers.set(this.#g, this);
    send(port, { kind: "spawn", g: this.#g });
  }
  postMessage(message: unknown, transfer: Transferable[] = []) {
    if (this.#dead) {
      // A Stop's flush gets its answer at once instead of after its timeout.
      if ((message as { type?: string } | null)?.type === "flush") queueMicrotask(() => this.deliver({ type: "flushed" }, []));
      return;
    }
    send(this.port, { kind: "w", g: this.#g, d: message }, transfer);
  }
  terminate() {
    if (!workers.delete(this.#g) || this.#dead) return;
    send(this.port, { kind: "kill", g: this.#g });
  }
  deliver(data: unknown, ports: readonly MessagePort[]) {
    const e = new MessageEvent("message", { data, ports: [...ports] });
    this.dispatchEvent(e);
    this.onmessage?.(e);
  }
  fail(message: string) {
    this.onerror?.({ message });
  }
  /** The host is gone: the Worker with it. A Stop waiting for its flush gets an answer, a Run waiting for it an error. */
  lost(reason: string) {
    if (this.#dead) return;
    this.#dead = true;
    workers.delete(this.#g);
    this.deliver({ type: "flushed" }, []);
    this.fail(reason);
  }
}

/** A runtime Worker on the content origin, as `new Worker(...)` would be here. */
export function spawnWorker(h: Host): Worker {
  return new HostWorker(h.port) as unknown as Worker;
}

/**
 * A request to the host frame that it answers on a reply port. Rejects when the host doesn't answer in `timeout` ms,
 * or is lost meanwhile (the heartbeat above), instead of waiting for ever.
 */
function ask<T>(port: MessagePort, m: ToHost, transfer: Transferable[], timeout = ASK_TIMEOUT): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    const done = () => {
      clearTimeout(timer);
      asking.delete(fail);
      port1.close();
    };
    const fail = (reason: string) => {
      done();
      reject(new Error(`the runtime host didn't answer: ${reason}`));
    };
    const timer = setTimeout(() => fail(`no reply within ${timeout / 1000}s`), timeout);
    asking.add(fail);
    port1.onmessage = (e) => {
      done();
      resolve(e.data);
    };
    port1.onmessageerror = () => fail("the reply was unreadable");
    send(port, m, [port2, ...transfer]);
  });
}

/** A request to the host frame, once it is up, answered on a reply port. */
export async function askHost<T>(m: ToHost, transfer: Transferable[] = [], timeout?: number): Promise<T> {
  const { port } = await connectHost();
  return ask<T>(port, m, transfer, timeout);
}

/** `fetch` of a path on the content origin, made by the host frame (its service worker doesn't control the editor). */
export async function fetchContent(path: string, init: RequestInit): Promise<Response> {
  const { port } = await connectHost();
  const req = new Request(new URL(path, CONTENT_ORIGIN), init);
  const body = req.body ? await req.arrayBuffer() : null;
  const res = await ask<any>(port, { kind: "fetch", url: req.url, method: req.method, headers: [...req.headers], body }, body ? [body] : []);
  if (res.error) throw new TypeError(res.error);
  return new Response([101, 204, 205, 304].includes(res.status) ? null : res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** The preview's cookies in the browser (`a=1; b=2`), read from the content origin through the host frame. */
export async function readContentCookies(base: string): Promise<string> {
  const { port } = await connectHost();
  const res = await ask<{ cookie?: string; error?: string }>(port, { kind: "cookies", op: "read", base }, [], 10_000);
  if (res.error) throw new Error(res.error);
  return res.cookie ?? "";
}

/** `document.cookie` assignments for the preview's cookies, made on the content origin; in order with the reads after them. */
export async function writeContentCookies(base: string, lines: string[]): Promise<void> {
  const { port } = await connectHost();
  send(port, { kind: "cookies", op: "write", base, lines });
}

/** Tells the preview pages on the content origin that the server stopped (their WebSockets drop), if a host frame is up. */
export function notifyStopped(): void {
  void host?.then(({ port }) => send(port, { kind: "stopped" }), () => {});
}
