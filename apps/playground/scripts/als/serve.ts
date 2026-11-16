// Bun.serve and AsyncLocalStorage: a handler runs in the context `Bun.serve` was called in, not the requester's, and
// a handler that does its own `als.run` (the middleware shape) keeps each request's store through its awaits.
// Native Bun fetches its own server; in the playground the page does (a program can't reach its own server there),
// and prints the bodies itself (scripts/als.ts), so only what the handlers saw is printed here.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();
const out: string[] = [];
const log = (label: string) => out.push(`${label}=${als.getStore() ?? "-"}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = als.run("serve", () =>
  Bun.serve({
    port: 3010,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/done") {
        out.sort();
        setTimeout(() => {
          console.log(out.join("\n"));
          console.log("__end__");
          server.stop(true);
        }, 5);
        return new Response("ok");
      }
      if (path === "/ping") return new Response("pong");
      if (path === "/") return new Response("hi"); // the playground's preview frame loads it
      if (path === "/ctx") {
        log("serve-fetch");
        await sleep(1);
        log("serve-after");
        return new Response(als.getStore() ?? "-");
      }
      const id = path.slice(1);
      return als.run(id, async () => {
        await sleep(id === "x" ? 4 : 1);
        await null;
        log(`per-request-${id}`);
        return new Response(`${als.getStore()}`);
      });
    },
  }),
);

if (!Bun.version.includes("browser")) {
  const get = async (p: string) => (await fetch(new URL(p, server.url))).text();
  const bodies = await als.run("client", async () => {
    const ctx = await get("/ctx");
    return [ctx, ...(await Promise.all(["/x", "/y", "/z"].map(get)))];
  });
  out.push(`bodies=${bodies.join(",")}`);
  await get("/done");
}
