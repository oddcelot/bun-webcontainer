// An Elysia 2 app that touches as much of the framework as one file can: main.ts drives every route and prints what
// it answers (scripts/elysia.ts compares that with native Bun).
import { bearer } from "@elysia/bearer";
import { cors } from "@elysia/cors";
import { jwt } from "@elysia/jwt";
import { openapi } from "@elysia/openapi";
import { staticPlugin } from "@elysia/static";
import {
  Elysia,
  HTTPError,
  NotFound,
  ParseError,
  ValidationError,
  bytes,
  file,
  form,
  prefix,
  problem,
  redirect,
  sse,
  status,
  t,
} from "elysia";
import { trace } from "elysia/trace";
import { websocket } from "elysia/websocket";
import { z } from "zod";

/** What hooks saw, in order: main.ts reads it back through /log. */
export const log: string[] = [];

// Errors -------------------------------------------------------------------------------------------------------------

export class TeapotError extends Error {
  constructor(public flavor: string) {
    super(`no ${flavor} here`);
  }
}

class OutOfCredit extends HTTPError.id("OUT_OF_CREDIT", 402) {
  readonly detail = "Top up to continue";
  constructor(readonly balance: number) {
    super();
  }
  extension() {
    return { balance: this.balance };
  }
}

class Gone extends Error {
  status = 410;
}

// Plugins ------------------------------------------------------------------------------------------------------------

// Named: used three times below, its global hook must run once per request.
const named = new Elysia({ name: "named" }).onAfterHandle(
  "global",
  ({ set }) => {
    set.headers["x-named"] = String(Number(set.headers["x-named"] ?? 0) + 1);
  },
);

// Same name, another seed: a different instance, so both apply.
const seeded = (seed: string) =>
  new Elysia({ name: "seeded", seed }).onAfterHandle("global", ({ set }) => {
    set.headers["x-seeded"] = [set.headers["x-seeded"], seed]
      .filter(Boolean)
      .join(",");
  });

// Hook scopes: local stays in the child, plugin reaches its parent, global reaches everything.
const scopeChild = new Elysia({ name: "scope-child" })
  .onAfterHandle(({ set }) => {
    set.headers["x-local"] = "1";
  })
  .onAfterHandle("plugin", ({ set }) => {
    set.headers["x-plugin"] = "1";
  })
  .onAfterHandle("global", ({ set }) => {
    set.headers["x-global"] = "1";
  })
  .get("/scope/child", () => "child");
const scopeParent = new Elysia({ name: "scope-parent" })
  .use(scopeChild)
  .get("/scope/parent", () => "parent");

// `.as('plugin')` lifts the local derive of a plugin into its parent.
const lifted = new Elysia({ name: "lifted" })
  .derive(({ headers }) => ({ lang: headers["accept-language"] ?? "none" }))
  .as("plugin");

// Macros: a derive one (auth), one taking an argument (role) and one with a schema of its own.
const users = new Map([
  ["ada-token", { name: "Ada", role: "admin" as const }],
  ["bob-token", { name: "Bob", role: "user" as const }],
]);
const auth = new Elysia({ name: "auth" }).macro({
  auth: {
    headers: t.Object({ authorization: t.Optional(t.String()) }),
    derive({ headers }) {
      const user = users.get(
        headers.authorization?.replace(/^Bearer /, "") ?? "",
      );
      return user ? { user } : status(401, "Unauthorized");
    },
  },
  role: (role: "admin" | "user") => ({
    beforeHandle({ headers }) {
      const user = users.get(
        headers.authorization?.replace(/^Bearer /, "") ?? "",
      );
      if (user?.role !== role) return status(403, `needs ${role}`);
    },
  }),
  tagged: (tag: string) => ({
    afterHandle({ set }) {
      set.headers["x-tag"] = tag;
    },
  }),
});

// A prefixed plugin with models, state and a guard.
const todos = new Elysia({ name: "todos", prefix: "/todos" })
  .use(auth)
  .model({
    todo: t.Object({ id: t.Number(), title: t.String(), done: t.Boolean() }),
    newTodo: t.Object({ title: t.String({ minLength: 1, maxLength: 20 }) }),
  })
  .model(
    prefix("todos", {
      list: t.Array(
        t.Object({ id: t.Number(), title: t.String(), done: t.Boolean() }),
      ),
    }),
  )
  .state("todos", [{ id: 1, title: "first", done: true }] as {
    id: number;
    title: string;
    done: boolean;
  }[])
  .get("/", { response: "todos.list" }, ({ store }) => store.todos)
  .get(
    "/:id",
    { params: t.Object({ id: t.Number() }) },
    ({ store, params }) =>
      store.todos.find((x) => x.id === params.id) ??
      status(404, "no such todo"),
  )
  .guard({ auth: true }, (app) =>
    app
      .post(
        "/",
        { body: "newTodo", response: { 201: "todo" } },
        ({ store, body, user }) => {
          const todo = {
            id: store.todos.length + 1,
            title: `${body.title} by ${user.name}`,
            done: false,
          };
          store.todos.push(todo);
          return status(201, todo);
        },
      )
      .delete("/", { role: "admin" }, ({ store }) => ({
        removed: store.todos.splice(0).length,
      })),
  );

// A plugin loaded lazily with a dynamic import, and an async one (the static plugin reads its folder first).
const lazy = import("./plugins/lazy.ts");
const statics = staticPlugin({ assets: "public", prefix: "/public" });

// The app ------------------------------------------------------------------------------------------------------------

export const app = new Elysia({
  cookie: { secrets: "s3cr3t", sign: ["signed"] },
})
  .use(websocket())
  .use(trace())
  .use(cors({ origin: "https://example.com", credentials: true }))
  .use(openapi({ path: "/openapi" }))
  .use(jwt({ name: "jwt", secret: "jwt-secret", iat: false }))
  .use(bearer())
  .use(named)
  .use(named)
  .use(seeded("a"))
  .use(seeded("b"))
  .use(scopeParent)
  .use(lifted)
  .use(todos)
  .use(lazy)
  .use(statics)
  .headers({ "x-powered-by": "elysia-2" })
  .decorate("version", "2.0")
  .state("hits", 0)
  .derive(({ headers }) => ({ who: headers["x-who"] ?? "anon" }))
  .model({ point: t.Object({ x: t.Number(), y: t.Number() }) })
  .parser("csv", ({ request, contentType }) => {
    if (contentType === "text/csv")
      return request
        .text()
        .then((text) => text.split(",").map((s) => s.trim()));
  })
  .trace(({ onHandle, context }) => {
    if (!context.path.startsWith("/traced")) return;
    onHandle(() => {
      log.push(`trace handle ${context.path}`);
    });
  })
  .onRequest(({ request, set }) => {
    const path = new URL(request.url).pathname;
    if (path === "/early") return "answered by onRequest";
    if (path === "/hook-order") log.length = 0;
    set.headers["x-on-request"] = "1";
  })
  .onError(TeapotError, ({ error }) => status(418, { flavor: error.flavor }))
  .onError(NotFound, ({ path }) =>
    problem(404, { detail: `nothing at ${path}` }),
  )
  .onError(({ error, path }) => {
    if (path === "/fallback-error" && error instanceof RangeError)
      return status(400, `range: ${error.message}`);
  })
  .onAfterResponse(({ path, set }) => {
    if (path.startsWith("/after"))
      log.push(`afterResponse ${path} ${set.status}`);
  })

  // Routing
  .get("/", () => "hello elysia")
  .get("/json", () => ({ hello: "world", list: [1, 2, 3] }))
  .get("/user/:id", ({ params }) => `user ${params.id}`)
  .get("/user/:id/post/:post?", ({ params }) => params)
  .get("/files/*", ({ params }) => `wildcard ${params["*"]}`)
  .group("/v1", (app) =>
    app
      .get("/ping", () => "v1 pong")
      .group("/nested", (app) => app.get("/deep", () => "deep")),
  )
  .all("/any", ({ request }) => `any ${request.method}`)
  .route("PROPFIND", "/dav", () => "propfind")
  .put("/put", ({ body }) => ({ put: body }))
  .patch("/patch", ({ body }) => ({ patch: body }))
  .delete("/delete", () => "deleted")
  .head("/head", ({ set }) => {
    set.headers["x-head"] = "yes";
    return "";
  })

  // Context: decorate, state, derive, store
  .get("/context", ({ version, store, who, lang }) => ({
    version,
    hits: ++store.hits,
    who,
    lang,
  }))

  // Validation and coercion
  .post(
    "/validate/body",
    {
      body: t.Object({
        name: t.String({ minLength: 2 }),
        age: t.Number({ minimum: 0 }),
        email: t.Optional(t.String({ format: "email" })),
        tags: t.Array(t.String(), { default: [] }),
        role: t.Union([t.Literal("admin"), t.Literal("user")], {
          default: "user",
        }),
      }),
    },
    ({ body }) => body,
  )
  .get(
    "/validate/query",
    {
      query: t.Object({
        n: t.Number(),
        flag: t.Boolean(),
        ids: t.Array(t.Number()),
        name: t.String({ default: "nobody" }),
        when: t.Optional(t.Date()),
      }),
    },
    ({ query }) => ({
      ...query,
      when: query.when?.toISOString() ?? null,
      types: [typeof query.n, typeof query.flag, typeof query.ids[0]],
    }),
  )
  .get(
    "/validate/params/:id/:slug",
    {
      params: t.Object({
        id: t.Number(),
        slug: t.String({ pattern: "^[a-z-]+$" }),
      }),
    },
    ({ params }) => [params.id, typeof params.id, params.slug],
  )
  .get(
    "/validate/headers",
    {
      headers: t.Object({
        "x-api-key": t.String({ minLength: 3 }),
        "x-count": t.Optional(t.Number()),
      }),
    },
    ({ headers }) => ({
      key: headers["x-api-key"],
      count: headers["x-count"] ?? null,
    }),
  )
  .get(
    "/validate/custom-error",
    {
      query: t.Object({
        age: t.Number({ minimum: 18, error: "must be an adult" }),
      }),
    },
    ({ query }) => query.age,
  )
  .post(
    "/validate/model",
    { body: "point", response: "point" },
    ({ body }) => ({ x: body.x * 2, y: body.y * 2 }),
  )
  .post(
    "/validate/ref",
    { body: t.Object({ a: t.Ref("point"), b: t.Ref("point") }) },
    ({ body }) => body.a.x + body.b.y,
  )
  .post(
    "/validate/zod",
    { body: z.object({ name: z.string().min(1), n: z.number().int() }) },
    ({ body }) => ({ zod: body.name, n: body.n }),
  )
  .post(
    "/validate/form",
    { body: t.Object({ name: t.String(), count: t.Number() }) },
    ({ body }) => [body.name, body.count, typeof body.count],
  )

  // Response schemas, per status; extra fields are normalized away
  .get(
    "/response/:kind",
    {
      params: t.Object({ kind: t.String() }),
      response: {
        200: t.Object({ ok: t.Boolean() }),
        201: t.Object({ id: t.Number() }),
        400: t.Object({ reason: t.String() }),
      },
    },
    ({ params }): any => {
      if (params.kind === "ok") return { ok: true, secret: "stripped" };
      if (params.kind === "created") return status(201, { id: 7 });
      if (params.kind === "bad") return status(400, { reason: "bad kind" });
      return { ok: "not a boolean" };
    },
  )

  // Lifecycle, per route and in order
  .post(
    "/hook-order/:name",
    {
      parse: [
        ({ contentType }) => {
          log.push(`parse ${contentType}`);
        },
      ],
      transform: ({ params }) => {
        log.push("transform");
        params.name = params.name.toUpperCase();
      },
      beforeHandle: ({ params }) => {
        log.push(`beforeHandle ${params.name}`);
      },
      afterHandle: ({ responseValue }) => {
        log.push(`afterHandle ${JSON.stringify(responseValue)}`);
        return { wrapped: responseValue };
      },
      afterResponse: () => {
        log.push("afterResponse");
      },
    },
    ({ params, body }) => {
      log.push("handler");
      return { name: params.name, body };
    },
  )
  .post("/parse/csv", { parse: "csv" }, ({ body }) => ({ csv: body }))
  .post("/parse/text", { parse: "text" }, ({ body }) => ({ text: body }))
  .post(
    "/parse/inline",
    {
      parse: ({ request }) =>
        request.text().then((s) => s.split("").reverse().join("")),
    },
    ({ body }) => ({ reversed: body }),
  )
  .get(
    "/before-handle/:allow",
    {
      beforeHandle: ({ params }) =>
        params.allow === "no"
          ? status(403, "blocked by beforeHandle")
          : undefined,
    },
    () => "allowed",
  )
  .get(
    "/mapped",
    {
      mapResponse: ({ responseValue }) =>
        new Response(String(responseValue).toUpperCase(), {
          headers: { "content-type": "text/x-shout" },
        }),
    },
    () => "quiet words",
  )
  .get("/after/:n", ({ params }) => `after ${params.n}`)
  .get("/defer", ({ defer }) => {
    defer(() => {
      log.push("deferred ran");
    });
    return "deferred";
  })
  .get("/traced", () => "traced")
  .get("/log", () => log)
  .get("/early", () => "never reached")

  // Guards: override (default) and merged (1.x standalone) schemas, and hooks
  .guard(
    {
      query: t.Object({ token: t.String() }),
      beforeHandle: ({ query }) =>
        query.token === "bad" ? status(401, "bad token") : undefined,
    },
    (app) =>
      app
        .get("/guarded", ({ query }) => `guarded ${query.token}`)
        .get(
          "/guarded/override",
          { query: t.Object({ other: t.Number() }) },
          ({ query }) => query,
        ),
  )
  .guard({ schema: "merge", query: t.Object({ a: t.String() }) }, (app) =>
    app.get(
      "/standalone",
      { query: t.Object({ b: t.Number() }) },
      ({ query }) => query,
    ),
  )

  // Macros
  .use(auth)
  .get("/me", { auth: true }, ({ user }) => user)
  .get(
    "/admin",
    { auth: true, role: "admin" },
    ({ user }) => `welcome ${user.name}`,
  )
  .get("/tagged", { tagged: "blue" }, () => "tagged")

  // Errors
  .get("/teapot", () => {
    throw new TeapotError("earl grey");
  })
  .get("/credit", () => {
    throw new OutOfCredit(3);
  })
  .get("/gone", () => {
    throw new Gone("it went away");
  })
  .get("/fallback-error", () => {
    throw new RangeError("out of range");
  })
  .get("/crash", () => {
    throw new Error("boom");
  })
  .get("/returned-error", () => new TeapotError("returned"))
  .get("/problem", () => problem(409, { detail: "conflict!", extra: 1 }))
  .post(
    "/parse-error",
    { body: t.Object({ a: t.String() }) },
    ({ body }) => body,
  )
  .onError("local", ParseError, () => status(400, "custom parse error"))
  .post(
    "/parse-error-handled",
    { body: t.Object({ a: t.String() }) },
    ({ body }) => body,
  )
  .get(
    "/validation-handled",
    {
      query: t.Object({ n: t.Number() }),
      error: ({ error }) =>
        error instanceof ValidationError
          ? status(400, `bad ${error.type}`)
          : undefined,
    },
    ({ query }) => query.n,
  )

  // Status, headers, redirect, cookies
  .get("/status", () => status(202, { accepted: true }))
  .get("/status-name", () => status("I'm a teapot", "short and stout"))
  .get("/set", ({ set }) => {
    set.status = 207;
    set.headers["x-custom"] = "yes";
    set.headers["content-type"] = "text/x-custom";
    return "set";
  })
  .get("/redirect", () => redirect("/json"))
  .get("/redirect-301", ({ redirect }) => redirect("/json", 301))
  .get("/cookie/set", ({ cookie: { plain, prefs, signed } }) => {
    plain.value = "hello";
    plain.httpOnly = true;
    plain.path = "/";
    prefs.value = { theme: "dark", size: 3 };
    prefs.sameSite = "lax";
    signed.value = "trusted";
    return "cookies set";
  })
  .get(
    "/cookie/read",
    {
      cookie: t.Cookie({
        plain: t.Optional(t.String()),
        prefs: t.Optional(t.Object({ theme: t.String(), size: t.Number() })),
      }),
    },
    ({ cookie: { plain, prefs } }) => ({
      plain: plain.value ?? null,
      prefs: prefs.value ?? null,
    }),
  )
  .get("/cookie/signed", ({ cookie: { signed } }) => ({
    signed: signed.value ?? null,
  }))
  .get(
    "/cookie/field-signed",
    {
      cookie: t.Object({
        token: t.Optional(t.Cookie(t.String(), { sign: true })),
      }),
    },
    ({ cookie: { token } }) => {
      token.value = "field";
      return "field signed";
    },
  )
  .get("/cookie/remove", ({ cookie: { plain } }) => {
    plain.remove();
    return "removed";
  })

  // Files and forms
  .get("/file/bun", () =>
    Bun.file(new URL("./public/hello.txt", import.meta.url)),
  )
  .get("/file/elysia", () =>
    file(new URL("./public/data.json", import.meta.url).pathname),
  )
  .post(
    "/upload",
    { body: t.Object({ title: t.String(), doc: t.File(), many: t.Files() }) },
    async ({ body }) => ({
      title: body.title,
      doc: [body.doc.name, body.doc.type, body.doc.size, await body.doc.text()],
      many: await Promise.all(
        body.many.map(async (f) => `${f.name}=${await f.text()}`),
      ),
    }),
  )
  .post(
    "/upload/limits",
    { body: t.Object({ doc: t.File({ maxSize: 4 }) }) },
    ({ body }) => body.doc.size,
  )
  .post("/urlencoded", ({ body }) => ({ form: body }))
  .get("/form-response", () =>
    form({
      name: "elysia",
      logo: Bun.file(new URL("./public/hello.txt", import.meta.url)),
    }),
  )
  .post("/binary", { parse: "arrayBuffer" }, ({ body }) =>
    new Uint8Array(body as ArrayBuffer).reverse(),
  )

  // Streaming
  .get("/stream/generator", async function* () {
    yield "one ";
    await Bun.sleep(5);
    yield "two ";
    yield "three";
  })
  .get("/stream/json", function* () {
    yield { n: 1 };
    yield { n: 2 };
  })
  .get("/stream/sse", async function* () {
    for (let i = 1; i <= 3; i++) {
      yield sse({ id: i, event: "tick", data: { i } });
      await Bun.sleep(5);
    }
    yield sse("done");
  })
  .get("/stream/sse-stream", () =>
    sse(
      new ReadableStream({
        start(c) {
          c.enqueue("a");
          c.enqueue("b");
          c.close();
        },
      }),
    ),
  )
  .get(
    "/stream/readable",
    () =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("raw "));
          c.enqueue(new TextEncoder().encode("bytes"));
          c.close();
        },
      }),
  )
  .get("/stream/bytes", () => bytes(new Blob(["certified bytes"]).stream()))
  .get("/stream/error", async function* () {
    yield "before ";
    throw new Error("mid-stream");
  })

  // Plugins from npm
  .post("/jwt/sign", { body: t.Object({ sub: t.String() }) }, ({ jwt, body }) =>
    jwt.sign({ sub: body.sub }),
  )
  .get(
    "/jwt/verify",
    async ({ jwt, bearer }) =>
      (await jwt.verify(bearer)) || status(401, "invalid token"),
  )

  // Mounting a plain fetch handler
  .mount(
    "/raw",
    (request) =>
      new Response(
        `raw ${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`,
      ),
  )

  // WebSocket
  .ws(
    "/ws/echo",
    {
      body: t.Object({ text: t.String({ maxLength: 10 }) }),
      query: t.Object({ name: t.String({ default: "anon" }) }),
    },
    (ws, { text }) => ({ from: ws.query.name, echo: text }),
  )
  .ws("/ws/room", {
    query: t.Object({ name: t.String() }),
    open(ws) {
      ws.subscribe("room");
      ws.publish("room", `${ws.query.name} joined`);
    },
    message(ws, body) {
      ws.publish("room", `${ws.query.name}: ${body}`);
      ws.send(`you said ${body}`);
    },
    close(ws) {
      ws.unsubscribe("room");
    },
  })
  .ws("/ws/stream", function* () {
    yield 1;
    yield 2;
    yield 3;
  })
  .ws(
    "/ws/guarded",
    {
      beforeHandle: ({ query }) =>
        query.ok === "yes" ? undefined : status(401, "no socket for you"),
    },
    (_ws, body) => `ok ${body}`,
  )

  .wrap((fetch) => async (request: Request, ...rest: unknown[]) => {
    const response = await fetch(request, ...rest);
    if (new URL(request.url).pathname === "/wrapped")
      response.headers.set("x-wrapped", "yes");
    return response;
  })
  .get("/wrapped", () => "wrapped")
  .onStart(() => {
    log.push("onStart");
  })
  .onStop(() => {
    log.push("onStop");
  });

export type App = typeof app;
