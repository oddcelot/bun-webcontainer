// axios's default adapter (node:http underneath) against a Bun.serve of the same program. `import` and `require` must
// both reach axios's node build, and Bun has no XMLHttpRequest, so axios picks its http adapter.
console.log("start");
import axios from "axios";
const req = require("axios");

console.log("globals:", typeof XMLHttpRequest, typeof window, typeof document);
console.log("import:", import.meta.resolve("axios").split("/node_modules/")[1]);
console.log("adapters:", JSON.stringify(axios.defaults.adapter), typeof axios.getAdapter("http"));
console.log("same:", typeof req.get, req.defaults.adapter.join());

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
