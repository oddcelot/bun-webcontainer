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

/**
 * The preview bridge (content origin only; sw.ts injects it when it knows the editor's origin): the editor can't reach
 * into this document, so the document tells it what it needs (its path and title, a card for JSON or text, key presses
 * and links the editor handles) and takes its theme and navigations. Messages go to `parent` at `editor` only and are
 * taken from there only. `v` is the protocol version (contentProtocol.ts, which has the message shapes).
 */
export function previewBridge(base: string, editor: string, v: number): void {
  if (parent === window) return; // a preview opened in its own tab has no editor
  const post = (m: Record<string, unknown>) => parent.postMessage({ v, ...m }, editor);
  let owned: { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }[] = [];
  // As keymap.ts keyOf: by physical key for letters, digits and the space bar.
  const keyOf = (e: KeyboardEvent) => (e.code === "Space" ? "space" : (/^(?:Key|Digit)(.)$/.exec(e.code)?.[1] ?? e.key)).toLowerCase();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  addEventListener("keydown", (e) => {
    // Typing stays in the page; chords and named keys (Escape, F12) go to the editor's shortcuts.
    if (!(e.ctrlKey || e.metaKey || e.altKey || e.key.length > 1)) return;
    const k = keyOf(e);
    // A shortcut the editor handles doesn't also reach the page (its default, e.g. Cmd+S saving the page, is cancelled).
    if (owned.some((c) => c.key === k && c.ctrl === e.ctrlKey && c.alt === e.altKey && c.shift === e.shiftKey && c.meta === e.metaKey)) e.preventDefault();
    post({ kind: "key", key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, repeat: e.repeat });
  });

  // A link opened "in a new tab" (Cmd/Ctrl-click, middle click, target=_blank) opens a preview tab: a browser tab has no
  // server. In the background for a modified click, as browsers do; with Shift, or for a plain target=_blank, switched to.
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    const modified = e.button === 0 && (mac ? e.metaKey : e.ctrlKey);
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || typeof a.href !== "string" || a.hasAttribute("download")) return;
    const blank = e.button === 0 && a.target === "_blank";
    if (!(modified || e.button === 1 || blank)) return;
    const url = new URL(a.href);
    if (url.origin !== location.origin) return;
    const path = url.pathname === base ? "/" : url.pathname.startsWith(base + "/") ? url.pathname.slice(base.length) : url.pathname;
    e.preventDefault();
    post({ kind: "open-tab", path: path + url.search, foreground: e.shiftKey || (blank && !modified) });
  };
  addEventListener("click", onClick);
  addEventListener("auxclick", onClick);

  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== parent || e.origin !== editor || typeof m !== "object" || m === null || m.v !== v) return;
    if (m.kind === "init") {
      if (Array.isArray(m.shortcuts)) owned = m.shortcuts;
      window.__bunColorScheme?.(m.mode);
    } else if (m.kind === "color-scheme") window.__bunColorScheme?.(m.mode);
    else if (m.kind === "navigate" && typeof m.path === "string" && m.path.startsWith("/") && !m.path.startsWith("//")) location.replace(base + m.path);
  });

  // The page leaving: the editor must not message it any more (it sets src instead).
  addEventListener("pagehide", () => post({ kind: "bye" }));
  addEventListener("load", () => {
    // JSON and plain text come wrapped by the service worker (a card's document), which says what they were.
    const meta = (n: string) => document.querySelector(`meta[name="runbun-${n}"]`)?.getAttribute("content") ?? undefined;
    const wrapped = meta("type");
    const contentType = wrapped ?? document.contentType;
    const nav = performance.getEntriesByType("navigation")[0] as { responseStatus?: number } | undefined;
    const status = wrapped !== undefined ? Number(meta("status")) || 0 : nav?.responseStatus || 0;
    const card = /[/+]json\b|^text\/plain\b/.test(contentType) && wrapped !== undefined;
    const rel = location.pathname === base ? "/" : location.pathname.startsWith(base + "/") ? location.pathname.slice(base.length) : undefined;
    if (rel === undefined) return;
    post({
      kind: "loaded",
      path: rel + location.search,
      title: card ? "" : document.title.slice(0, 1024),
      contentType: contentType.slice(0, 200),
      status,
      text: card ? (document.querySelector("body > pre") ?? document.body).textContent!.slice(0, 2000000) : undefined,
    });
  });
  post({ kind: "hello" });
}
