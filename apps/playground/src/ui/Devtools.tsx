import { For, Show, createEffect, createSignal, onSettled, useContext } from "solid-js";
import { CONTENT_ORIGIN } from "../contentOrigin";
import type { DevtoolsHost } from "../previewDevtools";
import { AppContext, type App } from "./context";
import type { DockTab } from "./dockTab";
import { forwardKeys } from "./Preview";
import { previewUrl } from "../preview";

// Alt+Shift+D (keymap.ts showDevtools): each press brings the tab forward.
const [asked, setAsked] = createSignal(0);

/** Brings the Devtools tab forward; false where the project has none, to leave the key alone. */
export function showDevtools(app: App): boolean {
  if (!offered(app)) return false;
  setAsked((n) => n + 1);
  return true;
}

/** Which devtools a project has: Solid's (@solidjs/start-devtools), Vue's (vite-plugin-vue-devtools), Nuxt's (nuxt). */
type Kind = "solid" | "vue" | "nuxt";

/** A prototype: offered for a project with Solid's or Vue's devtools, where the preview is on this origin. */
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

function kindOf(app: App): Kind | null {
  if (CONTENT_ORIGIN || !app.session.ready()) return null;
  watchPackageJson(app.vfs);
  pkgVersion();
  try {
    const pkg = app.vfs.readText("package.json") ?? "";
    return pkg.includes('"@solidjs/start-devtools"') ? "solid" : pkg.includes('"vite-plugin-vue-devtools"') ? "vue" : pkg.includes('"nuxt"') ? "nuxt" : null;
  } catch {
    return null;
  }
}
const offered = (app: App) => kindOf(app) !== null;

/**
 * The frame Solid's devtools render into from the preview pages (previewDevtools.ts finds it by its name), one host
 * per page. Shows the active preview tab's, drops those whose page is gone, and hands keys pressed in it to that page's
 * toolbar, then to the playground's shortcuts.
 */
function SolidDevtools() {
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

// vite-plugin-vue-devtools's client (`<preview>/__devtools__/`) talks to the app over postMessage when it's in a frame
// (it expects the app's own overlay as its parent) and over a BroadcastChannel when it's a window of its own: the app
// listens on both. In the dock it is in a frame whose parent is the playground, so the playground passes its messages
// on to the channel and back, renaming the key that tells the two transports apart (@vue/devtools-kit's messaging).
const VUE_FRAME_KEY = "__devtools-kit-iframe-messaging-event-key__";
const VUE_CHANNEL_KEY = "__devtools-kit-broadcast-messaging-event-key__";
const VUE_CHANNEL = "__devtools-kit:broadcast-channel__";

/**
 * Vue's devtools for the page in the active preview tab: their client from the Vite server, in a frame, wired to the app
 * through the playground (above). Loaded afresh when the active preview tab or the program changes.
 */
function VueDevtools() {
  const app = useContext(AppContext);
  let frame!: HTMLIFrameElement;
  // The URL to load: once the program serves something, the client for the active preview tab's server.
  const src = () => (app.session.ports().length ? `${previewUrl("/__devtools__/")}?tab=${app.previews.state.active}` : undefined);
  onSettled(() => {
    const channel = new BroadcastChannel(VUE_CHANNEL);
    const fromFrame = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || typeof e.data !== "string" || !e.data.includes(VUE_FRAME_KEY)) return;
      channel.postMessage(e.data.replace(VUE_FRAME_KEY, VUE_CHANNEL_KEY));
    };
    channel.onmessage = (e) => {
      if (typeof e.data !== "string" || !e.data.includes(VUE_CHANNEL_KEY)) return;
      frame.contentWindow?.postMessage(e.data.replace(VUE_CHANNEL_KEY, VUE_FRAME_KEY), "*");
    };
    addEventListener("message", fromFrame);
    return () => {
      removeEventListener("message", fromFrame);
      channel.close();
    };
  });
  return (
    <div class="devtools">
      <iframe ref={frame} id="devtools-frame" title="Vue devtools" src={src()} />
      <Show when={!src()}>
        <p class="devtools-empty">Vue's devtools show up here once the program's dev server runs.</p>
      </Show>
    </div>
  );
}

type NuxtWindow = Window & { __NUXT_DEVTOOLS_HOST__?: object; __NUXT_DEVTOOLS_VIEW__?: { setClient(host: object): void } };

/**
 * Nuxt's devtools for the page in the active preview tab: their client (`<preview>/__nuxt_devtools__/client/`) in a
 * frame, handed the page's devtools host as Nuxt's own panel hands it (`__NUXT_DEVTOOLS_VIEW__.setClient`), and again
 * whenever the page comes with another one (a reload, another tab). Same origin, so no messages in between.
 */
function NuxtDevtools() {
  const app = useContext(AppContext);
  let frame!: HTMLIFrameElement;
  // Past the welcome page, which the client shows until its first visit is over (its Get Started, which also asks about
  // usage statistics: a project's nuxt.config.ts sets `devtools.telemetry`). The client shares this origin's storage.
  try {
    localStorage.setItem("nuxt-devtools-first-visit", "false");
  } catch {}
  // The client's root. No query: Nuxt fills in the client's base only for the bare path. A new preview tab mounts this
  // afresh instead (DevtoolsBody).
  const src = () => (app.session.ports().length ? previewUrl("/__nuxt_devtools__/client/") : undefined);
  onSettled(() => {
    let handed: object | undefined;
    const hand = () => {
      try {
        // The client's router knows paths under its base (`/__nuxt_devtools__/client/`), not the preview's prefix in
        // front of it: it starts on a "not found" page. Sent to the overview, as its welcome page's Get Started does.
        type Router = { currentRoute: { value: { path: string } }; replace(to: string): unknown };
        const root = frame.contentDocument?.getElementById("__nuxt") as (HTMLElement & { __vue_app__?: { config: { globalProperties: { $router?: Router } } } }) | null;
        const router = root?.__vue_app__?.config.globalProperties.$router;
        if (router?.currentRoute.value.path.includes("__preview")) void router.replace("/modules/overview");
        const view = (frame.contentWindow as NuxtWindow | null)?.__NUXT_DEVTOOLS_VIEW__;
        const page = app.previews.frames.get(app.previews.state.active)?.contentWindow as NuxtWindow | null | undefined;
        const host = page?.__NUXT_DEVTOOLS_HOST__;
        if (!view || !host || host === handed) return;
        view.setClient(host);
        handed = host;
      } catch {
        // A page on another origin, or one still loading.
      }
    };
    // A loaded client starts without a host.
    const reset = () => void (handed = undefined);
    frame.addEventListener("load", reset);
    const timer = setInterval(hand, 500);
    return () => {
      clearInterval(timer);
      frame.removeEventListener("load", reset);
    };
  });
  return (
    <div class="devtools">
      <iframe ref={frame} id="devtools-frame" title="Nuxt devtools" src={src()} />
      <Show when={!src()}>
        <p class="devtools-empty">Nuxt's devtools show up here once the dev server runs.</p>
      </Show>
    </div>
  );
}

/** The Devtools tab's pane: the project's kind of devtools, mounted afresh when another project brings another kind. */
function DevtoolsBody() {
  const app = useContext(AppContext);
  return (
    <Show when={kindOf(app)} keyed>
      {(kind) =>
        kind === "vue" ? (
          <VueDevtools />
        ) : kind === "nuxt" ? (
          <For each={[app.previews.state.active]}>{() => <NuxtDevtools />}</For>
        ) : (
          <SolidDevtools />
        )
      }
    </Show>
  );
}

export const devtoolsTab: DockTab = {
  id: "devtools",
  title: "Devtools",
  tip: "The project's devtools (Solid's, Vue's or Nuxt's), for the page in the active preview tab",
  icon: "i-lucide-activity",
  when: offered,
  attention: () => asked() || undefined,
  Body: DevtoolsBody,
};
