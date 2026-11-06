---
title: "Bun.serve routes: a JSON API example"
description: "A small JSON API with Bun.serve's routes: path parameters, per-method handlers, Response.json and a 404 fallback, runnable in your browser."
sidebar:
  order: 2
  label: Routes and a JSON API
---

`Bun.serve` has a router built in. The `routes` object maps paths to handlers, a path can hold parameters like `:id`, and a route can give each HTTP method its own handler. Press **Run**, then try the requests in the preview's tabs.

```ts playground mode=preview height=auto path="/api/users" requests='GET /api/users; GET /api/users/1; POST /api/users {"name":"Grace"}; GET /api/users/42'
const users = new Map([
  [1, { id: 1, name: "Ada" }],
  [2, { id: 2, name: "Linus" }],
]);

Bun.serve({
  routes: {
    "/api/users": {
      GET: () => Response.json([...users.values()]),
      POST: async (req) => {
        const { name } = await req.json();
        const user = { id: users.size + 1, name: String(name) };
        users.set(user.id, user);
        return Response.json(user, { status: 201 });
      },
    },
    "/api/users/:id": (req) => {
      const user = users.get(Number(req.params.id));
      return user ? Response.json(user) : Response.json({ error: "Not found" }, { status: 404 });
    },
  },
  // Anything no route matches.
  fetch: () => new Response("Not found", { status: 404 }),
});
```

## How it works

- **A route with an object** (`"/api/users": { GET, POST }`) answers each method with its own handler.
- **`:id`** in a path is a parameter: the handler reads it as `req.params.id`, typed as a string, so convert it before using it as a number.
- **`Response.json(data, init)`** serializes the data and sets `Content-Type: application/json`. Pass `{ status: 201 }` and the like as the second argument.
- **`fetch`** still runs for every request no route matches, so it's the place for a custom 404.

Routes are matched by how specific they are, not by their order: an exact path wins over one with a parameter.

## Next

Send a WebSocket through the same server in the [WebSocket example](/examples/bun-websocket/), or try the same API in [Elysia](/examples/elysia/) or [Hono](/examples/hono/).
