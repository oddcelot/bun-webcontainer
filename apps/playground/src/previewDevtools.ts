// A prototype (probe/devtools-dock): Solid's devtools (@solidjs/start-devtools) in the playground's dock instead of
// over the previewed page. The package has no way to say where its toolbar goes, so the service worker rewrites its
// module as it serves it (devtoolsPatch.ts: one line, tied to 1.0.x's build output), and the preview page gets a script
// that answers with the dock's frame (previewDevtools). The toolbar still runs in the page, where the app's signals
// are; only its DOM is in the frame. Same origin only: with a content origin the frame would have to be served there.

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
  /** The dock's frame (ui/Devtools.tsx), a sibling of this one; undefined without it or on another origin. */
  const frame = (): Document | undefined => {
    try {
      return (window.parent as unknown as { frames: Record<string, Window | undefined> }).frames["runbun-devtools"]?.document;
    } catch {
      return undefined;
    }
  };
  let taken: Document | undefined;
  (globalThis as { __runbunDevtoolsMount?: () => HTMLElement | undefined }).__runbunDevtoolsMount = () => {
    const doc = frame();
    if (!doc) return undefined;
    if (taken !== doc) {
      taken = doc;
      // What the page before this one (a reload) left there.
      doc.head.replaceChildren();
      doc.body.replaceChildren();
      const fill = doc.createElement("style");
      fill.textContent = FILL;
      // The toolbar's styles are <style> elements in this page's head, more of them as its panels load.
      const copied = new WeakSet<Element>();
      const copy = () => {
        for (const style of document.head.querySelectorAll("style"))
          if (!copied.has(style)) {
            copied.add(style);
            doc.head.insertBefore(style.cloneNode(true), fill);
          }
      };
      doc.head.append(fill);
      // The open toolbar makes room for itself under the page; it isn't there.
      const room = document.createElement("style");
      room.textContent = "html { padding-bottom: 0 !important; }";
      copied.add(room);
      document.head.append(room);
      new MutationObserver(copy).observe(document.head, { childList: true });
      copy();
    }
    return doc.body;
  };
  // The toolbar reads whether it was open when it starts.
  try {
    if (frame()) localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(KEY) ?? "{}"), open: true }));
  } catch {}
}
