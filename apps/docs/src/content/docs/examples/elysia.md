---
title: "Elysia playground: run an Elysia app in your browser"
description: "An Elysia server with typed path parameters, a JSON body and validation, installed from npm and running on Bun in your browser."
sidebar:
  order: 7
  label: Elysia
---

[Elysia](https://elysiajs.com/) is a web framework built for Bun. This example installs it from npm and serves a small API. Press **Run**: the install and the server both happen in your browser.

```ts playground mode=preview height=auto deps="elysia" requests='GET / => Hello Elysia; GET /user/617; POST /user {"name":"Ada"}'
import { Elysia, t } from "elysia";

new Elysia()
  .get("/", () => "Hello Elysia")
  .get("/user/:id", ({ params: { id } }) => ({ id, name: `User ${id}` }))
  .post("/user", ({ body }) => ({ created: body.name }), {
    body: t.Object({ name: t.String() }),
  })
  .listen(3000);
```

## How it works

- **`.get` and `.post`** register routes; a handler returns a string, an object (sent as JSON) or a `Response`.
- **`params`** are typed from the path, so `id` is known to be a string without a cast.
- **`t.Object(...)`** validates the request body: post `{}` instead and Elysia answers with a 422 explaining what's missing.
- **`.listen(3000)`** starts the server on top of `Bun.serve`.

## Run it locally

Install Elysia in a new folder and run the file with Bun:

```sh
bun add elysia
bun index.ts
curl -X POST localhost:3000/user -H "Content-Type: application/json" -d '{"name":"Ada"}'
```

## More

The playground has a bigger [Elysia example](https://runbun.dev/?example=elysia-demo), and one on the [Elysia 2 release candidate](https://runbun.dev/?example=elysia2-demo) with plugins, cookies, server-sent events and a WebSocket chat. [Frameworks](/compatibility/frameworks/) lists what else runs.
