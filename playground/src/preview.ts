import { BASE } from "./base";

const PREFIX = `${BASE}__preview`;
const EXPAND = `<i class="i-lucide-maximize-2" aria-hidden="true"></i>`;
const RESTORE = `<i class="i-lucide-minimize-2" aria-hidden="true"></i>`;

// Added by sw.js to every preview response, not sent by the user's server.
const SW_HEADERS = new Set(["cross-origin-embedder-policy", "cross-origin-resource-policy"]);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** One preview tab: its own request, and the page (kept loaded while hidden) or response it shows. */
interface Tab {
  method: string;
  path: string;
  body: string;
  view: "frame" | "response";
  frame: HTMLIFrameElement;
  response: HTMLDivElement;
}

/**
 * Request bar over the preview: any method and path against the running server. HTML GETs load in
 * the iframe (so pages, scripts and links work); everything else shows status, headers and body.
 * Several previews can be open as tabs; the request bar acts on the active one.
 */
export function mountPreview() {
  const strip = $("preview-tabs");
  const views = $("preview-views");
  const method = $<HTMLSelectElement>("req-method");
  const path = $<HTMLInputElement>("req-path");
  const body = $<HTMLTextAreaElement>("req-body");
  const tabs: Tab[] = [];
  let active!: Tab;

  const normalize = (p: string) => (p.startsWith("/") ? p : `/${p}`);
  const syncBody = () => (body.hidden = method.value === "GET" || method.value === "HEAD");

  function show(tab: Tab, view: Tab["view"]) {
    tab.view = view;
    tab.frame.hidden = tab !== active || view !== "frame";
    tab.response.hidden = tab !== active || view !== "response";
  }

  function load(tab: Tab, p: string) {
    show(tab, "frame");
    tab.frame.contentWindow!.location.replace(PREFIX + normalize(p));
  }

  async function send(tab: Tab, m = tab.method) {
    const p = normalize(tab.path.trim() || "/");
    const init: RequestInit = { method: m };
    if (m !== "GET" && m !== "HEAD" && tab.body) {
      init.body = tab.body;
      let json = true;
      try {
        JSON.parse(tab.body);
      } catch {
        json = false;
      }
      init.headers = { "content-type": json ? "application/json" : "text/plain" };
    }
    const res = await fetch(PREFIX + p, init);
    const type = res.headers.get("content-type") ?? "";
    // The iframe refetches the page; a second GET is the price of real navigation.
    if (m === "GET" && type.startsWith("text/html")) return load(tab, p);
    let text = await res.text();
    if (/[/+]json\b/.test(type)) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {}
    }
    const head = [...res.headers]
      .filter(([k]) => !SW_HEADERS.has(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    respond(tab, res.ok, `${m} ${p}`, `${res.status} ${res.statusText}`.trim(), head, text);
  }

  /** The response card: status pill and request line, headers, then the body in a box (red when it failed). */
  function respond(tab: Tab, ok: boolean, line: string, status: string, head: string, text: string) {
    const el = (tag: string, className: string, textContent: string) => Object.assign(document.createElement(tag), { className, textContent });
    const top = el("div", "status-line", "");
    if (status) top.append(el("span", "status", status));
    top.append(el("span", "line", line));
    tab.response.replaceChildren(top);
    if (head) tab.response.append(el("pre", "headers", head));
    if (text) tab.response.append(el("pre", "body", text));
    tab.response.className = "preview-response" + (ok ? "" : " error");
    show(tab, "response");
  }

  const request = (tab: Tab, m?: string) =>
    send(tab, m).catch((err) => respond(tab, false, `${m ?? tab.method} ${tab.path}`, "", "", String(err)));

  function render() {
    strip.replaceChildren(
      ...tabs.map((tab) => {
        const el = document.createElement("div");
        el.className = "tab";
        el.role = "tab";
        el.title = tab.frame.contentDocument?.title || `${tab.method} ${tab.path}`;
        el.tabIndex = tab === active ? 0 : -1;
        el.setAttribute("aria-selected", String(tab === active));
        if (tab.method !== "GET") el.append(Object.assign(document.createElement("span"), { className: "method", textContent: tab.method }));
        el.append(Object.assign(document.createElement("span"), { className: "name", textContent: tab.path }));
        if (tabs.length > 1) {
          const close = document.createElement("button");
          close.className = "close";
          close.title = close.ariaLabel = `Close ${tab.path}`;
          close.tabIndex = -1;
          close.innerHTML = `<i class="i-lucide-x" aria-hidden="true"></i>`;
          close.onclick = (e) => {
            e.stopPropagation();
            closeTab(tab);
          };
          el.append(close);
          el.onauxclick = (e) => e.button === 1 && closeTab(tab);
        }
        el.onclick = () => activate(tab);
        return el;
      }),
      Object.assign(document.createElement("button"), {
        className: "add",
        type: "button",
        title: "New preview",
        ariaLabel: "New preview",
        innerHTML: `<i class="i-lucide-plus" aria-hidden="true"></i>`,
        onclick: () => request(openTab()),
      }),
    );
    strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** The request bar's fields belong to the active tab. */
  function save() {
    if (!active) return;
    active.method = method.value;
    active.path = path.value;
    active.body = body.value;
  }

  function activate(tab: Tab) {
    save();
    const prev = active;
    active = tab;
    if (prev) show(prev, prev.view);
    show(tab, tab.view);
    method.value = tab.method;
    path.value = tab.path;
    body.value = tab.body;
    syncBody();
    render();
  }

  function openTab(p = "/"): Tab {
    const frame = Object.assign(document.createElement("iframe"), { className: "preview-frame", title: "preview" });
    const response = Object.assign(document.createElement("div"), { className: "preview-response", hidden: true });
    const tab: Tab = { method: "GET", path: p, body: "", view: "frame", frame, response };
    frame.onload = () => {
      const win = frame.contentWindow;
      const loc = win?.location;
      // Keep the path in sync when the page navigates itself (links, forms, redirects).
      if (loc?.pathname.startsWith(PREFIX)) {
        tab.path = loc.pathname.slice(PREFIX.length) + loc.search;
        if (tab === active) path.value = tab.path;
        render();
      }
      // Keys pressed in the page stay in the frame; same origin, so listen there too.
      win?.addEventListener("keydown", onKey);
    };
    views.append(frame, response);
    tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, tab);
    activate(tab);
    return tab;
  }

  function closeTab(tab: Tab) {
    if (tabs.length === 1) return;
    const i = tabs.indexOf(tab);
    tabs.splice(i, 1);
    tab.frame.remove();
    tab.response.remove();
    if (tab === active) {
      active = undefined!; // don't save the bar into the closed tab
      activate(tabs[i] ?? tabs[i - 1]);
    } else render();
  }

  method.onchange = syncBody;
  $<HTMLFormElement>("request").onsubmit = (e) => {
    e.preventDefault();
    save();
    render();
    request(active);
  };

  const wrap = $("preview-wrap");
  const backdrop = $("preview-backdrop");
  const expandBtn = $<HTMLButtonElement>("expand");
  const expand = (on: boolean) => {
    wrap.classList.toggle("expanded", on);
    backdrop.hidden = !on;
    expandBtn.innerHTML = on ? RESTORE : EXPAND;
    expandBtn.title = on ? "Restore preview (Esc)" : "Expand preview (Esc)";
    expandBtn.setAttribute("aria-pressed", String(on));
  };
  expand(false);
  expandBtn.onclick = () => expand(!wrap.classList.contains("expanded"));
  backdrop.onclick = () => expand(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && wrap.classList.contains("expanded")) expand(false);
  };
  addEventListener("keydown", onKey);

  openTab();

  return {
    /** After Run: tabs showing a page or a GET response load again; a POST and the like isn't replayed. */
    reload() {
      save();
      for (const tab of tabs) if (tab.view === "frame" || tab.method === "GET") request(tab, "GET");
    },
  };
}
