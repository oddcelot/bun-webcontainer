---
title: "Bun.serve example: a hello world HTTP server"
description: "A minimal Bun.serve HTTP server you can run in your browser: a fetch handler that answers every request, explained line by line."
sidebar:
  order: 1
  label: Bun.serve hello world
---

`Bun.serve` starts an HTTP server. This one answers every request with the same text. Press **Run**: the server starts in this page, in your browser, and the preview shows its answer.

```ts playground mode=preview height=auto
const server = Bun.serve({
  port: 3000,
  fetch(req) {
    const { pathname } = new URL(req.url);
    return new Response(`Hello from Bun.serve! You asked for ${pathname}`);
  },
});

console.log(`Listening on ${server.url}`);
```

## How it works

- **`fetch(req)`** runs for every request. It gets a standard [`Request`](https://developer.mozilla.org/docs/Web/API/Request) and returns a [`Response`](https://developer.mozilla.org/docs/Web/API/Response), the same classes as the browser's `fetch`, so nothing here is Bun-specific except `Bun.serve` itself.
- **`port`** defaults to 3000 (or the `PORT` environment variable), so you can leave it out.
- **`server.url`** is the address the server listens on, handy for logging.

Change the path in the preview's request bar, say to `/about`, and press Send: the handler reads it from `req.url`.

## Run it locally

Save the code as `index.ts` and run it with Bun:

```sh
bun index.ts
curl http://localhost:3000/hello
```

`bun --hot index.ts` reloads the handler when you save, without dropping the server.

## In the playground

The playground runs `Bun.serve` in your browser: a service worker hands the preview's requests to your server, so nothing goes over the network. For routing, see [routes and a JSON API](/examples/bun-serve-routes/); everything `Bun.serve` supports here is listed under [Bun APIs](/compatibility/bun/#bunserve).
