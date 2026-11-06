---
title: "Bun WebSocket server example: a chat with pub/sub"
description: "A Bun.serve WebSocket server with server.upgrade, open and message handlers, and publish/subscribe, plus the HTML page that talks to it, running in your browser."
sidebar:
  order: 3
  label: WebSocket chat
---

`Bun.serve` upgrades a request to a WebSocket with `server.upgrade(req)`, and a `websocket` object handles the socket's events. This example serves a chat page at `/` and its socket at `/chat`. Press **Run**, then type into the page in the preview.

```ts playground mode=preview height=auto
const page = `<!doctype html>
<form id="send"><input id="text" placeholder="Say something" autofocus> <button>Send</button></form>
<pre id="log"></pre>
<script>
  const ws = new WebSocket(new URL("chat", location.href.replace(/^http/, "ws")));
  ws.onmessage = (e) => (log.textContent += e.data + "\\n");
  send.onsubmit = (e) => {
    e.preventDefault();
    ws.send(text.value);
    text.value = "";
  };
</script>`;

Bun.serve({
  routes: {
    "/": () => new Response(page, { headers: { "Content-Type": "text/html" } }),
  },
  fetch(req, server) {
    // Upgrade /chat to a WebSocket; upgrade returns false if the request wasn't one.
    if (new URL(req.url).pathname === "/chat" && server.upgrade(req)) return;
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("chat");
      ws.send("Welcome! Messages go to everyone in the chat.");
    },
    message(ws, message) {
      // publish reaches every subscriber except the sender, so echo to the sender too.
      ws.publish("chat", `someone: ${message}`);
      ws.send(`you: ${message}`);
    },
  },
});
```

## How it works

- **`server.upgrade(req)`** turns the request into a WebSocket and returns `true`; the `fetch` handler then returns nothing. It returns `false` for a request that isn't a WebSocket handshake.
- **`websocket.open`, `message`, `close`** handle every socket's events in one place, instead of a listener per socket.
- **`ws.subscribe(topic)`** and **`ws.publish(topic, data)`** are Bun's built-in pub/sub: publishing reaches every socket subscribed to the topic but the sender.

## Run it locally

Save the code as `index.ts`, run `bun index.ts` and open `http://localhost:3000` in two browser tabs: a message sent in one shows up in the other, through `publish`.

## In the playground

The preview page connects to your server through the playground's service worker, so the socket never leaves the browser. Only the preview page can connect; see [Bun APIs](/compatibility/bun/#bunserve) for what WebSockets support here.
