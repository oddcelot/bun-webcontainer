// Opt-in short links for Share: POST /api/short stores a share payload (the text after "#code=") in KV under an id
// derived from its content, so sharing the same project twice gives the same link and costs no second write.
// GET /s/<id> redirects to /#code=<payload>, which the playground already knows how to open. Everything else is
// the static site.

interface Env {
  ASSETS: Fetcher;
  LINKS: KVNamespace;
  CREATE_LIMIT: RateLimit;
}

/** The longest payload kept: about 64 KB of compressed project, as base64url. */
const MAX_PAYLOAD = Math.ceil((64 * 1024 * 4) / 3);
const ID = /^[0-9A-Za-z]{10}$/;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 10 base62 characters (~59 bits) of the payload's SHA-256. */
async function idFor(payload: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
  let n = 0n;
  for (const b of digest.subarray(0, 8)) n = (n << 8n) | BigInt(b);
  let id = "";
  for (let i = 0; i < 10; i++, n /= 62n) id += ALPHABET[Number(n % 62n)];
  return id;
}

const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function create(req: Request, env: Env, url: URL): Promise<Response> {
  // Only the playground itself creates links.
  if (req.headers.get("origin") !== url.origin) return json(403, { error: "forbidden" });
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.CREATE_LIMIT.limit({ key: ip })).success) return json(429, { error: "too many short links, try again in a minute" });
  const payload = (await req.text()).trim();
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return json(400, { error: "not a share payload" });
  if (payload.length > MAX_PAYLOAD) return json(413, { error: "project too large for a short link" });
  const id = await idFor(payload);
  if ((await env.LINKS.get(id)) === null) await env.LINKS.put(id, payload);
  // A path, not a URL: the page adds its own origin (runbun.dev, workers.dev or a local dev server).
  return json(200, { id, path: `/s/${id}` });
}

async function open(id: string, env: Env, url: URL): Promise<Response> {
  const payload = ID.test(id) ? await env.LINKS.get(id, { cacheTtl: 86400 }) : null;
  if (payload === null) return new Response("This short link doesn't exist (or never did).", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return Response.redirect(`${url.origin}/#code=${payload}`, 302);
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/short" && req.method === "POST") return create(req, env, url);
    if (url.pathname.startsWith("/s/")) return open(url.pathname.slice(3), env, url);
    if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
