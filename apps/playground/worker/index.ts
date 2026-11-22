import { createAuth, githubRepos, githubToken, withCookies, type Auth } from "./auth";
import { cardFor, drawCard, type Card } from "./card";
import { GIT_PROXY, gitProxy } from "./gitProxy";
import { stranded } from "./stranded";

// Feedback: POST /api/feedback (from the playground's Feedback dialog and the docs' page rating) stores one row in the
// FEEDBACK D1 database (worker/migrations/), not with the links; see feedback() below and scripts/feedback.ts to read them.
//
// Opt-in short links for Share: POST /api/short stores a share payload (the text after "#code=") in KV under an id
// derived from its content, so sharing the same project twice gives the same link and costs no second write.
// GET /s/<id> redirects to /#code=<payload>, which the playground already knows how to open. A project whose
// runbun.json asks for a share card of its own (`card`, card.ts) gets a page with the card's tags that does the same
// from a script, and GET /s/<id>/card.png is its picture. GET /about is the home page (index.html), which shows its
// landing page there. Everything else is the static site.
//
// GET/POST /git-proxy/<host>/<repo>/... forwards git's smart-HTTP requests to a few git hosts (gitProxy.ts), for `git
// clone` and `fetch` in the playground. /api/auth/* is sign-in with GitHub (Better Auth, no database: auth.ts), and
// GET /api/github/repos lists the signed-in user's repositories.
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
  /** The content origin's host name (wrangler.jsonc vars): the same Worker and assets answer there, see contentHost(). */
  CONTENT_HOST: string;
  /** The editor origin the content host sends visitors to. */
  EDITOR_ORIGIN: string;
  /**
   * "1" turns on share cards of a project's own (card.ts). Off unless set (wrangler.jsonc sets it nowhere yet): a link
   * is then made and opened as before cards, its payload never inflated, and nothing is drawn.
   */
  SHARE_CARDS?: string;
  /** Sign in with GitHub (auth.ts): the runbun-dev org's GitHub App, and Better Auth's cookie key. Secrets. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
}

/** Better Auth per editor origin (runbun.dev, canary, a preview URL), made on first use. */
const auths = new Map<string, Auth | null>();
const authFor = (env: Env, origin: string) => {
  if (!auths.has(origin)) auths.set(origin, createAuth(env, origin));
  return auths.get(origin)!;
};

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

/**
 * Kept with each link: "YYYY-MM-DD" days (links stored before this have none until they're opened), and its share
 * card's text when the project asks for one.
 */
interface Dates {
  created?: string;
  viewed?: string;
  card?: Card;
}
/** A drawn card's key: this and the link's id (15 characters, where a link's key is its 10). */
const CARD_KEY = "card:";
/** Whether this deploy makes share cards (Env.SHARE_CARDS). */
const cards = (env: Env) => env.SHARE_CARDS === "1";
const FOREVER = "public, max-age=31536000, immutable";

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
  const kept = await env.LINKS.getWithMetadata<Dates>(id, "stream");
  void kept.value?.cancel();
  let card = (cards(env) && kept.metadata?.card) || null;
  if (kept.value === null) {
    card = cards(env) ? await cardFor(payload) : null;
    await env.LINKS.put(id, payload, { metadata: { created: today(), ...(card ? { card } : {}) } satisfies Dates });
  }
  // A path, not a URL: the page adds its own origin (runbun.dev, workers.dev or a local dev server). `card`: the link
  // has a share card, which the page asks for once so it is drawn before the link is posted anywhere (src/share.ts).
  return json(200, { id, path: `/s/${id}`, ...(card ? { card: true } : {}) });
}

async function open(id: string, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  // The default (60 s) edge cache, not a day: a longer one would keep serving the old "viewed" after the write below,
  // and every open in that window would write again.
  const { value: payload, metadata } = ID.test(id) ? await env.LINKS.getWithMetadata<Dates>(id) : { value: null, metadata: null };
  // At most one write per link a day; a failed write (KV allows one a second per key) only loses a date.
  if (payload !== null && metadata?.viewed !== today())
    ctx.waitUntil(env.LINKS.put(id, payload, { metadata: { ...metadata, viewed: today() } satisfies Dates }).catch(() => {}));
  if (payload === null) return new Response("This short link doesn't exist (or never did).", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!cards(env) || !metadata?.card) return Response.redirect(`${url.origin}/#code=${payload}`, 302);
  // The card's picture only once it is drawn: drawing takes more CPU time than a request may get on Workers' Free
  // plan, and a picture that failed to draw would be a broken one wherever the link is posted. Until then the site's.
  const drawn = await env.LINKS.get(CARD_KEY + id, "stream");
  void drawn?.cancel();
  return new Response(cardPage(metadata.card, id, payload, url, drawn !== null), { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
}

/** What the site's own card (og.png) shows, as index.html says it. */
const SITE_CARD_ALT = "A pixel-art kitchen counter with a dumpling in a bamboo steamer, under the words: Bun in your browser";
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * What a link with a card answers instead of a redirect, which carries no tags: the card for whatever reads the page
 * to show a preview, and for a browser the same redirect from a script. The payload is base64url, safe as it is.
 */
function cardPage(card: Card, id: string, payload: string, url: URL, drawn: boolean): string {
  const title = escape(card.title);
  const description = escape(card.description ?? `A project on ${url.host}: open it to edit and run it in your browser.`);
  const image = drawn ? `${url.origin}/s/${id}/card.png` : `${url.origin}/og.png`;
  const alt = drawn ? escape([card.title, card.description, card.tags?.join(", ")].filter(Boolean).map((part) => part!.replace(/\.$/, "")).join(". ")) : SITE_CARD_ALT;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title} · ${url.host}</title>
    <meta name="description" content="${description}" />
    <meta name="robots" content="noindex" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${url.host}" />
    <meta property="og:url" content="${url.origin}/s/${id}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${image}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${alt}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${image}" />
    <meta name="twitter:image:alt" content="${alt}" />
    <script>location.replace("/#code=${payload}");</script>
  </head>
  <body>
    <p><a href="/#code=${payload}">Open ${title} on ${url.host}</a></p>
  </body>
</html>
`;
}

/**
 * GET /s/<id>/card.png: the link's card, drawn once and kept beside the link (and at the edge), since a link's card
 * never changes. A link without one, or a card that can't be drawn, gets the site's. The playground asks for it right
 * after making the link; a request the runtime stops for its CPU time leaves nothing behind, and the next one tries again.
 */
async function cardImage(id: string, req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const cached = await caches.default.match(req);
  if (cached) return cached;
  const site = Response.redirect(`${url.origin}/og.png`, 302);
  if (!cards(env) || !ID.test(id)) return site;
  const png = (bytes: ArrayBuffer | Uint8Array) => new Response(bytes as BodyInit, { headers: { "content-type": "image/png", "cache-control": FOREVER } });
  let res: Response;
  const kept = await env.LINKS.get(CARD_KEY + id, "arrayBuffer");
  if (kept) res = png(kept);
  else {
    const { metadata } = await env.LINKS.getWithMetadata<Dates>(id, "stream");
    if (!metadata?.card) return site;
    try {
      const drawn = await drawCard(metadata.card, url.host);
      // Kept before answering: the link's page names the picture from the moment this is there.
      await env.LINKS.put(CARD_KEY + id, drawn).catch(() => {});
      res = png(drawn);
    } catch (e) {
      console.error(`card ${id}: ${e instanceof Error ? e.stack : e}`);
      return site;
    }
  }
  ctx.waitUntil(caches.default.put(req, res.clone()));
  return res;
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
/** Control characters out (C0 but \n and \t, DEL, C1): feedback is read in a terminal, where they are escape sequences. */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
const str = (v: unknown, max: number) => {
  const s = typeof v === "string" ? clean(v).trim() : "";
  return s ? s.slice(0, max) : undefined;
};

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
      .flatMap(([k, v]) => (typeof v === "string" ? [[clean(k).slice(0, 40), clean(v).slice(0, 300)]] : []));
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

/**
 * The editor's HTML pages, which the content host must not serve (run_worker_first in wrangler.jsonc lists the same
 * paths). Project code runs on the content host and the editor holds the user's data, so the editor never loads there.
 */
const EDITOR_PAGES = new Set(["/", "/index.html", "/about", "/embed", "/embed.html", "/configure", "/configure.html"]);

/**
 * The content origin (run.runbun.dev, src/contentOrigin.ts) is this Worker and these assets under another host name, so
 * project code is a different origin from the editor's saved projects, folder grants and Local Bun token. It serves
 * host.html, sw.js and the built assets; no API (short links and feedback are the editor's), no editor pages (they
 * redirect to the editor), and no sitemap. Its headers (CORP, noindex, frame-ancestors on host.html) are in _headers.
 */
function contentHost(req: Request, env: Env, url: URL): Promise<Response> | Response {
  const { pathname } = url;
  if (pathname.startsWith("/api/") || pathname.startsWith("/s/") || pathname.startsWith(GIT_PROXY)) return json(404, { error: "not found" });
  // Crawlers may fetch pages here and see their noindex (a blocked URL can still be listed); nothing lists the host.
  if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  if (pathname === "/sitemap.xml") return new Response("Not found", { status: 404 });
  if (EDITOR_PAGES.has(pathname)) return Response.redirect(env.EDITOR_ORIGIN + pathname + url.search, 302);
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname === env.CONTENT_HOST) return contentHost(req, env, url);
    if (url.pathname === "/api/short" && req.method === "POST") return create(req, env, url);
    if (url.pathname === "/api/feedback" && (req.method === "POST" || req.method === "OPTIONS")) return feedback(req, env, url);
    if (url.pathname.startsWith("/s/") && url.pathname.endsWith("/card.png") && req.method === "GET") return cardImage(url.pathname.slice(3, -"/card.png".length), req, env, url, ctx);
    if (url.pathname.startsWith("/s/")) return open(url.pathname.slice(3), env, url, ctx);
    if (url.pathname.startsWith("/api/auth/")) {
      const auth = authFor(env, url.origin);
      return auth ? auth.handler(req) : json(503, { error: "sign-in isn't set up here" });
    }
    if (url.pathname === "/api/github/repos" && req.method === "GET") return githubRepos(authFor(env, url.origin), req);
    if (url.pathname.startsWith(GIT_PROXY)) {
      const signedIn = await githubToken(authFor(env, url.origin), req);
      return withCookies(await gitProxy(req, url.pathname.slice(GIT_PROXY.length), signedIn?.token), signedIn?.cookies ?? []);
    }
    if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
    // The landing page again, for visitors the home page now takes straight to the playground (index.html reads the path).
    if (url.pathname === "/about") return env.ASSETS.fetch(new Request(new URL("/", url), req));
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
