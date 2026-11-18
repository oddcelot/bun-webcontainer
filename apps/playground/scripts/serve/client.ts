// What a client of server.ts sees (scripts/serve.ts): run in the preview page, and in native Bun against the same
// program. `http` is where the server is (the preview's base path in the page), `ws` the same for WebSockets.
// Self-contained: the harness hands its source to the page.
export async function client(http: string, ws: string): Promise<string[]> {
  const lines: string[] = ((globalThis as { clientLines?: string[] }).clientLines = []);
  const log = (...a: unknown[]) => lines.push(a.join(" "));
  const get = async (path: string, init?: RequestInit) => {
    let r: Response;
    try {
      r = await fetch(http + path, init);
    } catch {
      return "rejected";
    }
    const head = `${r.status} ${r.headers.get("content-type")}`;
    const body = await r.text().catch(() => undefined);
    if (body === undefined) return `${head}, body rejected`;
    return `${head} ${body.includes("<title>Internal Server Error</title>") ? "<error page>" : JSON.stringify(body)}`;
  };
  log("throw", await get("/throw"));
  log("handled", await get("/handled"));
  log("body of 16", await get("/body", { method: "POST", body: "x".repeat(16) }));
  log("body of 17", await get("/body", { method: "POST", body: "x".repeat(17) }));
  log("requestIP", await get("/ip"));

  // A stream's head goes out with its first chunk (or its end); one that fails before it resets the connection.
  let t0 = performance.now();
  const late = await fetch(http + "/late");
  log("late: head waits for the first chunk", performance.now() - t0 >= 300, late.status, JSON.stringify(await late.text()));
  t0 = performance.now();
  const sse = await fetch(http + "/sse");
  const reader = sse.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  log("sse: first chunk at once", performance.now() - t0 < 600, sse.status, JSON.stringify(first));
  await reader.cancel();
  for (const p of ["/fail-early", "/fail-sync"]) log(p, await get(p));
  try {
    const r = await fetch(http + "/fail-later");
    log("/fail-later head", r.status);
    log("/fail-later body", await r.text().then(() => "read", () => "rejected"));
  } catch {
    log("/fail-later rejected");
  }

  // WebSockets: messages both ways, text and binary, pub/sub across sockets, close codes from either side.
  type Sock = WebSocket & { inbox: string[]; wake?: () => void };
  const open = (path: string, protocols?: string[]) =>
    new Promise<Sock>((resolve, reject) => {
      const s = new WebSocket(ws + path, protocols) as Sock;
      s.binaryType = "arraybuffer";
      s.inbox = [];
      s.onmessage = (e) => {
        s.inbox.push(typeof e.data === "string" ? e.data : `binary ${[...new Uint8Array(e.data)].join(",")}`);
        s.wake?.();
      };
      s.onopen = () => resolve(s);
      s.onerror = () => reject(new Error("refused"));
    });
  const next = async (s: Sock) => {
    while (!s.inbox.length) await new Promise<void>((r) => (s.wake = r));
    return s.inbox.shift();
  };
  const closed = (s: Sock) => new Promise<string>((r) => s.addEventListener("close", (e) => r(`${e.code} ${JSON.stringify(e.reason)}`)));
  const a = await open("/ws?name=a");
  log("a:", await next(a));
  const b = await open("/ws?name=b", ["chat", "other"]);
  log("b:", await next(b), "protocol", JSON.stringify(b.protocol));
  log("a:", await next(a));
  const c = await open("/ws?name=c");
  log("c:", await next(c));
  log("a:", await next(a), "b:", await next(b));
  a.send("hi");
  log("a:", await next(a), "b:", await next(b), "c:", await next(c));
  a.send(new Uint8Array([1, 2, 3]));
  log("a:", await next(a), await next(a), "b:", await next(b), "c:", await next(c));
  const bClosed = closed(b);
  b.send("close-me");
  log("b closed:", await bClosed, "a:", await next(a), "c:", await next(c));
  const aClosed = closed(a);
  a.close(4001, "bye");
  log("a closed:", await aClosed, "c:", await next(c));
  c.close();
  log("no upgrade:", await open("/nows").then(() => "opened", (e: Error) => e.message));
  return lines;
}

/** For node.ts: a node:http server's "upgrade" accepted with `ws`. */
export async function nodeClient(ws: string): Promise<string[]> {
  const lines: string[] = ((globalThis as { clientLines?: string[] }).clientLines = []);
  const log = (...a: unknown[]) => lines.push(a.join(" "));
  type Sock = WebSocket & { inbox: string[]; wake?: () => void };
  const open = (path: string) =>
    new Promise<Sock>((resolve, reject) => {
      const s = new WebSocket(ws + path) as Sock;
      s.binaryType = "arraybuffer";
      s.inbox = [];
      s.onmessage = (e) => {
        s.inbox.push(typeof e.data === "string" ? e.data : `binary ${[...new Uint8Array(e.data)].join(",")}`);
        s.wake?.();
      };
      s.onopen = () => resolve(s);
      s.onerror = () => reject(new Error("refused"));
    });
  const next = async (s: Sock) => {
    while (!s.inbox.length) await new Promise<void>((r) => (s.wake = r));
    return s.inbox.shift();
  };
  const a = await open("/a");
  const b = await open("/b");
  log("a:", await next(a), "b:", await next(b));
  a.send("hi");
  log("a:", await next(a), "b:", await next(b));
  a.send(new Uint8Array([1, 2, 3]));
  log("a:", await next(a));
  const bClosed = new Promise<string>((r) => b.addEventListener("close", (e) => r(`${e.code} ${JSON.stringify(e.reason)}`)));
  a.close(4001, "bye");
  log("b:", await next(b));
  b.send("close-me");
  log("b closed:", await bClosed);
  return lines;
}
