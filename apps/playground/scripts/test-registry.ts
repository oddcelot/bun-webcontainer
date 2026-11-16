// A registry for the tests of .npmrc (scripts/lockfile-write.ts, scripts/workspaces.ts): npm's own, relayed, with the
// tarball URLs in what it serves pointing back here, and CORS open so a page of another origin can use it. A process of
// its own, as native Bun is run with the test blocked on it. Prints `port <n>` first; GET /__log lists what it was
// asked for (`GET /path auth=<Authorization or ->`); a request with `authorization: Bearer secret` is the only one to
// get anything when started with --auth.
//   bun scripts/test-registry.ts [port] [--auth]
const requireAuth = process.argv.includes("--auth");
const log: string[] = [];
const server = Bun.serve({
  port: Number(process.argv.find((a, i) => i > 1 && /^\d+$/.test(a)) ?? 0),
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, accept, content-type" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (pathname === "/__log") return new Response(log.join("\n"), { headers: cors });
    const auth = req.headers.get("authorization");
    log.push(`${req.method} ${pathname} auth=${auth ?? "-"}`);
    if (requireAuth && auth !== "Bearer secret") return new Response("unauthorized", { status: 401, headers: cors });
    const up = await fetch(`https://registry.npmjs.org${pathname}`, { headers: { accept: req.headers.get("accept") ?? "*/*" } });
    const headers: Record<string, string> = { ...cors, "content-type": up.headers.get("content-type") ?? "application/octet-stream" };
    if (pathname.endsWith(".tgz")) return new Response(up.body, { status: up.status, headers });
    return new Response((await up.text()).replaceAll("https://registry.npmjs.org", `http://localhost:${server.port}`), { status: up.status, headers });
  },
});
console.log(`port ${server.port}`);
