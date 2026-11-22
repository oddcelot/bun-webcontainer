import { Show, createEffect, createSignal, onSettled, useContext } from "solid-js";
import { CONTENT_ORIGIN } from "../contentOrigin";
import type { DevtoolsHost } from "../previewDevtools";
import { AppContext, type App } from "./context";
import type { DockTab } from "./dockTab";
import { forwardKeys } from "./Preview";

// Alt+Shift+D (keymap.ts showDevtools): each press brings the tab forward.
const [asked, setAsked] = createSignal(0);

/** Brings the Devtools tab forward; false where the project has none, to leave the key alone. */
export function showDevtools(app: App): boolean {
  if (!offered(app)) return false;
  setAsked((n) => n + 1);
  return true;
}

/** A prototype: offered for a project that depends on @solidjs/start-devtools, where the preview is on this origin. */
export function devtoolsOffered(app: App): boolean {
  return offered(app);
}
// Bumped when a project's package.json may have changed (a write, or another project loaded): `offered` reads the file,
// which isn't reactive, so the dock asks again on these.
const [pkgVersion, setPkgVersion] = createSignal(0, { ownedWrite: true });
const watched = new WeakSet<App["vfs"]>();
function watchPackageJson(vfs: App["vfs"]) {
  if (watched.has(vfs)) return;
  watched.add(vfs);
  vfs.onChange(({ path }) => path === "package.json" && setPkgVersion((n) => n + 1));
  vfs.onClear(() => setPkgVersion((n) => n + 1));
}

function offered(app: App): boolean {
  if (CONTENT_ORIGIN || !app.session.ready()) return false;
  watchPackageJson(app.vfs);
  pkgVersion();
  try {
    return app.vfs.readText("package.json")?.includes('"@solidjs/start-devtools"') ?? false;
  } catch {
    return false;
  }
}

/**
 * The frame Solid's devtools render into from the preview pages (previewDevtools.ts finds it by its name), one host
 * per page. Shows the active preview tab's, drops those whose page is gone, and hands keys pressed in it to that page's
 * toolbar, then to the playground's shortcuts.
 */
function DevtoolsBody() {
  const app = useContext(AppContext);
  const [shown, setShown] = createSignal(false);
  let frame!: HTMLIFrameElement;
  let active = app.previews.state.active;
  const hosts = () => [...(frame.contentDocument?.querySelectorAll<DevtoolsHost>(".runbun-devtools-host") ?? [])];
  const sync = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const docOf = (f: HTMLIFrameElement | undefined) => {
      try {
        return f?.contentDocument ?? undefined;
      } catch {
        return undefined;
      }
    };
    const live = new Set([...app.previews.frames.values()].map(docOf));
    const current = docOf(app.previews.frames.get(active));
    let any = false;
    for (const host of hosts()) {
      // A page that went without saying (a frame removed with its tab).
      if (!host.__runbunDocument || !live.has(host.__runbunDocument)) {
        host.remove();
        continue;
      }
      host.hidden = host.__runbunDocument !== current;
      any ||= !host.hidden;
    }
    for (const style of doc.head.querySelectorAll("style") as NodeListOf<HTMLStyleElement & { __runbunDocument?: Document }>)
      if (style.__runbunDocument && !live.has(style.__runbunDocument)) style.remove();
    setShown(any);
  };
  onSettled(() => {
    const win = frame.contentWindow!;
    const onKey = (e: KeyboardEvent) => {
      const host = hosts().find((h) => !h.hidden);
      // The toolbar's Alt+Shift keys are for the page, not for a filter box in it.
      const typing = !!(e.target as Element | null)?.closest?.("input, textarea, [contenteditable]");
      if (host?.__runbunKey && !(typing && e.altKey && e.shiftKey) && host.__runbunKey(e)) e.preventDefault();
      else forwardKeys(e);
    };
    win.addEventListener("keydown", onKey);
    const observer = new MutationObserver(sync);
    observer.observe(frame.contentDocument!.body, { childList: true });
    sync();
    return () => {
      win.removeEventListener("keydown", onKey);
      observer.disconnect();
    };
  });
  createEffect(
    () => app.previews.state.active,
    (id) => {
      active = id;
      sync();
    },
  );
  return (
    <div class="devtools">
      {/* No src: the frame keeps the document it starts with, the one the pages put their hosts in. */}
      <iframe ref={frame} id="devtools-frame" name="runbun-devtools" title="Solid devtools" />
      <Show when={!shown()}>
        <p class="devtools-empty">Solid's devtools show up here once the page in the preview tab loads them.</p>
      </Show>
    </div>
  );
}

export const devtoolsTab: DockTab = {
  id: "devtools",
  title: "Devtools",
  tip: "Solid's devtools, for the page in the active preview tab",
  icon: "i-lucide-activity",
  when: offered,
  attention: () => asked() || undefined,
  Body: DevtoolsBody,
};
