// `bun test -u` with Local Bun (src/remoteRunner.ts): the page sends the project to a real runner (packages/connect),
// native Bun updates the snapshots, and the changed files land in the VFS. Also what the page refuses: an older runner
// (no `snapshots` feature), and a `files` message that isn't for a run that asked or names a path outside the allowlist.
// Run with bun: `bun scripts/remote-snapshots.ts`. Exits 1 on a mismatch.
import { VFS } from "@runbun/vfs";
import type { ClientMessage, ServerMessage } from "@runbun/connect/protocol";
import { startRunner } from "../../../packages/connect/src/server.ts";

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
Object.assign(globalThis, {
  navigator: { serviceWorker: {} },
  BroadcastChannel: class {
    postMessage() {}
  },
});
const { RemoteRunner } = await import("../src/remoteRunner.ts");
type LocalBun = ConstructorParameters<typeof RemoteRunner>[2];

const ORIGIN = "https://runbun.dev";
const runner = startRunner({ port: 0 });
// @ts-expect-error Bun's WebSocket takes headers
const ws = new WebSocket(runner.url, { headers: { origin: ORIGIN } });
const listeners = new Set<(m: ServerMessage) => void>();
let sent: ClientMessage[] = [];
const hello = await new Promise<Extract<ServerMessage, { t: "hello" }>>((resolve) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data) as ServerMessage;
    if (m.t === "hello") return resolve(m);
    for (const fn of listeners) fn(m);
  };
});
const local = (features: string[]): LocalBun => ({
  bun: hello.bun,
  sandbox: hello.sandbox,
  features,
  send: (m) => (sent.push(m), ws.send(JSON.stringify(m))),
  on: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
  closed: new Promise(() => {}),
});

const test = `import { expect, test } from "bun:test";
test("snaps", () => {
  expect({ a: 1 }).toMatchSnapshot();
  expect(1 + 1).toMatchInlineSnapshot();
});
`;
const make = (features: string[], lines: string[] = []) => {
  const vfs = new VFS();
  vfs.write("a.test.ts", test);
  vfs.write("notes.txt", "mine");
  const r = new RemoteRunner(vfs, (_k: string, ...m: unknown[]) => void lines.push(m.join(" ")), local(features));
  return { vfs, r };
};

try {
  // 1. -u: the .snap and the inline snapshot arrive.
  {
    sent = [];
    const lines: string[] = [];
    const { vfs, r } = make(["snapshots"], lines);
    const res = await r.runTests(["a.test.ts"], ["-u"]);
    const run = sent.find((m) => m.t === "run") as Extract<ClientMessage, { t: "run" }>;
    eq("the run asks to update", run.updateSnapshots, true);
    eq("it passes", res.failed, 0);
    eq("the .snap is in the VFS", /exports\[`snaps 1`\]/.test(vfs.readText("__snapshots__/a.test.ts.snap") ?? ""), true);
    eq("the inline snapshot is in the test file", /toMatchInlineSnapshot\(`?2`?\)/.test(vfs.readText("a.test.ts") ?? ""), true);
    eq("nothing else changed", vfs.readText("notes.txt"), "mine");
    eq("the console says what was written", lines.some((l) => l.includes("[local] wrote ") && l.includes("__snapshots__/a.test.ts.snap")), true);
  }

  // 2. A plain run syncs new snapshots without asking to update.
  {
    sent = [];
    const { vfs, r } = make(["snapshots"]);
    await r.runTests(["a.test.ts"]);
    const run = sent.find((m) => m.t === "run") as Extract<ClientMessage, { t: "run" }>;
    eq("a plain run doesn't update", run.updateSnapshots, false);
    eq("a new snapshot still arrives", vfs.exists("__snapshots__/a.test.ts.snap"), true);
  }

  // 3. An older runner: the old refusal, nothing sent.
  {
    sent = [];
    const lines: string[] = [];
    const { vfs, r } = make([], lines);
    const res = await r.runTests(["a.test.ts"], ["-u"]);
    eq("an old runner is refused", res.failed, 1);
    eq("with a message that says to update it", lines.some((l) => /snapshots update only in the browser.*update @runbun\/connect/.test(l)), true);
    eq("nothing was sent", sent.length, 0);
    eq("nothing was written", vfs.exists("__snapshots__/a.test.ts.snap"), false);
  }

  // 4. Other flags are still refused.
  {
    sent = [];
    const { r } = make(["snapshots"]);
    eq("another flag is refused", (await r.runTests(["a.test.ts"], ["--bail"])).failed, 1);
    eq("and nothing is sent", sent.length, 0);
  }

  // 5. A `files` message the page must not apply, from a runner that answers as the test says (no real run).
  const hostile = (id: string): ServerMessage =>
    ({
      t: "files",
      id,
      files: [
        { path: "__snapshots__/good.snap", text: "// ok" },
        { path: "../x", text: "no" },
        { path: "/etc/x", text: "no" },
        { path: "notes.txt", text: "overwritten" },
        { path: "package.json", text: "{}" },
        { path: "other.test.ts", text: "a test file this run never sent" },
        { path: "node_modules/p/__snapshots__/p.snap", text: "no" },
        { path: "__snapshots__/../notes.txt", text: "no" },
        { path: "__snapshots__/bin.snap", text: { b64: "AAAA" } },
        { path: "__snapshots__/big.snap", text: "x".repeat(2 * 1024 * 1024) },
        { path: "a.test.ts", text: "// rewritten test file" },
      ],
    }) as unknown as ServerMessage;
  const scripted = (features: string[]) => {
    const own = new Set<(m: ServerMessage) => void>();
    const log: ClientMessage[] = [];
    const vfs = new VFS();
    vfs.write("a.test.ts", test);
    vfs.write("notes.txt", "mine");
    const fake: LocalBun = {
      bun: "x",
      sandbox: "none",
      features,
      send: (m) => void log.push(m),
      on: (fn) => (own.add(fn), () => void own.delete(fn)),
      closed: new Promise(() => {}),
    };
    const r = new RemoteRunner(vfs, () => {}, fake);
    const emit = (m: ServerMessage) => own.forEach((fn) => fn(m));
    const runId = async () => {
      while (!log.some((m) => m.t === "run")) await Bun.sleep(5);
      return (log.find((m) => m.t === "run") as { id: string }).id;
    };
    return { vfs, r, emit, runId };
  };
  {
    // A test run that asked: the allowlisted paths only, once.
    const { vfs, r, emit, runId } = scripted(["snapshots"]);
    const done = r.runTests(["a.test.ts"]);
    const id = await runId();
    emit(hostile(id));
    emit({ t: "files", id, files: [{ path: "__snapshots__/again.snap", text: "no" }] });
    emit({ t: "exit", id, code: 0, signal: null });
    await done;
    eq("only the allowlisted paths are applied", [...vfs.list()].sort(), ["__snapshots__/good.snap", "a.test.ts", "notes.txt"]);
    eq("a project file isn't overwritten", vfs.readText("notes.txt"), "mine");
    eq("its own test file may be", vfs.readText("a.test.ts"), "// rewritten test file");
  }
  {
    // A run that didn't ask (a program, not tests; or an older runner): nothing is applied.
    for (const [what, features, start] of [
      ["a program run", ["snapshots"], (r: InstanceType<typeof RemoteRunner>) => r.start("index.ts")],
      ["an older runner's test run", [], (r: InstanceType<typeof RemoteRunner>) => r.runTests(["a.test.ts"])],
    ] as const) {
      const { vfs, r, emit, runId } = scripted([...features]);
      const done = start(r);
      const id = await runId();
      emit(hostile(id));
      emit({ t: "exit", id, code: 0, signal: null });
      await done;
      eq(`${what}: nothing applied`, [...vfs.list()].sort(), ["a.test.ts", "notes.txt"]);
      eq(`${what}: its test file is untouched`, vfs.readText("a.test.ts"), test);
    }
  }
} finally {
  ws.close();
  runner.stop();
}
if (bad) process.exit(1);
console.log("remote snapshots: ok");
process.exit(0);
