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
  stream: () => new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("abc")), c.close()) })),
};
// Streams that fail: before Bun sends the head (with the first chunk and what is ready with it), or after.
const failing: Record<string, () => ReadableStream> = {
  "error at once": () => new ReadableStream({ start: (c) => c.error(new Error("x")) }),
  "error after a chunk": () => new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("before ")), c.error(new Error("x"))) }),
  "error later": () => {
    let n = 0;
    return new ReadableStream({
      async pull(c) {
        if (n++ === 0) return c.enqueue(new TextEncoder().encode("before "));
        await new Promise((r) => setTimeout(r, 50));
        throw new Error("x");
      },
    });
  },
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
    if (u.pathname.startsWith("/failing/")) return new Response(failing[decodeURIComponent(u.pathname.slice(9))]());
    if (u.pathname === "/form") return Response.json([...(await req.formData())].map(([k, v]) => (typeof v === "string" ? [k, v] : [k, v.name, v.type, v.size])));
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
    log(`served ${method} ${kind}:`, r.status, r.headers.get("content-type"), r.headers.get("content-length"), JSON.stringify(await r.text()));
  }
{
  // A file part is typed by its name, as Bun parses it; a Bun.file is a File named by its path.
  const fd = new FormData();
  fd.set("text", "plain");
  fd.set("doc", new File(["x"], "a.txt", { type: "text/plain" }));
  fd.set("other", new File(["y"], "b.zzz", { type: "text/plain" }));
  fd.set("src", Bun.file("main.ts"));
  log("multipart:", await fetch("http://localhost:3011/form", { method: "POST", body: fd }).then((r) => r.text()));
  log("bun file in form:", (fd.get("src") as File).name, fd.get("src") instanceof File);
}
for (const kind of Object.keys(failing)) {
  let text = "";
  try {
    const r = await fetch(`http://localhost:3011/failing/${kind}`);
    text = `${r.status} `;
    for await (const chunk of r.body!) text += new TextDecoder().decode(chunk);
    log(`${kind}:`, text, "(ended)");
  } catch (e: any) {
    log(`${kind}:`, text, "!", e.name, e.code);
  }
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
// node:http servers of this program, on the port each listens on (0: one of its own), reached by both clients.
{
  const named = (name: string) => http.createServer((req, res) => res.writeHead(200, { "x-server": name }).end(`${name} ${req.method} ${req.url} ${req.headers.host}`));
  const listening = (s: http.Server, ...a: unknown[]) => new Promise<void>((r) => s.listen(...(a as []), () => r()));
  const fixed = named("fixed");
  const any = named("any");
  await listening(fixed, 3013);
  await listening(any, 0);
  const port = (any.address() as { port: number }).port;
  log("node listen:", JSON.stringify(fixed.address()), port > 0 && port !== 3013, (any.address() as { family: string }).family);
  log("node fetch:", await fetch("http://localhost:3013/a?b=1").then(async (r) => `${r.status} ${r.headers.get("x-server")} ${await r.text()}`));
  log("node fetch port 0:", await fetch(`http://127.0.0.1:${port}/c`, { method: "POST", body: "x" }).then(async (r) => (await r.text()).replace(String(port), "<port>")));
  await new Promise<void>((done) => {
    http.get("http://localhost:3013/d", async (res) => {
      log("node http.get:", res.statusCode, res.headers["x-server"], await read(res));
      done();
    });
  });
  await new Promise<void>((done) => {
    const req = http.request({ port, path: "/e", method: "PUT" }, async (res) => {
      log("node http.request port 0:", res.statusCode, (await read(res)).startsWith("any PUT /e"));
      done();
    });
    req.end("body");
  });
  for (const [name, p] of [["node", 3013], ["Bun.serve", 3011]] as const) {
    const taken = http.createServer();
    log(`node listen on a ${name} port:`, await new Promise((r) => (taken.on("error", (e: any) => r(`${e.code} ${e.syscall} ${e.message}`)), taken.listen(p, () => r("listening")))));
  }
  log("Bun.serve on a node port:", (() => {
    try {
      return Bun.serve({ port: 3013, fetch: () => new Response() }) && "served";
    } catch (e: any) {
      return `${e.code} ${e.message}`;
    }
  })());
  await new Promise((r) => fixed.close(r));
  any.close();
  // The port is free again (a fetch to it would go to the browser's network here, not fail as ECONNREFUSED).
  const again = named("again");
  await listening(again, 3013);
  log("node listen after close:", await fetch("http://localhost:3013/f").then((r) => r.text()));
  again.close();
}
// Packages Bun has its own of (none is installed here): undici, node-fetch, isomorphic-fetch, @vercel/fetch over fetch.
{
  const nodeFetch: any = (await import("node-fetch" as string)).default;
  const r = await nodeFetch("http://localhost:3011/echo?nf=1", { method: "POST", body: "x", headers: { "x-test": "nf" } });
  log("node-fetch:", r.status, r.ok, r.type, r.headers.raw()["set-cookie"], typeof r.body.pipe, await r.json().then((j: any) => [j.method, j.path, j.x, j.body]));
  let s = "";
  for await (const c of (await nodeFetch("http://localhost:3011/stream")).body) s += c;
  log("node-fetch stream:", s);
  const empty = await nodeFetch("http://localhost:3011/empty");
  log("node-fetch 204:", empty.status, empty.body !== null, await empty.json().catch((e: Error) => e.name));
  const nf = await nodeFetch("http://localhost:3011/nope");
  log("node-fetch 404:", nf.status, nf.ok, nf.type, (await nf.buffer()).toString());
  log("node-fetch exports:", nodeFetch.isRedirect(301), nodeFetch.isRedirect(200), new nodeFetch.Request("/x").url, new nodeFetch.FetchError("m", "t", { code: "E" }).code, new nodeFetch.AbortError("a").name, nodeFetch.default === nodeFetch);
  log("node-fetch require:", require("node-fetch") === nodeFetch, require("next/dist/compiled/node-fetch") === nodeFetch, require.resolve("node-fetch"), import.meta.resolve("node-fetch"));
}
{
  const undici: any = await import("undici" as string);
  const { statusCode, headers, body } = await undici.request("http://localhost:3011/echo?u=1", { method: "PUT", body: "u", headers: { "x-test": "u" } });
  log("undici request:", statusCode, headers["x-custom"], headers["set-cookie"], body.bodyUsed, await body.json().then((j: any) => [j.method, j.path, j.x, j.body]), body.bodyUsed);
  let s = "";
  for await (const c of (await undici.request("http://localhost:3011/stream")).body) s += c;
  log("undici stream:", s);
  const q = await undici.request(new URL("http://localhost:3011/echo"), { query: { a: "1" } });
  log("undici query:", JSON.parse(await q.body.text()).path);
  const f = await undici.fetch("http://localhost:3011/body/json");
  log("undici fetch:", f.status, await f.text(), undici.Headers === Headers, undici.Response === Response, undici.FormData === FormData);
  log("undici errors:", new undici.errors.SocketError("x") instanceof undici.errors.UndiciError, new undici.errors.RequestAbortedError() instanceof undici.errors.AbortError);
  log("undici names:", Object.keys(undici.default).length, typeof undici.Agent, typeof undici.WebSocket, undici.default === undici.default.default);
  const m = require("module");
  log("undici resolve:", m.isBuiltin("undici"), m.isBuiltin("ws"), m.isBuiltin("node-fetch"), m.builtinModules.includes("undici"), Bun.resolveSync("undici", "."), import.meta.resolve("next/dist/compiled/undici"), require.resolve("ws/lib/websocket"));
}
{
  const iso: any = (await import("isomorphic-fetch" as string)).default;
  log("isomorphic-fetch:", await (await iso("http://localhost:3011/body/string")).text(), iso.fetch === iso, iso.name);
  const vf = (await import("@vercel/fetch" as string)).default();
  log("@vercel/fetch:", JSON.parse(await (await vf("http://localhost:3011/echo", { method: "POST", body: { a: 1 } })).text()).ct);
  const AC = require("abort-controller");
  log("abort-controller:", AC === AbortController, AC.AbortSignal === AbortSignal, AC.default === AC, (await import("abort-controller/polyfill" as string)).AbortController === AbortController);
  const valid = require("utf-8-validate");
  log("utf-8-validate:", valid(Buffer.from("h" + String.fromCharCode(233) + "llo")), valid(Buffer.from([0xff])), valid.name, valid.length);
  log("ws/lib/websocket:", require("ws/lib/websocket") === require("ws"), process.getBuiltinModule("isomorphic-fetch") === iso);
}
// A WebSocket to this program's own server, as Bun's client connects to it.
const sockets = Bun.serve({
  port: 3012,
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/refuse") return new Response("no", { status: 400 });
    const data = { url: req.url, protocol: req.headers.get("sec-websocket-protocol"), host: req.headers.get("host") };
    if (!srv.upgrade(req, { data })) return new Response("plain");
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify(ws.data));
      ws.send(new Uint8Array([1, 2]));
      ws.send(7 as never);
    },
    message(ws, m) {
      if (m === "close") ws.close(4001, "server bye");
      else ws.send(typeof m === "string" ? `echo ${m}` : `bin ${m.constructor.name} ${m.byteLength}`);
    },
    close(_ws, code, reason) {
      log("server close:", code, JSON.stringify(reason));
    },
  },
});
const wsEvents = (ws: WebSocket, ms = 300) =>
  new Promise<string[]>((resolve) => {
    const events: string[] = [];
    ws.onopen = () => events.push(`open ${ws.readyState} ${JSON.stringify(ws.protocol)}`);
    ws.onmessage = (e) => events.push(`message ${typeof e.data === "string" ? e.data : `${e.data.constructor.name} ${e.data.byteLength ?? e.data.size}`} ${e.origin}`);
    ws.onerror = () => events.push("error");
    ws.onclose = (e) => events.push(`close ${e.code} ${JSON.stringify(e.reason)} ${e.wasClean} ${ws.readyState}`);
    setTimeout(() => resolve(events), ms);
  });
{
  const ws = new WebSocket("ws://localhost:3012/a?x=1", ["p1", "p2"]);
  log("ws:", ws.readyState, ws.binaryType, ws.url, JSON.stringify(ws.protocol), ws instanceof WebSocket);
  const events = wsEvents(ws);
  ws.addEventListener("open", () => {
    ws.send("hi");
    ws.send(new Uint8Array([9, 9, 9]));
    ws.send(new Blob(["blob"]));
    ws.send("close");
  });
  for (const e of await events) log("ws event:", e);
}
{
  const ws = new WebSocket("ws://localhost:3012/b");
  ws.binaryType = "arraybuffer";
  const events = wsEvents(ws);
  ws.addEventListener("open", () => (ws.close(), log("ws after close():", ws.readyState)));
  for (const e of await events) log("ws arraybuffer event:", e);
}
for (const e of await wsEvents(new WebSocket("ws://localhost:3012/refuse"))) log("ws refused:", e);
log("ws send while connecting:", (() => {
  const ws = new WebSocket("ws://localhost:3012/c");
  try {
    ws.send("x");
  } catch (e: any) {
    return e.name;
  } finally {
    ws.close();
  }
})());
await Bun.sleep(100);
sockets.stop(true);
server.stop(true);
log("__end__");
