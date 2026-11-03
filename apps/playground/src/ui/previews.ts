import { createStore, flush, reconcile } from "solid-js";
import { PREFIX, cardFromFrame, normalize, sendRequest, type Card } from "../preview";

/** One preview tab: its own request, and the page (kept loaded while hidden) or response it shows. */
export type PreviewTab = {
  id: number;
  method: string;
  path: string;
  body: string;
  view: "frame" | "response";
  /** The page's <title>, once one loaded. */
  title: string;
  response: Card | null;
};

/**
 * Previews of the running server, as tabs; the request bar edits the active one. The iframes register
 * themselves in `frames` so requests can navigate them.
 */
export function createPreviews() {
  const blank = (id: number, path: string): PreviewTab => ({ id, method: "GET", path, body: "", view: "frame", title: "", response: null });
  // One tab to start with (created here: writing to the store from inside the caller's root isn't allowed).
  let lastId = 1;
  const frames = new Map<number, HTMLIFrameElement>();
  const [state, setState] = createStore({ tabs: [blank(1, "/")], active: 1, expanded: false });
  const update = (id: number, fn: (tab: PreviewTab) => void) =>
    setState((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (tab) fn(tab);
    });

  const previews = {
    state,
    frames,
    /** Opens a tab after the active one and activates it; returns its id. */
    open(path = "/") {
      const id = ++lastId;
      setState((s) => {
        const i = s.tabs.findIndex((t) => t.id === s.active);
        s.tabs.splice(i < 0 ? s.tabs.length : i + 1, 0, blank(id, path));
        s.active = id;
      });
      return id;
    },
    close(id: number) {
      setState((s) => {
        const i = s.tabs.findIndex((t) => t.id === id);
        if (i < 0 || s.tabs.length === 1) return;
        s.tabs.splice(i, 1);
        if (s.active === id) s.active = (s.tabs[i] ?? s.tabs[i - 1]).id;
      });
      frames.delete(id);
    },
    activate(id: number) {
      setState((s) => {
        s.active = id;
      });
    },
    /** The request bar's fields write straight into the active tab. */
    edit(id: number, field: "method" | "path" | "body", value: string) {
      update(id, (t) => {
        t[field] = value;
      });
    },
    setExpanded(on: boolean) {
      setState((s) => {
        s.expanded = on;
      });
    },
    /** Sends the tab's request (or `method` instead of its own) and shows the page or the response. */
    async request(id: number, method?: string) {
      flush(); // a tab opened just now isn't readable before
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return;
      const m = method ?? tab.method;
      const path = normalize(tab.path.trim() || "/");
      let result: "page" | Card;
      try {
        result = await sendRequest(m, path, tab.body);
      } catch (err) {
        result = { ok: false, line: `${m} ${tab.path}`, status: "", head: "", type: "", text: String(err) };
      }
      if (result === "page") {
        update(id, (t) => {
          t.view = "frame";
        });
        frames.get(id)?.contentWindow?.location.replace(PREFIX + path);
      } else {
        const card = result;
        update(id, (t) => {
          // Merge into the previous card, so only the parts that changed re-render.
          if (t.response) reconcile(card)(t.response);
          else t.response = card;
          t.view = "response";
        });
      }
    },
    /**
     * A tab's page loaded: keep its path in sync when the page navigates itself (links, forms, redirects). Where that
     * lands on JSON or plain text, the tab shows it as a response card, as if requested from the bar.
     */
    loaded(id: number, frame: HTMLIFrameElement) {
      const loc = frame.contentWindow?.location;
      if (!loc?.pathname.startsWith(PREFIX)) return;
      const path = loc.pathname.slice(PREFIX.length) + loc.search;
      const card = cardFromFrame(path, frame);
      update(id, (t) => {
        t.path = path;
        t.title = card ? "" : (frame.contentDocument?.title ?? "");
        if (!card) return;
        if (t.response) reconcile(card)(t.response);
        else t.response = card;
        t.view = "response";
      });
    },
    /** Where the first tab requests before anything has been sent: the embed's `path` option. */
    start(path: string) {
      update(1, (t) => {
        t.path = normalize(path.trim() || "/");
      });
    },
    /** After Run: tabs showing a page or a GET response load again; a POST and the like isn't replayed. */
    reload() {
      for (const tab of state.tabs) if (tab.view === "frame" || tab.method === "GET") void previews.request(tab.id, "GET");
    },
  };
  return previews;
}

export type Previews = ReturnType<typeof createPreviews>;
