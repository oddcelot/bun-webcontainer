// Page-side code of the service worker: sw.ts serializes these into every preview page (withPreviewScripts), so each
// may only use what it declares (no imports, no outer helpers, no compiler-injected helpers). Checked with the DOM lib
// by tsconfig.json; sw.ts sees it through swPage.sw.d.ts (tsconfig.sw.json), since it is checked against the worker lib.
// The playground's mode (theme.ts): system leaves the page to the OS preference; light or dark narrows a page
// that supports both schemes, or declares none, to that one. `prefers-color-scheme` still follows the OS:
// no page can set it for a frame.
declare global {
  interface Window {
    __bunColorScheme?: (mode: string) => void;
  }
}

export function previewColorScheme(): void {
  const meta = Object.assign(document.createElement("meta"), { name: "color-scheme" });
  const style = document.createElement("style");
  const apply = (mode?: string) => {
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
    style.sheet!.disabled = true;
    const css = getComputedStyle(document.documentElement).colorScheme;
    style.sheet!.disabled = false;
    const own = [...document.querySelectorAll('meta[name="color-scheme"]')].find((m) => m !== meta)?.getAttribute("content");
    const declared = css !== "normal" ? css : own;
    if (declared && !(declared.includes("light") && declared.includes("dark"))) {
      meta.remove();
      style.remove();
      channel.close();
      delete window.__bunColorScheme;
    }
  });
}

export function previewWebSocket(prefix: string): void {
  const Native = window.WebSocket;
  /** Connected sockets, each with what drops it. */
  const open = new Map<PreviewWebSocket, () => void>();
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
    binaryType: BinaryType = "blob";
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    declare url: string;
    #port!: MessagePort;
    #queue = Promise.resolve();
    constructor(url: string | URL, protocols?: string | string[]) {
      const u = new URL(url, location.href);
      // The page's own host is the preview server; another port on it, or on localhost, may be another Bun.serve in
      // the worker (devframe connects to `${location.hostname}:${port}`, which is runbun.dev:<port> when deployed).
      const local =
        u.host === location.host
          ? undefined
          : u.hostname === location.hostname || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
            ? Number(u.port || (u.protocol === "wss:" || u.protocol === "https:" ? 443 : 80))
            : null;
      if (local === null) return new Native(url, protocols) as never;
      super();
      u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
      this.url = u.href;
      const path = (u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) || "/" : u.pathname) + u.search;
      const { port1, port2 } = new MessageChannel();
      this.#port = port1;
      port1.onmessage = (e) => this.#receive(e.data);
      const headers = [["origin", location.origin]];
      if (protocols?.length) headers.push(["sec-websocket-protocol", ([] as string[]).concat(protocols).join(", ")]);
      const sw = navigator.serviceWorker;
      (sw.controller ? Promise.resolve(sw.controller) : sw.ready.then((r) => r.active)).then((c) => c!.postMessage({ type: "ws", path, headers, port: local }, [port2]));
    }
    #emit(event: Event) {
      this.dispatchEvent(event);
      (this as any)["on" + event.type]?.call(this, event);
    }
    #receive(m: any) {
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
    send(data: any) {
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
  window.WebSocket = PreviewWebSocket as never;
}
