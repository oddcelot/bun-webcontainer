// axios's node adapter (node:http underneath) against a Bun.serve of the same program.
const base = require("axios");

// The "http" adapter is axios's node one. By default the worker's XMLHttpRequest makes axios pick its xhr adapter
// (Bun has none), which is the browser's network, not node:http.
const axios = base.create({ adapter: "http" });

const server = Bun.serve({
  port: 3012,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/json") return Response.json({ method: req.method, body: await req.json(), ua: req.headers.get("x-a") });
    if (u.pathname === "/gone") return new Response("gone", { status: 410 });
    return new Response("hello " + u.search);
  },
});
console.log("start");
const a = await axios.get("http://localhost:3012/x?y=1");
console.log("get:", a.status, a.statusText, a.headers["content-type"], a.data);
const b = await axios.post("http://localhost:3012/json", { n: 1 }, { headers: { "x-a": "b" } });
console.log("post:", b.status, JSON.stringify(b.data));
const c = await axios.get("http://localhost:3012/gone").catch((e) => e);
console.log("404:", c.isAxiosError, c.response.status, c.response.data);
const d = await axios.get("http://localhost:1/").catch((e) => e);
console.log("refused:", d.code);
const e = await axios.get("http://localhost:3012/x", { responseType: "stream" });
let n = 0;
for await (const chunk of e.data) n += chunk.length;
console.log("stream:", n);
server.stop(true);
console.log("__end__");
