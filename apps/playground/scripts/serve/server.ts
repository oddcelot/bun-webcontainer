// Bun.serve as its clients see it (scripts/serve.ts): what loopback fetches get from failing handlers and the error
// handler, then a server on port 3000 for the preview page's checks (client.ts). Prints the same lines in native Bun.
const show = async (label: string, r: Response) => {
  const body = await r.text();
  const shown = body.includes("<title>Internal Server Error</title>") ? "<error page>" : JSON.stringify(body);
  console.log(label, r.status, r.headers.get("content-type"), shown);
};
console.log("start");

for (const development of [true, false]) {
  const s = Bun.serve({
    port: 0,
    development,
    routes: { "/route": () => Promise.reject(new Error("route")) },
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/throw") throw new Error("boom");
      if (p === "/reject") return Promise.reject(new Error("rejected"));
      if (p === "/string") return "hi" as never;
      return new Response("ok");
    },
  });
  console.log("development", development, s.development);
  for (const p of ["/throw", "/reject", "/route", "/string", "/"]) await show(`no error handler, ${development ? "dev" : "prod"} ${p}`, await fetch(s.url + p.slice(1)));
  s.stop(true);
}

const handled = Bun.serve({
  port: 0,
  development: false,
  routes: { "/route": () => Promise.reject(new Error("route")) },
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/value") throw "a string";
    throw new Error(p.slice(1));
  },
  error(this: unknown, err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    if (m === "error-throws") throw new Error("from error");
    if (m === "error-returns-string") return "nope" as never;
    if (m === "error-async") return Promise.resolve(new Response(`async ${m}`, { status: 502 }));
    return new Response(`handled ${m} this=${this === handled}`, { status: 418, headers: { "x-handled": "1" } });
  },
});
for (const p of ["/sync", "/route", "/value", "/error-throws", "/error-returns-string", "/error-async"]) await show(`error handler ${p}`, await fetch(handled.url + p.slice(1)));
handled.reload({ fetch: () => Promise.reject(new Error("again")), error: (e: unknown) => new Response(`reloaded ${(e as Error).message}`, { status: 503 }) });
await show("reloaded error handler", await fetch(handled.url));
handled.stop(true);

const limits = Bun.serve({
  port: 0,
  maxRequestBodySize: 10,
  idleTimeout: 0,
  reusePort: true,
  async fetch(req, server) {
    if (new URL(req.url).pathname === "/ip") {
      const ip = server.requestIP(req);
      return Response.json({ address: ip?.address, family: ip?.family, port: typeof ip?.port, timeout: server.timeout(req, 5) ?? null });
    }
    return new Response(`read ${(await req.text()).length}`);
  },
});
for (const n of [10, 11]) {
  const r = await fetch(limits.url, { method: "POST", body: "x".repeat(n) });
  console.log(`maxRequestBodySize 10, body ${n}:`, r.status, JSON.stringify([...r.headers].filter(([k]) => k !== "date" && k !== "content-length")), JSON.stringify(await r.text()));
}
await show("requestIP via localhost", await fetch(limits.url + "ip"));
await show("requestIP via 127.0.0.1", await fetch(`http://127.0.0.1:${limits.port}/ip`));
console.log("requestIP of a request it didn't get", limits.requestIP(new Request("http://localhost/")));
limits.stop(true);
for (const idleTimeout of [-1, 0, 255, 256, 1.5, "5"]) {
  try {
    Bun.serve({ port: 0, idleTimeout: idleTimeout as number, fetch: () => new Response() }).stop(true);
    console.log("idleTimeout", JSON.stringify(idleTimeout), "ok");
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log("idleTimeout", JSON.stringify(idleTimeout), err.name, err.code, err.message);
  }
}
const unix = Bun.serve({ unix: "serve.sock", fetch: (req, server) => Response.json({ url: req.url, ip: server.requestIP(req) }) });
console.log("unix server", unix.port, unix.hostname, String(unix.url));
await show("fetch over unix", await fetch("http://localhost/x?y", { unix: "serve.sock" } as RequestInit));
try {
  await fetch("http://localhost/", { unix: "none.sock" } as RequestInit);
} catch (e) {
  const err = e as Error & { code?: string };
  console.log("fetch over a missing socket", err.name, err.code, err.message);
}
try {
  Bun.serve({ unix: "serve.sock", fetch: () => new Response() });
} catch (e) {
  const err = e as Error & { code?: string };
  console.log("a socket in use", err.code, err.message);
}
unix.stop(true);

const enc = new TextEncoder();
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
const server = Bun.serve({
  port: Number(process.env.SERVE_PORT ?? 3000),
  fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/throw") throw new Error("preview boom");
    if (p === "/handled") throw new Error("handled");
    if (p === "/ws" && server.upgrade(req, { data: { name: url.searchParams.get("name") } })) return undefined as never;
    if (p === "/nows") return new Response("no upgrade", { status: 400 });
    if (p === "/") return new Response("<!doctype html><title>serve</title>", { headers: { "content-type": "text/html" } });
    if (p === "/late")
      return new Response(
        new ReadableStream({
          async start(c) {
            await later(400);
            c.enqueue(enc.encode("data: late\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (p === "/sse")
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(enc.encode("data: 1\n\n"));
            await later(800);
            c.enqueue(enc.encode("data: 2\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (p === "/fail-early")
      return new Response(
        new ReadableStream({
          async pull(c) {
            await later(100);
            c.error(new Error("early"));
          },
        }),
      );
    if (p === "/fail-sync") return new Response(new ReadableStream({ start: (c) => c.error(new Error("at once")) }));
    if (p === "/fail-later")
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(enc.encode("first"));
            await later(100);
            c.error(new Error("later"));
          },
        }),
      );
    return new Response("not found", { status: 404 });
  },
  // Answers for /handled; for /throw it returns nothing, so Bun's development error page answers.
  error: (err) => ((err as Error).message === "handled" ? new Response("handled by error", { status: 418 }) : undefined) as never,
  websocket: {
    open(ws) {
      const { name } = ws.data as { name: string };
      ws.subscribe("room");
      ws.send(`hello ${name}`);
      ws.publish("room", `${name} joined`);
    },
    message(ws, m) {
      const { name } = ws.data as { name: string };
      if (m === "close-me") return ws.close(4002, "server bye");
      if (typeof m === "string") {
        ws.send(`echo ${m}`);
        ws.publish("room", `${name}: ${m}`);
      } else {
        ws.send(new Uint8Array([...m].reverse()));
        server.publish("room", m);
      }
    },
    close(ws, code, reason) {
      const { name } = ws.data as { name: string };
      server.publish("room", `${name} left ${code} ${reason}`);
    },
  },
});
console.log("listening");
