// Feedback: POST /api/feedback (from the playground's Feedback dialog and the docs' page rating) stores one row in the
// FEEDBACK D1 database (worker/migrations/), not with the links; see feedback() below and scripts/feedback.ts to read them.
//
// Opt-in short links for Share: POST /api/short stores a share payload (the text after "#code=") in KV under an id
// derived from its content, so sharing the same project twice gives the same link and costs no second write.
// GET /s/<id> redirects to /#code=<payload>, which the playground already knows how to open. Everything else is
// the static site.
//
// Links are kept until someone asks for one to be removed (docs: /privacy/). Each key's metadata records the day it was
// created and the day it was last opened, for a later cleanup of links nobody uses; reading it costs nothing extra.

interface Env {
  ASSETS: Fetcher;
  LINKS: KVNamespace;
  FEEDBACK: D1Database;
  CREATE_LIMIT: RateLimit;
  FEEDBACK_LIMIT: RateLimit;
  /** The docs site's origin (wrangler.jsonc vars), which may send feedback from another origin. */
  DOCS_ORIGIN: string;
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

/** Kept with each link, as "YYYY-MM-DD" days. Links stored before this have none until they're opened. */
interface Dates {
  created?: string;
  viewed?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

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
  if ((await env.LINKS.get(id)) === null) await env.LINKS.put(id, payload, { metadata: { created: today() } satisfies Dates });
  // A path, not a URL: the page adds its own origin (runbun.dev, workers.dev or a local dev server).
  return json(200, { id, path: `/s/${id}` });
}

async function open(id: string, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  // The default (60 s) edge cache, not a day: a longer one would keep serving the old "viewed" after the write below,
  // and every open in that window would write again.
  const { value: payload, metadata } = ID.test(id) ? await env.LINKS.getWithMetadata<Dates>(id) : { value: null, metadata: null };
  // At most one write per link a day; a failed write (KV allows one a second per key) only loses a date.
  if (payload !== null && metadata?.viewed !== today())
    ctx.waitUntil(env.LINKS.put(id, payload, { metadata: { ...metadata, viewed: today() } satisfies Dates }).catch(() => {}));
  if (payload === null) return new Response("This short link doesn't exist (or never did).", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return Response.redirect(`${url.origin}/#code=${payload}`, 302);
}

/** One piece of feedback as stored: what the sender typed or picked, and only what they chose to include. */
export interface Feedback {
  kind: "message" | "rating";
  /** "YYYY-MM-DDTHH:MM:SSZ". */
  at: string;
  /** The page it was sent from (path and query; no hash, which may carry a whole project). */
  page: string;
  message?: string;
  email?: string;
  rating?: "up" | "down";
  /** Bun release, browser and the like, when the sender ticked "include". */
  env?: Record<string, string>;
  /** A short link (/s/<id>) to the project, when the sender ticked "attach". */
  project?: string;
}

const MAX_MESSAGE = 4000;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** The request body, checked and trimmed; a string says what's wrong with it. */
function parseFeedback(body: unknown): Feedback | string {
  if (!body || typeof body !== "object") return "not a feedback entry";
  const b = body as Record<string, unknown>;
  if (b.kind !== "message" && b.kind !== "rating") return "unknown kind";
  const fb: Feedback = { kind: b.kind, at: new Date().toISOString().slice(0, 19) + "Z", page: "" };
  const page = str(b.page, 2000);
  if (page) {
    try {
      const u = new URL(page);
      fb.page = (u.origin + u.pathname + u.search).slice(0, 300);
    } catch {
      return "page is not a URL";
    }
  }
  fb.message = str(b.message, MAX_MESSAGE);
  if (b.kind === "rating") {
    if (b.rating !== "up" && b.rating !== "down") return "rating must be up or down";
    fb.rating = b.rating;
  } else if (!fb.message) return "the message is empty";
  const email = str(b.email, 200);
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "that email address doesn't look right";
    fb.email = email;
  }
  if (b.env && typeof b.env === "object") {
    const env = Object.entries(b.env as Record<string, unknown>)
      .slice(0, 12)
      .flatMap(([k, v]) => (typeof v === "string" ? [[k.slice(0, 40), v.slice(0, 300)]] : []));
    if (env.length) fb.env = Object.fromEntries(env);
  }
  const project = str(b.project, 20);
  if (project) {
    if (!/^\/s\/[0-9A-Za-z]{10}$/.test(project)) return "project is not a short link";
    fb.project = project;
  }
  return fb;
}

/** The playground and the docs may send feedback; the docs from their own origin, so they get CORS headers. */
const feedbackOrigin = (req: Request, env: Env, url: URL) => {
  const origin = req.headers.get("origin");
  return origin === url.origin || (origin !== null && origin === env.DOCS_ORIGIN) ? origin : null;
};

const cors = (origin: string) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  vary: "origin",
});

async function feedback(req: Request, env: Env, url: URL): Promise<Response> {
  const origin = feedbackOrigin(req, env, url);
  if (!origin) return json(403, { error: "forbidden" });
  const reply = (status: number, body: object) => {
    const res = json(status, body);
    for (const [k, v] of Object.entries(cors(origin))) res.headers.set(k, v);
    return res;
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  // The IP only keys the limit; it isn't stored with the entry.
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.FEEDBACK_LIMIT.limit({ key: ip })).success) return reply(429, { error: "too much feedback at once, try again in a minute" });
  const text = await req.text();
  if (text.length > 16 * 1024) return reply(413, { error: "too long" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: "not JSON" });
  }
  const fb = parseFeedback(body);
  if (typeof fb === "string") return reply(400, { error: fb });
  await env.FEEDBACK.prepare("INSERT INTO feedback (at, kind, page, rating, message, email, env, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(fb.at, fb.kind, fb.page, fb.rating ?? null, fb.message ?? null, fb.email ?? null, fb.env ? JSON.stringify(fb.env) : null, fb.project ?? null)
    .run();
  return reply(200, { ok: true });
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/short" && req.method === "POST") return create(req, env, url);
    if (url.pathname === "/api/feedback" && (req.method === "POST" || req.method === "OPTIONS")) return feedback(req, env, url);
    if (url.pathname.startsWith("/s/")) return open(url.pathname.slice(3), env, url, ctx);
    if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
