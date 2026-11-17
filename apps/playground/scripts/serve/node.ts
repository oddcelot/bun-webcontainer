// A node:http server whose "upgrade" listener accepts WebSockets with `ws` (scripts/serve.ts, client.ts nodeClient).
// ws isn't installed: Bun's own serves it, to `import`, `require` and the resolvers alike.
import http from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

console.log("ws:", require("ws").WebSocketServer === WebSocketServer, import.meta.resolve("ws"), require.resolve("ws"), Bun.resolveSync("ws", import.meta.dir));

const wss = new WebSocketServer({ noServer: true });
const sockets = new Map<WebSocket, string>();
const server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>node</title>"));
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const name = req.url!.slice(1);
    sockets.set(ws, name);
    ws.send(`hello ${name}`);
    ws.on("message", (m, isBinary) => {
      if (isBinary) return ws.send(new Uint8Array([...(m as Buffer)].reverse()));
      if (String(m) === "close-me") return ws.close(4002, "server bye");
      ws.send(`echo ${m}`);
      for (const [other] of sockets) if (other !== ws) other.send(`${name}: ${m}`);
    });
    ws.on("close", (code, reason) => {
      sockets.delete(ws);
      for (const [other] of sockets) other.send(`${name} left ${code} ${reason}`);
    });
  });
});
server.listen(Number(process.env.SERVE_PORT ?? 8080), () => console.log("listening"));
