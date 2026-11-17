// The program http-request.ts runs natively and in the playground: node:http / node:https clients against a Bun.serve
// of the same program. Its printed lines must match.
import http from "node:http";
import https from "node:https";

// What Bun.serve adds to each kind of body: a content type, the length where it is known before sending.
const bodies: Record<string, () => Response> = {
  string: () => new Response("hello"),
  null: () => new Response(null),
  bytes: () => new Response(new Uint8Array([1, 2, 3])),
  "typed-blob": () => new Response(new Blob(["xy"], { type: "text/x" })),
  json: () => Response.json({ a: 1 }),
  "explicit-type": () => new Response("x", { headers: { "content-type": "text/html" } }),
  "wrong-length": () => new Response("hello", { headers: { "content-length": "3" } }),
  "body-stream": () => new Response(new Response("piped").body),
  "no-content": () => new Response(null, { status: 204 }),
};

const server = Bun.serve({
  port: 3011,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/echo") {
      const body = await req.text();
      return Response.json(
        { method: req.method, path: u.pathname + u.search, x: req.headers.get("x-test"), auth: req.headers.get("authorization"), ct: req.headers.get("content-type"), body },
        { status: 201, headers: [["x-custom", "hi"], ["set-cookie", "a=1"], ["set-cookie", "b=2"]] },
      );
    }
    if (u.pathname === "/slow") return new Promise((r) => setTimeout(() => r(new Response("late")), 600));
    if (u.pathname === "/stream")
      return new Response(
        new ReadableStream({
          async start(c) {
            for (const s of ["one,", "two,", "three"]) {
              c.enqueue(new TextEncoder().encode(s));
              await new Promise((r) => setTimeout(r, 30));
            }
            c.close();
          },
        }),
      );
    if (u.pathname === "/empty") return new Response(null, { status: 204 });
    if (u.pathname.startsWith("/moved/")) return new Response(null, { status: Number(u.pathname.slice(7)), headers: { location: "/echo?moved=1" } });
    if (u.pathname === "/loop") return Response.redirect("/loop", 302);
    if (u.pathname.startsWith("/body/")) return bodies[u.pathname.slice(6)]();
    return new Response("nf", { status: 404 });
  },
});

const log = (...a: unknown[]) => console.log(...a);
const read = (res: any) =>
  new Promise<string>((ok, bad) => {
    let s = "";
    res.setEncoding("utf8");
    res.on("data", (d: string) => (s += d));
    res.on("end", () => ok(s));
    res.on("error", bad);
  });

log("start");
await new Promise<void>((done) => {
  http.get("http://localhost:3011/echo?q=1", async (res) => {
    log("get:", res.statusCode, res.statusMessage, res.headers["x-custom"], res.headers["set-cookie"], res.headers["content-type"], res.httpVersion, res.complete);
    log("rawHeaders has x-custom:", res.rawHeaders.includes("x-custom"), res.rawHeaders.length % 2);
    log("get body:", await read(res));
    log("complete:", res.complete);
    done();
  });
});
await new Promise<void>((done) => {
  const req = http.request(
    { hostname: "localhost", port: 3011, path: "/echo", method: "post", headers: { "X-Test": "yes", "Content-Type": "text/plain" }, auth: "user:pw" },
    async (res) => {
      log("post:", res.statusCode, await read(res));
    },
  );
  req.on("finish", () => log("finish"));
  req.on("close", () => {
    log("req close");
    done();
  });
  log("getHeader:", req.getHeader("x-test"), req.getHeader("content-type"));
  req.setHeader("x-extra", "1");
  req.removeHeader("x-extra");
  log("hasHeader:", req.hasHeader("x-extra"), req.method, req.path);
  req.write("hello ");
  req.end("world");
});
await new Promise<void>((done) => {
  http
    .request(new URL("http://localhost:3011/echo"), { method: "PUT" }, async (res) => {
      log("url+opts:", await read(res));
      done();
    })
    .end("body");
});
await new Promise<void>((done) => {
  http.get({ host: "localhost", port: 3011, path: "/stream" }, async (res) => {
    log("stream:", await read(res));
    done();
  });
});
await new Promise<void>((done) => {
  http.get("http://localhost:3011/empty", async (res) => {
    log("204:", res.statusCode, JSON.stringify(await read(res)));
    done();
  });
});
await new Promise<void>((done) => {
  http
    .request("http://localhost:3011/echo", { method: "HEAD" }, async (res) => {
      log("head:", res.statusCode, JSON.stringify(await read(res)));
      done();
    })
    .end();
});
await new Promise<void>((done) => {
  http.get("http://localhost:3011/moved/302", async (res) => {
    log("redirect not followed:", res.statusCode, res.headers.location, await read(res));
    done();
  });
});
for (const kind of Object.keys(bodies))
  for (const method of ["GET", "HEAD"]) {
    const r = await fetch(`http://localhost:3011/body/${kind}`, { method });
    log(`served ${method} ${kind}:`, r.status, r.headers.get("content-type"), kind === "body-stream" ? "" : r.headers.get("content-length"), JSON.stringify(await r.text()));
  }
// fetch() follows redirects to this program's own server as Bun's does.
for (const [status, method] of [[301, "POST"], [302, "PUT"], [303, "PUT"], [307, "POST"], [308, "PATCH"]] as const) {
  const r = await fetch(`http://localhost:3011/moved/${status}`, { method, body: "data", headers: { "content-type": "text/x" } });
  log(`fetch ${status} ${method}:`, r.status, r.redirected, r.url, await r.text());
}
for (const redirect of ["manual", "error"] as const) {
  const r = await fetch("http://localhost:3011/moved/302", { redirect }).catch((e) => e);
  log(`fetch redirect ${redirect}:`, r instanceof Error ? `${r.name} ${(r as any).code}` : `${r.status} ${r.redirected} ${r.headers.get("location")}`);
}
log("fetch redirect loop:", await fetch("http://localhost:3011/loop").then((r) => r.status, (e) => `${e.name} ${e.code}`));
await new Promise<void>((done) => {
  http.get("http://localhost:3011/nope", async (res) => {
    log("404:", res.statusCode, res.statusMessage, res.headers["content-type"], await read(res));
    done();
  });
});
await new Promise<void>((done) => {
  const req = http.get("http://localhost:3011/slow", () => log("slow responded (unexpected)"));
  req.setTimeout(100, () => {
    log("timeout event");
    req.destroy();
  });
  req.on("error", (e: any) => log("timeout error:", e.code, e.message));
  req.on("close", () => {
    log("timeout close");
    done();
  });
});
await new Promise<void>((done) => {
  const req = http.get("http://localhost:3011/slow", () => log("slow responded (unexpected)"));
  req.on("abort", () => log("abort event"));
  req.on("error", (e: any) => log("abort error:", e.code, e.message));
  req.on("close", () => {
    log("abort close");
    done();
  });
  setTimeout(() => req.abort(), 50);
});
await new Promise<void>((done) => {
  const ac = new AbortController();
  const req = http.get("http://localhost:3011/slow", { signal: ac.signal });
  req.on("error", (e: any) => log("signal error:", e.name, e.code));
  req.on("close", () => {
    log("signal close");
    done();
  });
  setTimeout(() => ac.abort(), 50);
});
await new Promise<void>((done) => {
  const req = http.get("http://localhost:1/", () => log("refused responded (unexpected)"));
  req.on("error", (e: any) => {
    log("refused:", e.code);
    done();
  });
});
try {
  https.get("http://localhost:3011/");
} catch (e: any) {
  log("https with http url:", e.code);
}
try {
  http.get("https://localhost:3011/");
} catch (e: any) {
  log("http with https url:", e.code);
}
log("agent:", typeof http.Agent, typeof http.globalAgent, typeof https.globalAgent, http.get instanceof Function, https.request instanceof Function);
const r2 = http.request("http://localhost:3011/echo", { agent: new http.Agent({ keepAlive: true }) });
log("instance:", r2 instanceof http.ClientRequest, r2 instanceof http.OutgoingMessage, typeof r2.write);
r2.on("response", async (res) => {
  log("agent opt:", res.statusCode, res instanceof http.IncomingMessage);
  await read(res);
});
await new Promise<void>((done) => {
  r2.on("close", () => done());
  r2.end();
});
if (Bun.env.NET) {
  await new Promise<void>((done) => {
    https
      .get("https://api.github.com/zen", { headers: { "user-agent": "t" } }, async (res) => {
        log("real https:", res.statusCode, res.headers["content-type"], (await read(res)).length > 5);
        done();
      })
      .on("error", (e: any) => {
        log("real https error:", e.code);
        done();
      });
  });
}
server.stop(true);
log("__end__");
