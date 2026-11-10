// The git proxy: `git clone https://github.com/a/b` in the playground (src/git/worker.ts) asks for
// /git-proxy/github.com/a/b/info/refs?service=git-upload-pack, and this forwards it, because git hosts don't send CORS
// headers on their smart-HTTP endpoints. The Worker (index.ts) answers it on runbun.dev; the dev server (vite.config.ts)
// on localhost.
//
// Not an open proxy: only the hosts below, only git's smart-HTTP requests (the ref advertisement and the upload-pack
// and receive-pack exchanges), only from the playground's own pages, and no cookies or credentials either way.

export const GIT_PROXY = "/git-proxy/";

/** The git hosts the playground reaches. */
const HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"]);

/** The request headers git's smart-HTTP protocol uses; nothing else goes out. */
const FORWARD = ["accept", "content-type", "content-encoding", "git-protocol"];

const fail = (status: number, message: string) => new Response(message + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * Answers `req`, whose path (below the proxy's prefix) is `rest`: `<host>/<repository path>/<git endpoint>`. `fetchFn`
 * makes the outgoing request (the runtime's fetch).
 */
export async function gitProxy(req: Request, rest: string, fetchFn: typeof fetch = fetch): Promise<Response> {
  // A browser says where a request comes from: only the playground's own pages (and its git worker) may use this.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return fail(403, "the git proxy is only for the playground");
  const url = new URL(req.url);
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash);
  if (!HOSTS.has(host)) return fail(403, `the playground's git proxy doesn't reach ${host || "that host"} (only ${[...HOSTS].join(", ")})`);
  const service = url.searchParams.get("service");
  const advertisement = req.method === "GET" && /\/info\/refs$/.test(path) && (service === "git-upload-pack" || service === "git-receive-pack") && url.search === `?service=${service}`;
  const exchange = req.method === "POST" && /\/git-(upload|receive)-pack$/.test(path) && !url.search;
  if (!advertisement && !exchange) return fail(400, "not a git smart-HTTP request");

  const headers = new Headers({ "user-agent": "git/2.47.0 (runbun.dev git proxy)" });
  for (const h of FORWARD) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  let res: Response;
  try {
    res = await fetchFn(`https://${host}${path}${url.search}`, {
      method: req.method,
      headers,
      body: exchange ? await req.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch (e) {
    return fail(502, `couldn't reach ${host}: ${e instanceof Error ? e.message : e}`);
  }
  // A moved repository: say where it went rather than follow it off the allowed hosts.
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location");
    return fail(404, `the repository moved${to ? ` to ${to}` : ""}`);
  }
  const out = new Headers({ "cache-control": "no-store" });
  // Not www-authenticate: on a 401 the browser would put up its own login dialog. git.wasm reads the status.
  const type = res.headers.get("content-type");
  if (type) out.set("content-type", type);
  return new Response(res.body, { status: res.status, headers: out });
}
