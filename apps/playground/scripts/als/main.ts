import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { chain, store } from "./lib.ts";

const als = store;
const other = new AsyncLocalStorage<number>();
const out: string[] = [];
const log = (label: string) => out.push(`${label}=${als.getStore() ?? "-"}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done: Promise<unknown>[] = [];
const track = <T>(p: Promise<T>) => (done.push(p), p);

// sync + nested
als.run("a", () => {
  log("sync");
  als.run("b", () => log("nested"));
  log("after-nested");
  als.exit(() => log("exit"));
  log("after-exit");
});
log("outside");

// await chains
async function inner() {
  await null;
  log("inner-await");
  await sleep(1);
  log("inner-sleep");
}
track(
  als.run("c", async () => {
    log("c0");
    await inner();
    log("c-after-inner");
    try {
      await Promise.reject(new Error("x"));
    } catch {
      log("c-catch");
    } finally {
      log("c-finally");
    }
    for await (const _ of (async function* () {
      yield 1;
      await sleep(1);
      yield 2;
    })())
      log("c-for-await");
    const r = await Promise.all([
      sleep(2).then(() => als.getStore()),
      (async () => {
        await sleep(1);
        return als.getStore();
      })(),
    ]);
    out.push(`all=${r.join(",")}`);
  }),
);

// awaits in another module (a library's frames between the run and the read)
track(
  als.run("lib", async () => {
    log("lib0");
    await chain(log);
    log("lib-after");
  }),
);

// two concurrent requests keep their own context
for (const id of ["r1", "r2"]) {
  track(
    als.run(id, async () => {
      await sleep(id === "r1" ? 5 : 1);
      log(`concurrent-${id}`);
      await null;
      log(`concurrent2-${id}`);
    }),
  );
}

// timers, nextTick, microtasks, immediate
als.run("t", () => {
  setTimeout(() => log("timeout"), 1);
  const iv = setInterval(() => {
    log("interval");
    clearInterval(iv);
  }, 1);
  setImmediate(() => log("immediate"));
  queueMicrotask(() => log("microtask"));
  process.nextTick(() => log("nextTick"));
  Promise.resolve().then(() => log("then"));
  Promise.reject(1).catch(() => log("catch"));
  Promise.resolve().finally(() => log("finally"));
});

// then registered in one context, promise created in another: the callback's context is the registration's
{
  let resolve!: () => void;
  const p = als.run("creator", () => new Promise<void>((r) => (resolve = r)));
  als.run("registrar", () => {
    p.then(() => log("then-registrar"));
  });
  als.run("resolver", () => resolve());
}

// EventEmitter: the listener runs in the emitter's context
{
  const ee = new EventEmitter();
  als.run("listener-registered", () => ee.on("ev", () => log("emitter")));
  als.run("emitter", () => ee.emit("ev"));
}

// enterWith, run returning value, two stores, disable
{
  const e = new AsyncLocalStorage<string>();
  track(
    (async () => {
      e.enterWith("entered");
      await null;
      out.push(`enterWith=${e.getStore()}`);
      await sleep(1);
      out.push(`enterWith2=${e.getStore()}`);
    })(),
  );
  out.push(`run-return=${als.run("v", () => 42)}`);
  other.run(7, () => als.run("two", () => out.push(`two-stores=${als.getStore()},${other.getStore()}`)));
  const d = new AsyncLocalStorage<string>();
  d.run("x", () => {
    d.disable();
    out.push(`disabled=${d.getStore() ?? "-"}`);
  });
}

// bind, snapshot, AsyncResource
{
  const bound = als.run("bound", () => AsyncLocalStorage.bind(() => als.getStore()));
  const snap = als.run("snap", () => AsyncLocalStorage.snapshot());
  const res = als.run("res", () => new AsyncResource("X"));
  out.push(`bind=${als.run("other", () => bound())}`);
  out.push(`snapshot=${als.run("other", () => snap(() => als.getStore()))}`);
  out.push(`resource=${als.run("other", () => res.runInAsyncScope(() => als.getStore()))}`);
  const rb = als.run("rb", () => res.bind(() => als.getStore()));
  out.push(`res.bind=${als.run("other", () => rb())}`);
  const sb = als.run("sb", () => AsyncResource.bind(() => als.getStore()));
  out.push(`static-bind=${als.run("other", () => sb())}`);
  out.push(`this=${als.run("th", () => res.runInAsyncScope(function (this: any, a: number) { return `${this.k}${a}`; }, { k: "k" }, 1))}`);
}

await Promise.all(done);
await sleep(20);
console.log(out.sort().join("\n"));
console.log("__end__");
