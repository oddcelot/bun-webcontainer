import { BASE } from "./base";

/**
 * Where the service worker serves the running Bun.serve app (see sw.js): `/__preview/@<client id>` once the worker
 * has said which client this page is, so it reaches this page's server and not another playground's.
 */
export let PREFIX = `${BASE}__preview`;
export function setPreviewOwner(clientId: string) {
  PREFIX = `${BASE}__preview/@${clientId}`;
}

// Added by sw.js to every preview response, not sent by the user's server.
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
  return { ok: res.ok, line: `${method} ${path}`, status: `${res.status} ${res.statusText}`.trim(), head, type, text };
}
