// Hono's context storage (its middleware keeps the request in an AsyncLocalStorage; getContext() reads it): concurrent
// requests that await in the middleware, the handler and a library's frames must each read their own request.
// Native Bun fetches its own server and prints the bodies; in the playground the page does (scripts/als.ts).
import { Hono } from "hono";
import { contextStorage, getContext } from "hono/context-storage";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const app = new Hono();
app.use(contextStorage());
app.use(async (c, next) => {
  c.set("rid", `rid-${c.req.path.slice(1)}`);
  await sleep(c.req.path === "/a" ? 6 : 1);
  await next();
  c.header("x-after", getContext().get("rid"));
});
const lookup = async () => {
  await sleep(1);
  return getContext().get("rid");
};
app.get("/ping", (c) => c.text("pong"));
app.get("/done", (c) => {
  setTimeout(() => (console.log("__end__"), server.stop(true)), 50);
  return c.text("ok");
});
app.get("/:id", async (c) => {
  await sleep(c.req.path === "/a" ? 4 : 2);
  const viaLib = await lookup();
  try {
    await Promise.reject(new Error("x"));
  } catch {
    return c.text(`${viaLib} ${getContext().get("rid")} ${getContext().req.path}`);
  }
  return c.text("unreachable");
});
const server = Bun.serve({ port: 3020, fetch: app.fetch });

if (!Bun.version.includes("browser")) {
  const get = async (p: string) => {
    const r = await fetch(new URL(p, server.url));
    return `${await r.text()} [${r.headers.get("x-after")}]`;
  };
  console.log(`bodies=${(await Promise.all(["/a", "/b", "/c"].map(get))).join(" | ")}`);
  await get("/done");
}
