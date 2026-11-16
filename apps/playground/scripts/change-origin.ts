// Who the embed's `change` event says changed a file (src/embed/changes.ts, src/runner.ts): a host that grades the
// reader's code on each change skips the program's, an install's and its own, so a program that writes a file as it starts, which a
// grade restarts, must not read as the reader's or the grading never stops. A write that leaves a file as it was is no
// change at all. Run with bun: `bun scripts/change-origin.ts`. Exits 1 on a mismatch.
import { VFS } from "@runbun/vfs";

let bad = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  bad++;
  console.error(`✗ ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

Bun.plugin({
  name: "runner-deps",
  setup(b) {
    const stub = "export const resetSyncEsm = () => {}, serveModule = () => {}, vfsRoot = () => '/', serveLazyRead = () => {}, splitPackage = () => {};";
    b.onLoad({ filter: /\/src\/(moduleServer|pkgStore)\.ts$/ }, () => ({ contents: stub, loader: "js" }));
  },
});

class FakeWorker {
  static last: FakeWorker;
  /** What the program does as it starts, before it reports ready. */
  static onStart = () => {};
  onmessage?: (e: { data: unknown }) => void;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: { type: string }) {
    if (m.type === "start")
      queueMicrotask(() => {
        FakeWorker.onStart();
        this.send({ type: "ready" });
      });
    if (m.type === "flush") queueMicrotask(() => this.send({ type: "flushed" }));
  }
  /** A message from the worker, as the running program's fs calls send them (worker/runtime.ts). */
  send(data: unknown) {
    this.onmessage?.({ data });
  }
  addEventListener() {}
  terminate() {}
}
Object.assign(globalThis, {
  navigator: { serviceWorker: {} },
  Worker: FakeWorker,
  BroadcastChannel: class {
    postMessage() {}
  },
});

const { Runner } = await import("../src/runner.ts");
const { watchChanges } = await import("../src/embed/changes.ts");
const install = await import("../src/install.ts");

const vfs = new VFS();
vfs.write("index.ts", "console.log(1);\n");
vfs.write("check.test.ts", "// the host's\n");
const runner = new Runner(vfs, () => {});
let events: unknown[] = [];
const generated = new Set(["check.test.ts"]);
const asHost = watchChanges(vfs, () => runner.applying, () => install.installWriting, (path) => path.startsWith("node_modules/") || generated.has(path), (d) => events.push(d));
const take = () => [events, (events = [])][0];
const program = (op: string, ...args: unknown[]) => FakeWorker.last.send({ type: "vfs", op, args });

// The reader's save (the editor, the file tree and the console all write the VFS directly).
vfs.write("index.ts", "console.log(2);\n");
eq("an editor save is the reader's", take(), [{ path: "index.ts", removed: false, by: "reader" }]);
vfs.write("index.ts", "console.log(2);\n");
eq("saving the same text is no change", take(), []);

// The host's writeFile and removeFile.
asHost(() => vfs.write("extra.ts", "export {};\n"));
eq("writeFile is the host's", take(), [{ path: "extra.ts", removed: false, by: "host" }]);
asHost(() => vfs.write("extra.ts", "export {};\n"));
eq("writeFile with the same text is no change", take(), []);
asHost(() => vfs.remove("extra.ts"));
eq("removeFile is the host's", take(), [{ path: "extra.ts", removed: true, by: "host" }]);
vfs.write("after-host.ts", "");
eq("after the host's, the reader's again", take(), [{ path: "after-host.ts", removed: false, by: "reader" }]);

// The running program's writes, as the worker mirrors them back: at startup, and later.
FakeWorker.onStart = () => program("write", "app.db", new Uint8Array([1, 2, 3]));
await runner.start("index.ts");
program("write", "log.txt", "started\n");
eq("a program's writes are the program's", take(), [
  { path: "app.db", removed: false, by: "program" },
  { path: "log.txt", removed: false, by: "program" },
]);
program("write", "app.db", new Uint8Array([1, 2, 3]));
eq("the same bytes again are no change", take(), []);
program("write", "app.db", new Uint8Array([1, 2, 4]));
eq("other bytes are", take(), [{ path: "app.db", removed: false, by: "program" }]);
program("rename", "log.txt", "old.txt");
program("remove", "old.txt");
eq("its renames and removals too", take(), [
  { path: "log.txt", removed: true, by: "program" },
  { path: "old.txt", removed: false, by: "program" },
  { path: "old.txt", removed: true, by: "program" },
]);
program("write", "node_modules/x/index.js", "");
eq("node_modules stays quiet", take(), []);
vfs.write("index.ts", "console.log(3);\n");
eq("the reader's save while the program runs is still the reader's", take(), [{ path: "index.ts", removed: false, by: "reader" }]);
asHost(() => vfs.write("check.test.ts", "// changed\n"));
eq("generated files stay quiet", take(), []);
await runner.stop();

// A test run's writes are the program's as well.
FakeWorker.onStart = () => program("write", "fixture.json", "{}");
await runner.runTests(["a.test.ts"]);
eq("a test's writes are the program's", take(), [{ path: "fixture.json", removed: false, by: "program" }]);

// An install's bun.lock: a host that grades on the reader's changes skips it, or the install a project runs on load
// sets off a second grade. A project without dependencies resolves without the registry.
vfs.write("package.json", '{ "name": "app" }\n');
take();
await install.bunInstall(vfs, {} as never, () => {});
eq("an install's bun.lock is the install's", take(), [{ path: "bun.lock", removed: false, by: "install" }]);
vfs.write("bun.lock", "{}\n");
eq("after it, the reader's again", take(), [{ path: "bun.lock", removed: false, by: "reader" }]);

if (bad) process.exit(1);
console.log("change origin: ok");
process.exit(0);
