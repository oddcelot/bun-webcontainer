import { BASE } from "./base";

/**
 * Where the service worker serves the running Bun.serve app (see sw.ts): `/__preview/@<client id>` once the worker
 * has said which client this page is, so it reaches this page's server and not another playground's.
 */
export let PREFIX = `${BASE}__preview`;
export function setPreviewOwner(clientId: string) {
  PREFIX = `${BASE}__preview/@${clientId}`;
}

// Added by sw.ts to every preview response, not sent by the user's server.
const SW_HEADERS = new Set(["cross-origin-embedder-policy", "cross-origin-resource-policy"]);

export const normalize = (p: string) => (p.startsWith("/") ? p : `/${p}`);

/** A response as the preview shows it: status pill and request line, headers, then the body (red when it failed). */
/** A response that isn't a page; `type` is its content-type. */
export type Card = { ok: boolean; line: string; status: string; head: string; type: string; text: string };

/**
 * Sends a request to the running server. An HTML GET returns "page": the caller loads it in an iframe (a second
 * GET is the price of real navigation, so pages, scripts and links work). Anything else returns its card.
 */
export async function sendRequest(method: string, path: string, body: string): Promise<"page" | Card> {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD" && body) {
    init.body = body;
    let json = true;
    try {
      JSON.parse(body);
    } catch {
      json = false;
    }
    init.headers = { "content-type": json ? "application/json" : "text/plain" };
  }
  const res = await fetch(PREFIX + path, init);
  const type = res.headers.get("content-type") ?? "";
  if (method === "GET" && type.startsWith("text/html")) return "page";
  const head = [...res.headers]
    .filter(([k]) => !SW_HEADERS.has(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return { ok: res.ok, line: `${method} ${path}`, status: `${res.status} ${res.statusText}`.trim(), head, type, text: pretty(type, await res.text()) };
}

/** JSON bodies indented, as the card shows them; anything else (or JSON that doesn't parse) as it came. */
function pretty(type: string, text: string): string {
  if (!/[/+]json\b/.test(type)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * A frame that navigated to JSON or plain text (a link or redirect in a page) as a card, from the document it loaded:
 * no second request, so the handler doesn't run twice. Its headers aren't readable from the document, and its status
 * only where the browser reports it (PerformanceNavigationTiming.responseStatus). Null for anything else.
 */
export function cardFromFrame(path: string, frame: HTMLIFrameElement): Card | null {
  const doc = frame.contentDocument;
  const type = doc?.contentType ?? "";
  if (!doc?.body || !/[/+]json\b|^text\/plain\b/.test(type)) return null;
  const nav = frame.contentWindow?.performance.getEntriesByType("navigation")[0] as { responseStatus?: number } | undefined;
  const code = nav?.responseStatus || 0;
  // The browser shows such a document as one <pre> (Chrome adds its JSON viewer's controls around it).
  const text = (doc.querySelector("body > pre") ?? doc.body).textContent ?? "";
  return { ok: !code || code < 400, line: `GET ${path}`, status: code ? String(code) : "", head: "", type, text: pretty(type, text) };
}
