---
title: "Hono on Bun example: a Hono app in your browser"
description: "A Hono app on Bun with routes, path parameters, JSON and middleware, served with export default, installed from npm and running in your browser."
sidebar:
  order: 9
  label: Hono
---

[Hono](https://hono.dev/) is a small web framework that runs on Bun, Deno, Node and edge runtimes. On Bun, a module that exports an object with a `fetch` method is served automatically. Press **Run** to install Hono and start the app.

```ts playground mode=preview height=auto deps="hono" requests='GET /; GET /api/hello/Bun; GET /api/time'
import { Hono } from "hono";
import { logger } from "hono/logger";

const app = new Hono();

app.use(logger());
app.get("/", (c) => c.text("Hello Hono!"));
app.get("/api/hello/:name", (c) => c.json({ message: `Hello, ${c.req.param("name")}!` }));
app.get("/api/time", (c) => c.json({ now: new Date().toISOString(), bun: Bun.version }));

export default app;
```

## How it works

- **`new Hono()`** creates the app; **`app.get(path, handler)`** adds a route. The handler gets a context `c` and returns `c.text(...)`, `c.json(...)` or `c.html(...)`.
- **`c.req.param("name")`** reads a path parameter.
- **`app.use(logger())`** adds middleware to every route: here it logs each request to the console.
- **`export default app`**: Hono's app has a `fetch` method, and Bun serves a default export with one on port 3000, so there's no `Bun.serve` call to write.

## Run it locally

Install Hono in a new folder and run the file with Bun, which serves the default export:

```sh
bun add hono
bun index.ts
curl localhost:3000/api/hello/Bun
```

## More

Open the official [Hono Bun starter](https://runbun.dev/?repo=honojs/starter/tree/main/templates/bun) straight from GitHub in the playground. [Frameworks](/compatibility/frameworks/) lists what else runs.
