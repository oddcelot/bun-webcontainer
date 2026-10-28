import { BASE } from "./base";

const PREFIX = `${BASE}__preview`;
const EXPAND = `<i class="i-lucide-maximize-2" aria-hidden="true"></i>`;
const RESTORE = `<i class="i-lucide-minimize-2" aria-hidden="true"></i>`;

// Added by sw.js to every preview response, not sent by the user's server.
const SW_HEADERS = new Set(["cross-origin-embedder-policy", "cross-origin-resource-policy"]);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Request bar over the preview: any method and path against the running server. HTML GETs load in
 * the iframe (so pages, scripts and links work); everything else shows status, headers and body.
 */
export function mountPreview() {
  const frame = $<HTMLIFrameElement>("preview");
  const responseEl = $("response");
  const method = $<HTMLSelectElement>("req-method");
  const path = $<HTMLInputElement>("req-path");
  const body = $<HTMLTextAreaElement>("req-body");

  const normalize = (p: string) => (p.startsWith("/") ? p : `/${p}`);
  const show = (el: "frame" | "response") => {
    frame.hidden = el !== "frame";
    responseEl.hidden = el !== "response";
  };

  function load(p: string) {
    show("frame");
    frame.contentWindow!.location.replace(PREFIX + normalize(p));
  }

  async function send(m = method.value) {
    const p = normalize(path.value.trim() || "/");
    const init: RequestInit = { method: m };
    if (m !== "GET" && m !== "HEAD" && body.value) {
      init.body = body.value;
      let json = true;
      try {
        JSON.parse(body.value);
      } catch {
        json = false;
      }
      init.headers = { "content-type": json ? "application/json" : "text/plain" };
    }
    const res = await fetch(PREFIX + p, init);
    const type = res.headers.get("content-type") ?? "";
    // The iframe refetches the page; a second GET is the price of real navigation.
    if (m === "GET" && type.startsWith("text/html")) return load(p);
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
    const status = `${res.status} ${res.statusText}`.trim();
    responseEl.textContent = `${m} ${p}\n${status}\n${head}\n\n${text}`;
    responseEl.className = res.ok ? "" : "error";
    show("response");
  }

  const syncBody = () => (body.hidden = method.value === "GET" || method.value === "HEAD");
  method.onchange = syncBody;
  syncBody();
  const request = (m?: string) =>
    send(m).catch((err) => {
      responseEl.textContent = String(err);
      responseEl.className = "error";
      show("response");
    });
  $<HTMLFormElement>("request").onsubmit = (e) => {
    e.preventDefault();
    request();
  };
  // Keep the path in sync when the page navigates itself (links, forms, redirects).
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

  frame.onload = () => {
    const win = frame.contentWindow;
    const loc = win?.location;
    if (loc?.pathname.startsWith(PREFIX)) path.value = loc.pathname.slice(PREFIX.length) + loc.search;
    // Keys pressed in the page stay in the frame; same origin, so listen there too.
    win?.addEventListener("keydown", onKey);
  };

  /** After Run: GET the current path again. */
  return { reload: () => request("GET") };
}
