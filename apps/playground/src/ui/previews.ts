import { createStore, flush, reconcile } from "solid-js";
import type { PresetRequest } from "../embed/requests";
import { PREFIX, cardFromFrame, normalize, sendRequest, type Card } from "../preview";
import { build, fromHttp, modeOf, noAuth, queryOf, sent, withQuery, type Auth, type BodyMode, type Field } from "../request";

/** The request panel's sections (ui/Preview.tsx): the path's query, the headers, and the body of a method with one. */
export type Section = "params" | "headers" | "auth" | "body" | "raw";

/** The request panel's row lists, by name. */
export type Rows = "headers" | "form" | "multipart";

/** Whether a request with `method` carries a body (the panel's Body section). */
export const hasBody = (method: string) => method !== "GET" && method !== "HEAD";

/** One preview tab: its own request, and the page (kept loaded while hidden) or response it shows. */
export type PreviewTab = {
  id: number;
  method: string;
  path: string;
  body: string;
  /** How the body is sent; the editor's text is `body`, a form's rows `form` or `multipart`. */
  bodyMode: BodyMode;
  form: Field[];
  multipart: Field[];
  /** Headers sent with the request (the ones turned on); the query lives in `path`. */
  headers: Field[];
  auth: Auth;
  /** Whether the request panel shows, and which of its sections. */
  panel: boolean;
  section: Section;
  view: "frame" | "response";
  /** The page's <title>, once one loaded. */
  title: string;
  response: Card | null;
  /** A preset request (the embed's `requests`) not sent yet: it goes the first time the tab shows while the server runs. */
  pending: boolean;
};

/**
 * Previews of the running server, as tabs; the request bar edits the active one. The iframes register
 * themselves in `frames` so requests can navigate them. `running` says whether the server is up, for preset tabs
 * opened after Run.
 */
export function createPreviews(running: () => boolean = () => false, read: (path: string) => Uint8Array | undefined = () => undefined) {
  const blank = (id: number, path: string, method = "GET", body = "", pending = false): PreviewTab => ({
    id,
    method,
    path,
    body,
    bodyMode: modeOf(body),
    form: [],
    multipart: [],
    headers: [],
    auth: noAuth(),
    panel: hasBody(method),
    section: hasBody(method) ? "body" : "params",
    view: "frame",
    title: "",
    response: null,
    pending,
  });
  /** A preset tab that shows while the server runs sends its request (once: request() clears `pending`). */
  const sendIfPending = (id: number) => {
    if (running() && state.tabs.find((t) => t.id === id)?.pending) void previews.request(id);
  };
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
      sendIfPending(state.active);
    },
    activate(id: number) {
      setState((s) => {
        s.active = id;
      });
      sendIfPending(id);
    },
    /**
     * The request bar's fields write straight into the active tab. A method that takes a body opens the panel on it;
     * one that doesn't moves off Body, and closes the panel when it has nothing else to show.
     */
    edit(id: number, field: "method" | "path" | "body", value: string) {
      update(id, (t) => {
        const had = hasBody(t.method);
        t[field] = value;
        if (field !== "method" || had === hasBody(value)) return;
        if (!had) {
          t.panel = true;
          t.section = "body";
        } else if (t.section === "body") {
          t.section = "params";
          t.panel = queryOf(t.path).length > 0 || sent(t.headers).length > 0 || t.auth.type !== "none";
        }
      });
    },
    /** Shows the request panel, on `section`; with no section, shows or hides it. */
    panel(id: number, section?: Section) {
      update(id, (t) => {
        if (section) t.section = section;
        t.panel = section ? true : !t.panel;
      });
    },
    /** Query parameter `i` changed (one past the last: a new one); the path's query is written again from them. */
    param(id: number, i: number, change: Partial<{ name: string; value: string }>) {
      update(id, (t) => {
        const params = queryOf(t.path);
        params[i] = { ...(params[i] ?? { name: "", value: "" }), ...change };
        t.path = withQuery(t.path, params);
      });
    },
    removeParam(id: number, i: number) {
      update(id, (t) => {
        t.path = withQuery(
          t.path,
          queryOf(t.path).filter((_, j) => j !== i),
        );
      });
    },
    /** Row `i` of a list changed (one past the last: a new one, turned on). */
    row(id: number, list: Rows, i: number, change: Partial<Field>) {
      update(id, (t) => {
        if (i >= t[list].length) t[list].push({ name: "", value: "", on: true, ...change });
        else Object.assign(t[list][i]!, change);
      });
    },
    removeRow(id: number, list: Rows, i: number) {
      update(id, (t) => {
        t[list].splice(i, 1);
      });
    },
    /** The Raw view edited: the request as `.http` text (request.ts fromHttp) sets what it holds. */
    raw(id: number, text: string) {
      update(id, (t) => {
        const r = fromHttp(text, t);
        if (r.method) t.method = r.method;
        if (r.path !== undefined) t.path = r.path;
        // Into the rows there are, so a row that didn't change isn't replaced (reconcile leaves holes when the list
        // shrinks).
        r.headers.forEach((h, i) => (t.headers[i] ? Object.assign(t.headers[i]!, h) : t.headers.push(h)));
        t.headers.splice(r.headers.length);
        if (r.body !== undefined) t.body = r.body;
        if (r.bodyMode) t.bodyMode = r.bodyMode;
      });
    },
    bodyMode(id: number, mode: BodyMode) {
      update(id, (t) => {
        t.bodyMode = mode;
      });
    },
    auth(id: number, change: Partial<Auth>) {
      update(id, (t) => {
        Object.assign(t.auth, change);
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
      if (tab.pending)
        update(id, (t) => {
          t.pending = false;
        });
      const m = method ?? tab.method;
      let path = normalize(tab.path.trim() || "/");
      let result: "page" | Card;
      try {
        const req = build({ ...tab, method: m, path }, read);
        path = req.path;
        result = await sendRequest(m, req);
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
    /**
     * The embed's `requests`: one tab per preset, in order, the first active. Each is pending: the first goes when
     * the server starts (reload), the others when their tab first shows.
     */
    presets(list: PresetRequest[]) {
      if (!list.length) return;
      lastId = list.length;
      setState((s) => {
        s.tabs = list.map((r, i) => ({ ...blank(i + 1, normalize(r.path), r.method, r.body, true), headers: (r.headers ?? []).map(([name, value]) => ({ name, value, on: true })) }));
        s.active = 1;
      });
    },
    /**
     * After Run: tabs showing a page or a GET response load again; a POST and the like isn't replayed. A preset tab
     * not sent yet goes with its own request if it's the one showing, else waits to be opened.
     */
    reload() {
      for (const tab of state.tabs) {
        if (tab.pending) {
          if (tab.id === state.active) void previews.request(tab.id);
        } else if (tab.view === "frame" || tab.method === "GET") void previews.request(tab.id, "GET");
      }
    },
  };
  return previews;
}

export type Previews = ReturnType<typeof createPreviews>;
