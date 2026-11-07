import { BASE } from "./base";
import { CONTENT_ORIGIN } from "./contentOrigin";

// The editor's end of the content origin (host.html, src/host/main.ts): one hidden iframe per tab, a MessagePort to it,
// and a Worker-like proxy for the runtime Worker that lives there. Messages over the port:
//   editor -> host  spawn {g} | w {g, d} (+ ports) | kill {g} | fetch {url, method, headers, body} (+ reply port)
//   host -> editor  w {g, d} (+ ports) | werr {g, message} | sw {d} (+ the service worker's reply port)

export interface Host {
  /** The host frame's client id on the content origin: the `@<id>` of module and preview URLs. */
  id: string;
  port: MessagePort;
}

let host: Promise<Host> | undefined;
let nextGen = 0;
const workers = new Map<number, HostWorker>();
/** Answers the content service worker's asks (module, preview, ws), as Runner.onSw does for the editor's own. */
let onAsk: ((e: { data: any; ports: readonly MessagePort[] }) => void) | undefined;
export const answerAsks = (fn: typeof onAsk) => void (onAsk = fn);

/** The host frame, started on first use. */
export function connectHost(): Promise<Host> {
  return (host ??= new Promise<Host>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.title = "runtime host";
    frame.setAttribute("aria-hidden", "true");
    // The embedded document is cross-origin isolated too (SharedArrayBuffer for its Worker) only if we allow it.
    frame.allow = "cross-origin-isolated";
    const timer = setTimeout(() => reject(new Error("the content origin did not answer")), 20_000);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== CONTENT_ORIGIN || e.data?.v !== 1) return;
      if (e.data.kind === "host-error") return void reject(new Error(e.data.message));
      if (e.data.kind !== "host-ready") return;
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (m) => {
        const d = m.data;
        if (d.t === "sw") onAsk?.({ data: d.d, ports: m.ports });
        else if (d.t === "w") workers.get(d.g)?.deliver(d.d, m.ports);
        else if (d.t === "werr") workers.get(d.g)?.fail(d.message);
      };
      frame.contentWindow!.postMessage({ v: 1, kind: "connect" }, CONTENT_ORIGIN!, [port2]);
      resolve({ id: e.data.id, port: port1 });
    };
    addEventListener("message", onMessage);
    frame.src = `${CONTENT_ORIGIN}${BASE}host.html?editor=${encodeURIComponent(location.origin)}`;
    document.body.append(frame);
  }));
}

/** The part of `Worker` that Runner uses, over the host's port. */
class HostWorker extends EventTarget {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  readonly #g = nextGen++;
  constructor(private port: MessagePort) {
    super();
    workers.set(this.#g, this);
    port.postMessage({ t: "spawn", g: this.#g });
  }
  postMessage(message: unknown, transfer: Transferable[] = []) {
    this.port.postMessage({ t: "w", g: this.#g, d: message }, transfer);
  }
  terminate() {
    workers.delete(this.#g);
    this.port.postMessage({ t: "kill", g: this.#g });
  }
  deliver(data: unknown, ports: readonly MessagePort[]) {
    const e = new MessageEvent("message", { data, ports: [...ports] });
    this.dispatchEvent(e);
    this.onmessage?.(e);
  }
  fail(message: string) {
    this.onerror?.({ message });
  }
}

/** A runtime Worker on the content origin, as `new Worker(...)` would be here. */
export function spawnWorker(h: Host): Worker {
  return new HostWorker(h.port) as unknown as Worker;
}

/** `fetch` of a path on the content origin, made by the host frame (its service worker doesn't control the editor). */
export async function fetchContent(path: string, init: RequestInit): Promise<Response> {
  const { port } = await connectHost();
  const req = new Request(new URL(path, CONTENT_ORIGIN), init);
  const body = req.body ? await req.arrayBuffer() : null;
  const { port1, port2 } = new MessageChannel();
  const answer = new Promise<any>((r) => (port1.onmessage = (e) => r(e.data)));
  port.postMessage({ t: "fetch", url: req.url, method: req.method, headers: [...req.headers], body }, [port2, ...(body ? [body] : [])]);
  const res = await answer;
  port1.close();
  if (res.error) throw new TypeError(res.error);
  return new Response([101, 204, 205, 304].includes(res.status) ? null : res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
