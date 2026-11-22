// A prototype (probe/devtools-dock): Solid's devtools (@solidjs/start-devtools) in the playground's dock instead of
// over the previewed page. The package has no way to say where its toolbar goes, so the service worker rewrites its
// module as it serves it (devtoolsPatch.ts: one line, tied to 1.0.x's build output), and the preview page gets a script
// that answers with a host element in the dock's frame (previewDevtools). The toolbar still runs in the page, where the
// app's signals are; only its DOM is in the frame. Same origin only: with a content origin the frame would have to be
// served there.
//
// Each preview page has its own host in the frame, tagged with the page's document; the playground shows the host of
// the active preview tab and drops those whose page is gone (ui/Devtools.tsx). Bead bwc-5sku: the upstream option that
// would replace all of this.

/** What the page leaves on its host and its copied styles for the playground (ui/Devtools.tsx reads the same names). */
export type DevtoolsHost = HTMLElement & {
  /** The page whose toolbar this is. */
  __runbunDocument?: Document;
  /** Hands a key pressed in the dock's frame to the page's window, where the toolbar listens; true if one handled it. */
  __runbunKey?: (e: KeyboardEvent) => boolean;
};

/** Runs in a preview page, from its first script (sw.ts previewScripts, by way of swPage.ts): no imports, nothing from outside its body. */
export function previewDevtools() {
  if (window.parent === window) return;
  const KEY = "solid-start-devtools:dock";
  // Fills the frame, always open: the dock has the tab, the border to drag and the button that hides it.
  const FILL =
    "html, body { height: 100%; margin: 0; background: oklch(0.16 0.015 265); }" +
    "[data-solid-dev-toolbar] { position: fixed !important; inset: 0 !important; }" +
    "[data-solid-dev-toolbar-dock], [data-solid-dev-toolbar-dock][hidden] { display: flex !important; height: 100% !important; max-height: none !important; border-top: 0 !important; box-shadow: none !important; }" +
    "[data-solid-dev-toolbar-handle], [data-solid-dev-toolbar-resize] { display: none !important; }" +
    // Its close button, the one icon button without a name: the dock hides the pane.
    "[data-solid-dev-toolbar-dock] [data-solid-icon-button]:not([title]):not([aria-label]) { display: none !important; }";
  type Tagged = Element & { __runbunDocument?: Document };
  // The events @solidjs/web delegates (its DelegatedEvents).
  const DELEGATED = ["beforeinput", "click", "dblclick", "contextmenu", "focusin", "focusout", "input", "keydown", "keyup", "mousedown", "mousemove", "mouseout", "mouseover", "mouseup", "pointerdown", "pointermove", "pointerout", "pointerover", "pointerup", "touchend", "touchmove", "touchstart"];
  /** The dock's frame (ui/Devtools.tsx), a sibling of this one; undefined without it or on another origin. */
  const frame = (): Document | undefined => {
    try {
      return (window.parent as unknown as { frames: Record<string, Window | undefined> }).frames["runbun-devtools"]?.document;
    } catch {
      return undefined;
    }
  };
  let host: DevtoolsHost | undefined;
  // This page's styles, copied into the frame.
  const copies: Element[] = [];
  const copied = new WeakSet<Element>();
  let watching = false;
  const leave = () => {
    host?.remove();
    for (const c of copies) c.remove();
    host = undefined;
    copies.length = 0;
  };
  // A reload or a link: the next page brings its own host.
  addEventListener("pagehide", leave);
  // The toolbar's styles are <style> elements in this page's head, more of them as its panels load.
  const copy = () => {
    const doc = host?.ownerDocument;
    const fill = doc?.getElementById("runbun-devtools-fill");
    if (!doc || !fill) return;
    for (const style of document.head.querySelectorAll("style"))
      if (!copied.has(style)) {
        copied.add(style);
        const c = style.cloneNode(true) as Tagged;
        c.__runbunDocument = document;
        copies.push(c);
        doc.head.insertBefore(c, fill);
      }
  };
  // Alt+Shift+D opens and closes the toolbar; in the dock it is always open, and the key is the playground's: it brings
  // the Devtools tab forward (keymap.ts showDevtools). Caught before the toolbar's own listener, and passed up.
  addEventListener(
    "keydown",
    (e) => {
      if (!host || !e.altKey || !e.shiftKey || e.code !== "KeyD") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const up = window.parent as typeof window;
      up.dispatchEvent(new up.KeyboardEvent("keydown", e));
    },
    true,
  );
  (globalThis as { __runbunDevtoolsMount?: () => HTMLElement | undefined }).__runbunDevtoolsMount = () => {
    const doc = frame();
    if (!doc) return undefined;
    if (host?.ownerDocument === doc) return host;
    leave();
    if (!doc.getElementById("runbun-devtools-fill")) {
      const fill = doc.createElement("style");
      fill.id = "runbun-devtools-fill";
      fill.textContent = FILL;
      doc.head.append(fill);
    }
    host = doc.createElement("div") as DevtoolsHost;
    host.className = "runbun-devtools-host";
    // The playground shows the active preview tab's.
    host.hidden = true;
    host.__runbunDocument = document;
    host.__runbunKey = (e) => {
      const c = new KeyboardEvent("keydown", e);
      // ui/Preview.tsx forwardKeys leaves it be: the dock passes on what the page doesn't take.
      (c as KeyboardEvent & { __runbunFromDock?: boolean }).__runbunFromDock = true;
      dispatchEvent(c);
      return c.defaultPrevented;
    };
    doc.body.append(host);
    // Solid hands events to the toolbar's handlers (`_$$click` on a node) from listeners on the root it rendered into,
    // and a portal's mount joins in when it finds that root above the portal. A page that hydrates (solid-ssr-dashboard)
    // doesn't find it, so in the frame nothing answers a click. Here, once the event has passed the host: a handler Solid
    // ran defines the event's currentTarget; without one, run them as Solid would, from the target up to the host.
    const mine = host;
    for (const type of DELEGATED)
      doc.addEventListener(type, (e) => {
        if (!mine.isConnected || !mine.contains(e.target as Node) || Object.getOwnPropertyDescriptor(e, "currentTarget")) return;
        const key = `_$$${type}`;
        type Handled = Node & Record<string, unknown>;
        for (let node = e.target as Handled | null; node && (node as Node) !== mine; node = node.parentNode as unknown as Handled | null) {
          const handler = node[key] as ((this: Node, ...a: unknown[]) => void) | { handleEvent(e: Event): void } | undefined;
          if (!handler || (node as unknown as { disabled?: boolean }).disabled) continue;
          Object.defineProperty(e, "currentTarget", { configurable: true, value: node });
          const data = node[`${key}Data`];
          if (data !== undefined) (handler as (this: Node, ...a: unknown[]) => void).call(node, data, e);
          else if (typeof handler === "function") handler.call(node, e);
          else handler.handleEvent(e);
          if (e.cancelBubble) break;
        }
      });
    if (!watching) {
      watching = true;
      // The open toolbar makes room for itself under the page; it isn't there.
      const room = document.createElement("style");
      room.textContent = "html { padding-bottom: 0 !important; }";
      copied.add(room);
      document.head.append(room);
      new MutationObserver(copy).observe(document.head, { childList: true });
    }
    copy();
    return host;
  };
  // The toolbar reads whether it was open when it starts.
  try {
    if (frame()) localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(KEY) ?? "{}"), open: true }));
  } catch {}
}
