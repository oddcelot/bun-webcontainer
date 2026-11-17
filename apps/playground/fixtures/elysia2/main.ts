// Starts app.ts and drives every feature over real HTTP, a WebSocket client, `app.handle()` and Eden, printing one
// deterministic line per case (`label: result`). Native Bun's lines are what the playground must print.
import { treaty } from "@elysia/eden";
import { app, log } from "./app.ts";

app.listen(0);
const port = app.server!.port;
const base = `http://localhost:${port}`;

/** Status, content type, the named headers and the body: one line. */
const show = async (res: Response, headers: string[] = []) => {
  const picked = headers.map(
    (h) =>
      `${h}=${h === "set-cookie" ? JSON.stringify(res.headers.getSetCookie()) : res.headers.get(h)}`,
  );
  const body = (await res.text()).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return [
    res.status,
    res.headers.get("content-type") ?? "-",
    ...picked,
    body,
  ].join(" ");
};
const get = (path: string, init?: RequestInit, headers?: string[]) =>
  fetch(base + path, init).then((r) => show(r, headers));
const json = (
  method: string,
  path: string,
  body: unknown,
  headers?: string[],
) =>
  get(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    headers,
  );

const run = async (label: string, f: () => unknown) => {
  try {
    console.log(`${label}: ${await f()}`);
  } catch (e) {
    console.log(`${label}: ! ${(e as Error).name} ${(e as Error).message}`);
  }
};

/** Waits until /log has a line matching `match` (hooks that run after the response is sent). */
const waitLog = async (match: (l: string) => boolean) => {
  for (let i = 0; i < 100 && !log.some(match); i++) await Bun.sleep(10);
  return log.filter(match).join(" | ") || "(nothing logged)";
};

/** A WebSocket that queues what it receives. */
const socket = (path: string) => {
  const ws = new WebSocket(`ws://localhost:${port}${path}`);
  const got: string[] = [];
  let wake = () => {};
  ws.onmessage = (e) => {
    got.push(
      typeof e.data === "string"
        ? e.data
        : `<binary ${(e.data as ArrayBuffer).byteLength}>`,
    );
    wake();
  };
  const closed = new Promise<string>(
    (resolve) => (ws.onclose = (e) => resolve(`close ${e.code} ${e.reason}`)),
  );
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`could not connect to ${path}`));
  });
  /** The next `n` messages, or what came before the timeout. */
  const next = async (n = 1, ms = 2000) => {
    const end = Date.now() + ms;
    while (got.length < n && Date.now() < end)
      await new Promise<void>((r) => ((wake = r), setTimeout(r, 20)));
    return got.splice(0, n);
  };
  return { ws, opened, closed, next };
};

// Routing ------------------------------------------------------------------------------------------------------------
await run("index", () => get("/", undefined, ["x-powered-by", "x-on-request"]));
await run("json", () => get("/json"));
await run("param", () => get("/user/42"));
await run("optional param absent", () => get("/user/42/post"));
await run("optional param present", () => get("/user/42/post/hello"));
await run("encoded param", () => get("/user/a%20b"));
await run("wildcard", () => get("/files/a/b/c.txt"));
await run("group", () => get("/v1/ping"));
await run("nested group", () => get("/v1/nested/deep"));
await run("trailing slash", () => get("/v1/ping/"));
await run("all GET", () => get("/any"));
await run("all DELETE", () => get("/any", { method: "DELETE" }));
await run("custom method", () => get("/dav", { method: "PROPFIND" }));
await run("put", () => json("PUT", "/put", { a: 1 }));
await run("patch", () => json("PATCH", "/patch", { b: 2 }));
await run("delete", () => get("/delete", { method: "DELETE" }));
await run("head", () => get("/head", { method: "HEAD" }, ["x-head"]));
await run("head on get route", () =>
  get("/json", { method: "HEAD" }, ["content-length"]),
);
await run("not found", () => get("/nope"));
await run("method not allowed", () => get("/json", { method: "POST" }));
await run("lazy plugin", () => get("/lazy"));
await run("static plugin", () => get("/public/hello.txt"));
await run("static plugin missing", () => get("/public/missing.txt"));

// Context ------------------------------------------------------------------------------------------------------------
await run("context", () =>
  get("/context", { headers: { "x-who": "tester", "accept-language": "de" } }),
);
await run("context again", () => get("/context"));

// Plugins and scopes -------------------------------------------------------------------------------------------------
await run("named dedupe and seeds", () =>
  get("/", undefined, ["x-named", "x-seeded"]),
);
await run("scope child", () =>
  get("/scope/child", undefined, ["x-local", "x-plugin", "x-global"]),
);
await run("scope parent", () =>
  get("/scope/parent", undefined, ["x-local", "x-plugin", "x-global"]),
);
await run("scope app", () =>
  get("/json", undefined, ["x-local", "x-plugin", "x-global"]),
);
await run("todos list", () => get("/todos"));
await run("todos by id", () => get("/todos/1"));
await run("todos missing", () => get("/todos/99"));
await run("todos bad id", () => get("/todos/abc"));
await run("todos post unauthorized", () =>
  json("POST", "/todos", { title: "x" }),
);
await run("todos post", () =>
  get("/todos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer bob-token",
    },
    body: JSON.stringify({ title: "second" }),
  }),
);
await run("todos post invalid", () =>
  get("/todos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer bob-token",
    },
    body: JSON.stringify({ title: "" }),
  }),
);
await run("todos delete as user", () =>
  get("/todos", {
    method: "DELETE",
    headers: { authorization: "Bearer bob-token" },
  }),
);
await run("todos delete as admin", () =>
  get("/todos", {
    method: "DELETE",
    headers: { authorization: "Bearer ada-token" },
  }),
);

// Validation ---------------------------------------------------------------------------------------------------------
await run("body ok", () =>
  json("POST", "/validate/body", {
    name: "Ada",
    age: 36,
    email: "ada@example.com",
    extra: true,
  }),
);
await run("body defaults", () =>
  json("POST", "/validate/body", { name: "Bob", age: 1 }),
);
await run("body invalid", () =>
  json("POST", "/validate/body", { name: "A", age: -1 }),
);
await run("body bad email", () =>
  json("POST", "/validate/body", { name: "Ada", age: 1, email: "nope" }),
);
await run("body missing", () => get("/validate/body", { method: "POST" }));
await run("body wrong type", () => json("POST", "/validate/body", [1, 2]));
await run("query coerced", () =>
  get(
    "/validate/query?n=5&flag=true&ids=1&ids=2&when=2024-01-02T03:04:05.000Z",
  ),
);
await run("query comma array", () =>
  get("/validate/query?n=1.5&flag=false&ids=3,4"),
);
await run("query invalid", () => get("/validate/query?n=abc&flag=maybe"));
await run("params coerced", () => get("/validate/params/12/hello-world"));
await run("params invalid", () => get("/validate/params/x/Hello"));
await run("headers ok", () =>
  get("/validate/headers", {
    headers: { "x-api-key": "abcd", "x-count": "3" },
  }),
);
// `found` echoes every request header (host, user agent): left out.
await run("headers invalid", async () => {
  const res = await fetch(base + "/validate/headers", {
    headers: { "x-api-key": "a" },
  });
  const { found, ...problem } = (await res.json()) as {
    found: Record<string, string>;
  };
  return `${res.status} ${res.headers.get("content-type")} ${JSON.stringify(problem)} found-key=${found?.["x-api-key"]}`;
});
await run("custom error message", () => get("/validate/custom-error?age=3"));
await run("model", () => json("POST", "/validate/model", { x: 1, y: 2 }));
await run("model invalid", () => json("POST", "/validate/model", { x: "1" }));
await run("ref", () =>
  json("POST", "/validate/ref", { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }),
);
await run("zod ok", () => json("POST", "/validate/zod", { name: "zed", n: 3 }));
await run("zod invalid", () =>
  json("POST", "/validate/zod", { name: "", n: 1.5 }),
);
await run("urlencoded coerced", () =>
  get("/validate/form", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "name=box&count=4",
  }),
);
await run("multipart coerced", () => {
  const fd = new FormData();
  fd.set("name", "box");
  fd.set("count", "5");
  return get("/validate/form", { method: "POST", body: fd });
});

// Responses ----------------------------------------------------------------------------------------------------------
await run("response 200 normalized", () => get("/response/ok"));
await run("response 201", () => get("/response/created"));
await run("response 400", () => get("/response/bad"));
await run("response invalid", () => get("/response/wrong"));
await run("status", () => get("/status"));
await run("status by name", () => get("/status-name"));
await run("set", () => get("/set", undefined, ["x-custom"]));
await run("redirect", () =>
  get("/redirect", { redirect: "manual" }, ["location"]),
);
await run("redirect 301", () =>
  get("/redirect-301", { redirect: "manual" }, ["location"]),
);
await run("redirect followed", () => get("/redirect"));
await run("problem", () => get("/problem"));

// Lifecycle ----------------------------------------------------------------------------------------------------------
await run("hook order", async () => {
  const mark = log.length;
  const res = await json("POST", "/hook-order/ada", { a: 1 });
  await waitLog((l) => l === "afterResponse");
  return `${res} ${log.slice(mark).join(" > ")}`;
});
await run("on request early", () => get("/early"));
await run("custom parser", () =>
  get("/parse/csv", {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: "a, b,c",
  }),
);
await run("parse as text", () =>
  get("/parse/text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"kept":"as text"}',
  }),
);
await run("inline parser", () =>
  get("/parse/inline", { method: "POST", body: "stressed" }),
);
await run("before handle allow", () => get("/before-handle/yes"));
await run("before handle block", () => get("/before-handle/no"));
await run("map response", () => get("/mapped"));
await run(
  "after response",
  async () =>
    `${await get("/after/1")} ${await waitLog((l) => l.startsWith("afterResponse /after"))}`,
);
await run(
  "defer",
  async () =>
    `${await get("/defer")} ${await waitLog((l) => l === "deferred ran")}`,
);
await run(
  "trace",
  async () =>
    `${await get("/traced")} ${await waitLog((l) => l.startsWith("trace"))}`,
);
await run("wrap", () => get("/wrapped", undefined, ["x-wrapped"]));
await run("on start", () => log.includes("onStart"));

// Guards and macros --------------------------------------------------------------------------------------------------
await run("guard ok", () => get("/guarded?token=abc"));
await run("guard hook", () => get("/guarded?token=bad"));
await run("guard schema", () => get("/guarded"));
await run("guard override", () => get("/guarded/override?other=3"));
await run("guard standalone", () => get("/standalone?a=x&b=2"));
await run("guard standalone missing", () => get("/standalone?b=2"));
await run("macro auth missing", () => get("/me"));
await run("macro auth", () =>
  get("/me", { headers: { authorization: "Bearer ada-token" } }),
);
await run("macro role denied", () =>
  get("/admin", { headers: { authorization: "Bearer bob-token" } }),
);
await run("macro role", () =>
  get("/admin", { headers: { authorization: "Bearer ada-token" } }),
);
await run("macro with arg", () => get("/tagged", undefined, ["x-tag"]));

// Errors -------------------------------------------------------------------------------------------------------------
await run("error by class", () => get("/teapot"));
await run("returned error", () => get("/returned-error"));
await run("http error", () => get("/credit"));
await run("error with status", () => get("/gone"));
await run("fallback error handler", () => get("/fallback-error"));
await run("unhandled error", () => get("/crash"));
// The detail is the engine's JSON.parse message (JavaScriptCore's natively, V8's in Chrome): left out.
await run("parse error", async () => {
  const res = await fetch(base + "/parse-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{bad",
  });
  const { detail, ...problem } = (await res.json()) as { detail: string };
  return `${res.status} ${res.headers.get("content-type")} ${JSON.stringify(problem)} detail=${typeof detail}`;
});
await run("parse error handled", () =>
  get("/parse-error-handled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{bad",
  }),
);
await run("unsupported content type", () =>
  get("/parse-error", {
    method: "POST",
    headers: { "content-type": "application/x-unknown" },
    body: "?",
  }),
);
await run("validation error handled", () => get("/validation-handled?n=x"));

// Cookies ------------------------------------------------------------------------------------------------------------
let jar = "";
await run("cookie set", async () => {
  const res = await fetch(base + "/cookie/set");
  jar = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return show(res, ["set-cookie"]);
});
await run("cookie read", () =>
  get("/cookie/read", { headers: { cookie: jar } }),
);
await run("cookie read invalid", () =>
  get("/cookie/read", { headers: { cookie: "prefs=notjson" } }),
);
await run("cookie signed", () =>
  get("/cookie/signed", { headers: { cookie: jar } }),
);
await run("cookie signed tampered", () =>
  get("/cookie/signed", { headers: { cookie: "signed=trusted.forged" } }),
);
await run("cookie signed unsigned", () =>
  get("/cookie/signed", { headers: { cookie: "signed=trusted" } }),
);
await run("cookie field signed", () =>
  get("/cookie/field-signed", undefined, ["set-cookie"]),
);
await run("cookie remove", () =>
  get("/cookie/remove", { headers: { cookie: jar } }, ["set-cookie"]),
);

// Files and forms ----------------------------------------------------------------------------------------------------
await run("bun file", () => get("/file/bun", undefined, ["content-length"]));
await run("elysia file", () => get("/file/elysia"));
await run("upload", () => {
  const fd = new FormData();
  fd.set("title", "docs");
  fd.set("doc", new File(["file body"], "a.txt", { type: "text/plain" }));
  fd.append("many", new File(["1"], "one.txt"));
  fd.append("many", new File(["2"], "two.txt"));
  return get("/upload", { method: "POST", body: fd });
});
await run("upload missing file", () => {
  const fd = new FormData();
  fd.set("title", "docs");
  return get("/upload", { method: "POST", body: fd });
});
await run("upload too big", () => {
  const fd = new FormData();
  fd.set("doc", new File(["too big"], "big.txt"));
  return get("/upload/limits", { method: "POST", body: fd });
});
await run("urlencoded", () =>
  get("/urlencoded", {
    method: "POST",
    body: new URLSearchParams({ a: "1", b: "two" }),
  }),
);
await run("form response", async () => {
  const res = await fetch(base + "/form-response");
  const fd = await res.formData();
  const logo = fd.get("logo") as File;
  return `${res.status} ${res.headers.get("content-type")?.split(";")[0]} name=${fd.get("name")} logo=${logo.name.split("/").pop()}:${JSON.stringify(await logo.text())}`;
});
await run("binary", async () => {
  const res = await fetch(base + "/binary", {
    method: "POST",
    body: new Uint8Array([1, 2, 3]),
  });
  return `${res.status} ${res.headers.get("content-type")} ${[...new Uint8Array(await res.arrayBuffer())]}`;
});

// Streaming ----------------------------------------------------------------------------------------------------------
await run("stream generator", () => get("/stream/generator"));
await run("stream json", () => get("/stream/json"));
await run("stream sse", () => get("/stream/sse", undefined, ["cache-control"]));
await run("stream sse readable", () => get("/stream/sse-stream"));
await run("stream readable", () => get("/stream/readable"));
await run("stream bytes", () => get("/stream/bytes"));
// A generator that throws midway: what the client sees (an error, how far it got).
await run("stream error", async () => {
  let text = "";
  try {
    const res = await fetch(base + "/stream/error");
    text = `${res.status} `;
    const decoder = new TextDecoder();
    for await (const chunk of res.body!) text += decoder.decode(chunk);
    return `${text} (ended)`;
  } catch (e) {
    return `${text}! ${(e as Error).name}`;
  }
});
await run("stream chunks", async () => {
  const res = await fetch(base + "/stream/generator");
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of res.body!) chunks.push(decoder.decode(chunk));
  return chunks.join("").length;
});

// Plugins from npm ---------------------------------------------------------------------------------------------------
await run("cors preflight", () =>
  get(
    "/json",
    {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
      },
    },
    [
      "access-control-allow-origin",
      "access-control-allow-credentials",
      "access-control-allow-methods",
    ],
  ),
);
await run("cors request", () =>
  get("/json", { headers: { origin: "https://example.com" } }, [
    "access-control-allow-origin",
    "vary",
  ]),
);
await run("openapi", async () => {
  const res = await fetch(base + "/openapi/json");
  const spec = (await res.json()) as {
    openapi: string;
    info: { title: string };
    paths: Record<string, Record<string, unknown>>;
  };
  const paths = Object.keys(spec.paths);
  return `${res.status} ${spec.openapi} ${spec.info.title} paths=${paths.length} todos=${Object.keys(spec.paths["/todos/{id}"] ?? {})} has-ws=${paths.includes("/ws/echo")}`;
});
await run("openapi ui", async () => {
  const res = await fetch(base + "/openapi");
  return `${res.status} ${res.headers.get("content-type")} ${(await res.text()).includes("/openapi/json")}`;
});
let token = "";
await run("jwt sign", async () => {
  const res = await fetch(base + "/jwt/sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: "ada" }),
  });
  token = await res.text();
  return `${res.status} ${token}`;
});
await run("jwt verify", () =>
  get("/jwt/verify", { headers: { authorization: `Bearer ${token}` } }),
);
await run("jwt verify bad", () =>
  get("/jwt/verify", { headers: { authorization: `Bearer ${token}x` } }),
);
await run("bearer from query", () => get(`/jwt/verify?access_token=${token}`));

// Mount and handle ---------------------------------------------------------------------------------------------------
await run("mount", () => get("/raw/some/path?q=1"));
await run("mount post", () => get("/raw/x", { method: "POST", body: "b" }));
await run("handle", async () =>
  show(await app.handle(new Request("http://localhost/json"))),
);
await run("handle string", async () =>
  show(await app.handle("http://localhost/user/7")),
);
await run("handle validation", async () =>
  show(await app.handle(new Request("http://localhost/validate/params/x/y"))),
);
await run("fetch", async () =>
  show(await app.fetch(new Request("http://localhost/v1/ping"))),
);

// WebSocket ----------------------------------------------------------------------------------------------------------
await run("ws echo", async () => {
  const s = socket("/ws/echo?name=ada");
  await s.opened;
  s.ws.send(JSON.stringify({ text: "hi" }));
  const first = await s.next();
  s.ws.send(JSON.stringify({ text: "far too long a message" }));
  const second = await s.next();
  s.ws.send("not json");
  const third = await s.next();
  s.ws.close(1000, "bye");
  return [...first, ...second, ...third, await s.closed].join(" | ");
});
await run("ws query default", async () => {
  const s = socket("/ws/echo");
  await s.opened;
  s.ws.send(JSON.stringify({ text: "yo" }));
  const got = await s.next();
  s.ws.close();
  await s.closed;
  return got.join(" | ");
});
await run("ws pub/sub", async () => {
  const a = socket("/ws/room?name=a");
  await a.opened;
  const b = socket("/ws/room?name=b");
  await b.opened;
  const joined = await a.next();
  b.ws.send("hello");
  const [toA, toB] = await Promise.all([a.next(), b.next()]);
  a.ws.close();
  b.ws.close();
  await Promise.all([a.closed, b.closed]);
  return `a got ${joined} / ${toA}; b got ${toB}`;
});
await run("ws generator", async () => {
  const s = socket("/ws/stream");
  await s.opened;
  s.ws.send("go");
  const got = await s.next(3);
  s.ws.close();
  await s.closed;
  return got.join(",");
});
await run("ws missing query", async () => {
  const s = socket("/ws/room");
  return s.opened.then(
    async () => `opened ${await s.closed}`,
    async () => `refused ${await s.closed}`,
  );
});
await run("ws before handle refused", async () => {
  const s = socket("/ws/guarded");
  return s.opened.then(
    async () => `opened ${await s.closed}`,
    async () => `refused ${await s.closed}`,
  );
});
await run("ws before handle allowed", async () => {
  const s = socket("/ws/guarded?ok=yes");
  await s.opened;
  s.ws.send("x");
  const got = await s.next();
  s.ws.close();
  await s.closed;
  return got.join(",");
});
await run("ws plain http", () => get("/ws/echo"));

// Eden Treaty --------------------------------------------------------------------------------------------------------
const local = treaty(app);
const remote = treaty<typeof app>(`localhost:${port}`);
const eden = (r: {
  status: number;
  data: unknown;
  error: { status: unknown; value: unknown } | null;
}) =>
  `${r.status} data=${JSON.stringify(r.data)} error=${r.error ? `${r.error.status} ${JSON.stringify(r.error.value)}` : null}`;
await run("eden local get", async () => eden(await local.json.get()));
await run("eden param", async () => eden(await remote.user({ id: 5 }).get()));
await run("eden query", async () =>
  eden(
    await remote.validate.query.get({
      query: { n: 2, flag: true, ids: [7, 8] },
    }),
  ),
);
await run("eden body", async () =>
  eden(await remote.validate.model.post({ x: 2, y: 3 })),
);
await run("eden validation error", async () =>
  eden(
    await remote.validate.model.post({ x: "no" as unknown as number, y: 3 }),
  ),
);
await run("eden headers", async () =>
  eden(await remote.me.get({ headers: { authorization: "Bearer ada-token" } })),
);
await run("eden status error", async () => eden(await remote.teapot.get()));
await run("eden stream", async () => {
  const { data, error } = await remote.stream.sse.get();
  if (error) return `error ${error.status}`;
  const got: unknown[] = [];
  for await (const chunk of data as AsyncIterable<unknown>) got.push(chunk);
  return JSON.stringify(got);
});
await run("eden upload", async () =>
  eden(
    await remote.upload.post({
      title: "eden",
      doc: new File(["e"], "e.txt", { type: "text/plain" }),
      many: [new File(["m"], "m.txt")],
    }),
  ),
);
await run("eden ws", async () => {
  const chat = remote.ws.echo.subscribe({ query: { name: "eden" } });
  const got = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message")), 2000);
    chat.subscribe((message) => {
      clearTimeout(timer);
      resolve(JSON.stringify(message.data));
    });
    chat.on("open", () => chat.send({ text: "via eden" }));
  });
  chat.close();
  return got;
});

await app.stop();
await run("on stop", () => log.includes("onStop"));
console.log("__elysia_end__");
process.exit(0);
