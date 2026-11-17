// node:diagnostics_channel: channels, tracing channels, stores, and the channels Bun's http client publishes.
import dc from "node:diagnostics_channel";
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import type { Case } from "./cases.ts";

export async function diagnosticsChannel(t: Case, log: (line: string) => void) {
  t("dc exports", () => Object.keys(dc).sort().join());
  t("dc same channel", () => dc.channel("a") === dc.channel("a"));
  t("dc hasSubscribers before", () => [dc.channel("b").hasSubscribers, dc.hasSubscribers("b"), dc.hasSubscribers("never")].join());
  t("dc publish", () => {
    const seen: string[] = [];
    const ch = dc.channel("c");
    const fn = (m: unknown, name: string | symbol) => seen.push(`${JSON.stringify(m)}@${String(name)}`);
    ch.subscribe(fn);
    ch.publish({ x: 1 });
    const has = ch.hasSubscribers;
    const off = ch.unsubscribe(fn);
    ch.publish({ x: 2 });
    return [seen.join(" "), has, off, ch.unsubscribe(fn), ch.hasSubscribers].join("|");
  });
  t("dc module subscribe", () => {
    const seen: unknown[] = [];
    const fn = (m: unknown) => seen.push(m);
    dc.subscribe("d", fn);
    dc.channel("d").publish(5);
    return [seen.join(), dc.hasSubscribers("d"), dc.unsubscribe("d", fn), dc.hasSubscribers("d")].join();
  });
  t("dc symbol name", () => {
    const s = Symbol("sym");
    let got = "";
    dc.subscribe(s, (_m, name) => (got = String(name)));
    dc.channel(s).publish(1);
    return got;
  });
  t("dc bad name", () => dc.channel(1 as never));
  t("dc bad subscriber", () => dc.channel("e").subscribe(1 as never));
  t("dc instanceof", () => [dc.channel("f") instanceof dc.Channel, {} instanceof dc.Channel].join());
  t("dc active instanceof", () => {
    const ch = dc.channel("g");
    const fn = () => {};
    ch.subscribe(fn);
    const r = ch instanceof dc.Channel;
    ch.unsubscribe(fn);
    return r;
  });
  t("dc proto names", () => {
    const ch = dc.channel("h");
    const fn = () => {};
    ch.subscribe(fn);
    const active = Object.getPrototypeOf(ch).constructor.name;
    ch.unsubscribe(fn);
    return [active, Object.getPrototypeOf(ch).constructor.name].join();
  });
  t("dc unsubscribe inactive", () => dc.channel("i").unsubscribe(() => {}));
  t("dc runStores", () => {
    const als = new AsyncLocalStorage<string>();
    const ch = dc.channel("j");
    const seen: string[] = [];
    ch.bindStore(als, (d) => `T(${String(d)})`);
    ch.subscribe((m) => seen.push(`sub ${String(m)} store=${als.getStore()}`));
    const r = ch.runStores("data", function (this: unknown, a: number, b: number) {
      seen.push(`fn this=${String(this)} store=${als.getStore()}`);
      return a + b;
    }, "self", 2, 3);
    return [r, seen.join(" / "), als.getStore(), ch.unbindStore(als), ch.unbindStore(als)].join("|");
  });
  t("dc runStores no transform", () => {
    const als = new AsyncLocalStorage<unknown>();
    const ch = dc.channel("k");
    ch.bindStore(als);
    return ch.runStores({ v: 1 }, () => JSON.stringify(als.getStore()));
  });
  t("dc runStores inactive", () => dc.channel("l").runStores(1, (a: number) => a * 2, undefined, 21));

  const traced = (name: string) => {
    const seen: string[] = [];
    const tc = dc.tracingChannel(name);
    const handlers = Object.fromEntries(
      (["start", "end", "asyncStart", "asyncEnd", "error"] as const).map((k) => [k, (m: Record<string, unknown>) => seen.push(`${k}(${["result", "error"].filter((p) => p in m).map((p) => `${p}=${m[p] instanceof Error ? (m[p] as Error).message : String(m[p])}`).join(",")})`)]),
    );
    tc.subscribe(handlers as never);
    return { tc, seen, off: () => tc.unsubscribe(handlers as never) };
  };
  t("tc channel names", () => {
    const tc = dc.tracingChannel("nm");
    return [tc.start.name, tc.end.name, tc.asyncStart.name, tc.asyncEnd.name, tc.error.name, tc.start === dc.channel("tracing:nm:start")].join();
  });
  t("tc hasSubscribers", () => {
    const tc = dc.tracingChannel("hs") as unknown as { hasSubscribers?: boolean };
    return String(tc.hasSubscribers);
  });
  t("tc traceSync", () => {
    const { tc, seen, off } = traced("sync");
    const ctx: Record<string, unknown> = { id: 1 };
    const r = tc.traceSync((a: number) => a * 2, ctx, undefined, 4);
    return [r, seen.join(" "), JSON.stringify(ctx), off(), off()].join("|");
  });
  t("tc traceSync throws", () => {
    const { tc, seen, off } = traced("syncerr");
    let caught = "";
    try {
      tc.traceSync(() => {
        throw new Error("boom");
      });
    } catch (e) {
      caught = (e as Error).message;
    }
    off();
    return [caught, seen.join(" ")].join("|");
  });
  {
    const { tc, seen, off } = traced("promise");
    const p = tc.tracePromise(async (a: number) => a + 1, {}, undefined, 1);
    const sync = seen.join(" ");
    const r = await p;
    log(`tc tracePromise: ${[r, sync, seen.join(" ")].join("|")}`);
    off();
  }
  {
    const { tc, seen, off } = traced("promiseerr");
    const r = await tc.tracePromise(async () => Promise.reject(new Error("nope"))).catch((e: Error) => `caught ${e.message}`);
    log(`tc tracePromise rejects: ${[r, seen.join(" ")].join("|")}`);
    off();
  }
  {
    const { tc, seen, off } = traced("thenable");
    const r = await tc.tracePromise(() => 7 as never);
    log(`tc tracePromise value: ${[r, seen.join(" ")].join("|")}`);
    off();
  }
  {
    const { tc, seen, off } = traced("cb");
    const r = await new Promise((resolve) => {
      const ret = tc.traceCallback(
        (a: number, cb: (e: unknown, v?: number) => void) => {
          setTimeout(() => cb(null, a * 3), 1);
          return "ret";
        },
        -1,
        {},
        undefined,
        5,
        (e: unknown, v: number) => resolve(`${ret} cb(${e},${v})`),
      );
    });
    log(`tc traceCallback: ${[r, seen.join(" ")].join("|")}`);
    off();
  }
  {
    const { tc, seen, off } = traced("cberr");
    const r = await new Promise((resolve) => tc.traceCallback((cb: (e: unknown) => void) => queueMicrotask(() => cb(new Error("bad"))), 0, {}, undefined, (e: Error) => resolve(e.message)));
    log(`tc traceCallback error: ${[r, seen.join(" ")].join("|")}`);
    off();
  }
  t("tc traceCallback no callback", () => dc.tracingChannel("nocb").traceCallback(() => 1, -1, {}, undefined, 1));
  t("tc from channels", () => {
    const tc = dc.tracingChannel({ start: dc.channel("s1"), end: dc.channel("s2"), asyncStart: dc.channel("s3"), asyncEnd: dc.channel("s4"), error: dc.channel("s5") });
    return [tc.start.name, tc.error.name].join();
  });
  t("tc bad channels", () => dc.tracingChannel({ start: 1 } as never));
  t("tc bad arg", () => dc.tracingChannel(5 as never));
  t("tc store", () => {
    const als = new AsyncLocalStorage<string>();
    const tc = dc.tracingChannel("store");
    tc.start.bindStore(als, () => "in-span");
    const r = tc.traceSync(() => als.getStore());
    tc.start.unbindStore(als);
    return [r, als.getStore()].join();
  });
  {
    const errs: string[] = [];
    const prev = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const onErr = (e: Error) => errs.push(e.message);
    process.on("uncaughtException", onErr);
    const ch = dc.channel("throws");
    const after: string[] = [];
    ch.subscribe(() => {
      throw new Error("subscriber failed");
    });
    ch.subscribe(() => after.push("second ran"));
    ch.publish(1);
    const sync = errs.length;
    await new Promise((r) => setTimeout(r, 20));
    process.off("uncaughtException", onErr);
    for (const l of prev) process.on("uncaughtException", l as never);
    log(`dc subscriber throws: ${[after.join(), sync, errs.join()].join("|")}`);
  }

  // The channels Bun's http client publishes (none for the server, none for fetch).
  {
    const seen: string[] = [];
    const names = ["http.client.request.created", "http.client.request.start", "http.client.request.error", "http.client.response.finish", "http.server.request.start", "http.server.response.finish", "undici:request:create"];
    const subs = names.map((n) => {
      const fn = (m: Record<string, unknown>) => seen.push(`${n}[${Object.keys(m).join()}]${m.request instanceof http.ClientRequest ? " req" : ""}${m.response instanceof http.IncomingMessage ? " res" : ""}${m.error ? ` ${(m.error as { code?: string }).code}` : ""}`);
      dc.subscribe(n, fn as never);
      return () => dc.unsubscribe(n, fn as never);
    });
    // Bun.serve: the playground's http.Server isn't reachable from its own http client.
    const server = Bun.serve({ port: 0, fetch: () => new Response("hi") });
    const port = server.port;
    await new Promise((r) => http.get(`http://localhost:${port}/x`, (res) => (res.resume(), res.on("end", r))));
    log(`http channels get: ${seen.splice(0).join(" ")}`);
    await fetch(`http://localhost:${port}/y`).then((r) => r.text());
    log(`http channels fetch: ${seen.splice(0).join(" ")}`);
    await new Promise((r) => http.get(`http://localhost:1/x`).on("error", r));
    log(`http channels error: ${seen.splice(0).join(" ")}`);
    server.stop(true);
    subs.forEach((off) => off());
  }
}
