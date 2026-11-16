// How a `bun test` run ends when its worker doesn't report (src/runner.ts): an embed's run and test take turns, so a
// run that never settles holds every later one, and a host grades by `failed`, so one that didn't finish must not pass.
// Stop mid-test settles it as failed, a test that never yields is stopped by the watchdog, `process.exit` in a test
// (even code 0) fails, and the next run goes on as usual. Run with bun: `bun scripts/runner-stop.ts`. Exits 1 on a mismatch.
import { VFS } from "@runbun/vfs";

let bad = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  bad++;
  console.error(`✗ ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

// The page-side modules the runner serves modules with aren't needed here (and need Vite).
Bun.plugin({
  name: "runner-deps",
  setup(b) {
    const stub = "export const resetSyncEsm = () => {}, serveModule = () => {}, vfsRoot = () => '/', serveLazyRead = () => {};";
    b.onLoad({ filter: /\/src\/(moduleServer|pkgStore)\.ts$/ }, () => ({ contents: stub, loader: "js" }));
  },
});

/** A worker that answers as the test says: `answer` gets each start, and nothing answers a flush (a hung test). */
let answer: (w: FakeWorker) => void = () => {};
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage?: (e: { data: unknown }) => void;
  onerror?: (e: unknown) => void;
  terminated = false;
  /** The types of the messages it was sent. */
  got: string[] = [];
  constructor() {
    workers.push(this);
  }
  postMessage(m: { type: string }) {
    this.got.push(m.type);
    if (m.type === "start") queueMicrotask(() => answer(this));
  }
  send(data: unknown) {
    if (!this.terminated) this.onmessage?.({ data });
  }
  addEventListener() {}
  terminate() {
    this.terminated = true;
  }
}
Object.assign(globalThis, {
  navigator: { serviceWorker: {} },
  Worker: FakeWorker,
  BroadcastChannel: class {
    postMessage() {}
  },
});
// The watchdog's 30 s, made short; the flush timeout and the rest keep theirs.
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number) => realTimeout(fn, ms && ms >= 30_000 ? 50 : ms)) as typeof setTimeout;

const { Runner } = await import("../src/runner.ts");
const logs: string[] = [];
const runner = new Runner(new VFS(), (_level, text) => logs.push(text));
const within = <T>(p: Promise<T>, ms = 3000) => Promise.race([p, new Promise<"hung">((r) => realTimeout(() => r("hung"), ms))]);

// Stop while the test runs: the run settles, as failed, without per-file results.
answer = () => {};
const stopped = runner.runTests(["a.test.ts"]);
await new Promise((r) => realTimeout(r, 10));
void runner.stop();
eq("stop mid-test settles as failed", await within(stopped), { failed: 1 });
eq("the stopped worker is terminated", workers.at(-1)!.terminated, true);

// The next run reports as usual: what the stop left doesn't carry over.
answer = (w) => w.send({ type: "ready", failed: 0, results: [{ file: "a.test.ts", failed: 0 }] });
eq("the next test run reports", await within(runner.runTests(["a.test.ts"])), { failed: 0, results: [{ file: "a.test.ts", failed: 0 }] });

// A test that never yields: the watchdog stops it and the run fails.
answer = () => {};
eq("the watchdog ends a hung test run as failed", await within(runner.runTests(["loop.test.ts"])), { failed: 1 });
eq("and says so", logs.some((l) => /timed out/.test(l)), true);
eq("its worker is terminated", workers.at(-1)!.terminated, true);

// process.exit in a test, before `bun test` reported: even code 0 is a failure.
answer = (w) => w.send({ type: "exit", code: 0 });
eq("exit(0) mid-test fails", await within(runner.runTests(["exit.test.ts"])), { failed: 1 });
answer = (w) => w.send({ type: "exit", code: 3 });
eq("exit(3) mid-test fails", await within(runner.runTests(["exit.test.ts"])), { failed: 1 });

// A report that arrives after Stop doesn't overwrite the stopped run's failure.
answer = () => {};
const late = runner.runTests(["late.test.ts"]);
await new Promise((r) => realTimeout(r, 10));
const lateWorker = workers.at(-1)!;
const stopping = runner.stop();
lateWorker.send({ type: "ready", failed: 0, results: [{ file: "late.test.ts", failed: 0 }] });
await stopping;
eq("a report after Stop is ignored", await within(late), { failed: 1 });

// A run started in place of a starting one (Run pressed twice) settles the first instead of leaving it waiting.
answer = () => {};
const first = runner.start("index.ts");
await new Promise((r) => realTimeout(r, 10));
answer = (w) => w.send({ type: "ready" });
await within(runner.start("index.ts"));
eq("a replaced start settles", await within(first.then(() => "settled")), "settled");
await runner.stop();

// A preview sent while `bun test` replaced a running server waits for the server boot.ts starts again after it
// (`restoring`), instead of finding none in between and answering "No server running".
answer = (w) => w.send({ type: "ready" });
await within(runner.start("index.ts"));
runner.attach();
let restored = () => {};
runner.restoring = new Promise<void>((r) => (restored = r));
answer = (w) => realTimeout(() => w.send({ type: "ready", failed: 0, results: [] }), 20);
const testing = runner.runTests(["a.test.ts"]);
await new Promise((r) => realTimeout(r, 5));
const answered: unknown[] = [];
(navigator.serviceWorker as ServiceWorkerContainer).onmessage!({
  data: { type: "preview", req: { path: "/", method: "GET", headers: [], body: null } },
  ports: [{ postMessage: (d: unknown) => answered.push(d) }],
} as never);
await within(testing);
await new Promise((r) => realTimeout(r, 20));
eq("between the test and the restart, the preview still waits", answered, []);
answer = (w) => w.send({ type: "ready" });
await within(runner.start("index.ts"));
runner.restoring = undefined;
restored();
await new Promise((r) => realTimeout(r, 20));
eq("the restarted server gets it", workers.at(-1)!.got.includes("request"), true);
eq("and no 503 went back", answered, []);
await runner.stop();

if (bad) process.exit(1);
console.log("runner stop: ok");
process.exit(0);
