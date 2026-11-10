// Sign in with GitHub, for git with private repositories and push: Better Auth with no database (stateless). The
// session and the GitHub account (its access and refresh tokens) live in encrypted, httpOnly cookies on the editor's
// origin; nothing is stored on our side. Page code can't read the token, and project code runs on another origin
// (src/contentOrigin.ts). The git proxy (gitProxy.ts) and /api/github/* take the token from the cookie here.
//
// The GitHub App (owned by the runbun-dev org) gives user tokens that expire after 8 hours with a refresh token; Better
// Auth refreshes them as it reads them. One sign-in lasts 7 days, renewed (sliding) while it's used.
//
// Secrets: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, BETTER_AUTH_SECRET. In dev from apps/playground/.dev.vars (vite.config.ts);
// on the Worker as secrets (`moon run playground:secrets`, which runs `wrangler secret bulk .dev.vars`).
import { betterAuth } from "better-auth";

export type AuthEnv = { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; BETTER_AUTH_SECRET?: string };

const WEEK = 60 * 60 * 24 * 7;

/** Better Auth for `origin` (the editor's), or null when the secrets aren't set (sign-in is then unavailable). */
export function createAuth(env: AuthEnv, origin: string) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.BETTER_AUTH_SECRET) return null;
  return betterAuth({
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    socialProviders: {
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    },
    session: {
      expiresIn: WEEK,
      updateAge: 60 * 60 * 24,
      // The session and the account cookie live as long as the session (the account cookie's default is 5 minutes).
      cookieCache: { enabled: true, maxAge: WEEK, strategy: "jwe", refreshCache: true },
    },
    account: { storeStateStrategy: "cookie", storeAccountCookie: true },
  });
}

export type Auth = NonNullable<ReturnType<typeof createAuth>>;

/**
 * The signed-in user's GitHub token, refreshed if it expired, and the cookies to send back (a refresh rewrites the
 * account cookie). Null when nobody is signed in.
 */
export async function githubToken(auth: Auth | null, req: Request): Promise<{ token: string; cookies: string[] } | null> {
  if (!auth || !req.headers.get("cookie")?.includes("better-auth")) return null;
  try {
    const { headers, response } = await auth.api.getAccessToken({ body: { useAccountCookie: true }, headers: req.headers, returnHeaders: true });
    if (!response?.accessToken) return null;
    return { token: response.accessToken, cookies: headers.getSetCookie() };
  } catch {
    return null;
  }
}

/** `res` with `cookies` set on it (a refreshed account cookie). */
export function withCookies(res: Response, cookies: string[]): Response {
  if (!cookies.length) return res;
  const out = new Response(res.body, res);
  for (const c of cookies) out.headers.append("set-cookie", c);
  return out;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * GET /api/github/repos: the repositories the signed-in user gave the app, most recently pushed first, for the "Open
 * a repository" dialog. 401 when nobody is signed in.
 */
export async function githubRepos(auth: Auth | null, req: Request, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (req.headers.get("sec-fetch-site") && req.headers.get("sec-fetch-site") !== "same-origin") return json(403, { error: "forbidden" });
  const t = await githubToken(auth, req);
  if (!t) return json(401, { error: "not signed in" });
  const res = await fetchFn("https://api.github.com/user/repos?per_page=100&sort=pushed", {
    headers: { authorization: `Bearer ${t.token}`, accept: "application/vnd.github+json", "user-agent": "runbun.dev", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) return withCookies(json(res.status === 401 ? 401 : 502, { error: `GitHub answered ${res.status}` }), t.cookies);
  const repos = (await res.json()) as { full_name: string; private: boolean; description: string | null; pushed_at: string; html_url: string }[];
  return withCookies(
    json(
      200,
      repos.map((r) => ({ name: r.full_name, private: r.private, description: r.description, pushed: r.pushed_at, url: r.html_url })),
    ),
    t.cookies,
  );
}
