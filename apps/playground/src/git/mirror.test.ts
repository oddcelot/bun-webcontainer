// node apps/playground/src/git/mirror.test.ts
// The git worker's copy of the project (mirror.ts) without the worker: a page VFS and its copy, git.wasm run over the
// copy and its changes taken back, as git.ts and worker.ts do over postMessage. The two must stay equal (node_modules
// aside), the page's edits must reach the copy before a command, and git's own changes must not come back to it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { VFS } from "@runbun/vfs";
import { apply, applyOps, collect, follow, skipped, snapshot, type Op } from "./mirror.ts";
import { runWasi } from "./wasi.ts";

const GIT = new URL("../../../../crates/git-wasm/target/wasm32-wasip1/release/git.wasm", import.meta.url).pathname;
const dec = new TextDecoder();
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

/** The page and the worker's copy, wired as git.ts and worker.ts wire them. */
function pair(module?: WebAssembly.Module) {
  const page = new VFS();
  const copy = new VFS();
  const sent: Op[][] = [];
  let applying = false;
  const send = (ops: Op[]) => {
    sent.push(ops);
    applyOps(copy, ops);
  };
  const started = () => send(snapshot(page));
  const tracker = { flush: () => {} };
  const begin = () => {
    started();
    tracker.flush = follow(page, send, () => applying).flush;
  };
  const git = async (...args: string[]) => {
    tracker.flush();
    let out = "";
    let err = "";
    let exitCode = 0;
    const changes = await collect(copy, async () => {
      ({ exitCode } = await runWasi(module!, copy, {
        args: ["git", ...args],
        env: { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com" },
        stdout: (b) => (out += dec.decode(b)),
        stderr: (b) => (err += dec.decode(b)),
      }));
    });
    applying = true;
    try {
      apply(page, changes);
    } finally {
      applying = false;
    }
    assert.equal(exitCode, 0, `git ${args.join(" ")}: ${err}${out}`);
    return out;
  };
  return { page, copy, sent, begin, git, flush: () => tracker.flush() };
}

/** What the copy should hold of the page: everything but node_modules, with the write times. */
const state = (v: VFS, all = false) => ({
  files: [...v.files.keys()].filter((k) => all || !skipped(k)).sort().map((k) => [k, v.readText(k), v.mtimes.get(k)]),
  dirs: [...v.dirs].filter((d) => all || !skipped(d)).sort(),
});
const tick = () => new Promise((r) => setTimeout(r));

test("the copy starts as the page, without node_modules", () => {
  const p = pair();
  p.page.write("a.ts", "a");
  p.page.write("src/b.ts", "b");
  p.page.write("node_modules/x/index.js", "x");
  p.page.mkdir("empty");
  p.begin();
  assert.deepEqual(state(p.copy, true), state(p.page));
  assert.equal(p.copy.exists("node_modules"), false);
});

test("edits, removals, renames and folders follow, batched once per microtask", async () => {
  const p = pair();
  p.page.write("a.ts", "a");
  p.page.write("d/x.ts", "x");
  p.begin();
  p.page.write("a.ts", "a2");
  p.page.write("node_modules/y/i.js", "y");
  p.page.rename("d", "e");
  p.page.mkdir("f/g");
  assert.equal(p.copy.readText("a.ts"), "a", "nothing sent before the microtask");
  await tick();
  assert.equal(p.sent.length, 2, "one batch after the snapshot");
  assert.deepEqual(state(p.copy, true), state(p.page));
  p.page.remove("e");
  await tick();
  assert.deepEqual(state(p.copy, true), state(p.page));
});

test("flush sends what is batched before a command", () => {
  const p = pair();
  p.begin();
  p.page.write("saved.ts", "just saved");
  p.flush();
  assert.equal(p.copy.readText("saved.ts"), "just saved");
});

test("a replaced project (clear, then load) starts the copy over", async () => {
  const p = pair();
  p.page.write("old.ts", "old");
  p.begin();
  p.page.load(new Map([["new.ts", "new"], ["node_modules/z/i.js", "z"]]), new Set(["node_modules", "node_modules/z"]));
  await tick();
  assert.deepEqual(state(p.copy, true), state(p.page));
  assert.equal(p.copy.exists("old.ts"), false);
});

test("git.wasm over the copy: the page gets its changes, and they aren't sent back", async () => {
  if (!existsSync(GIT)) return console.log(`  (skipped: ${GIT} missing)`);
  const p = pair(await WebAssembly.compile(readFileSync(GIT)));
  p.page.write("index.ts", "console.log(1)\n");
  p.page.write("README.md", "# t\n");
  p.page.write("node_modules/x/index.js", "x\n");
  p.begin();
  await p.git("init");
  await p.git("add", ".");
  await p.git("commit", "-m", "first");
  await tick();
  assert.equal(p.sent.length, 1, "git's changes were not sent back to the copy");
  assert.deepEqual(state(p.copy, true), state(p.page), "page and copy agree, write times too");
  assert.ok(p.page.files.has(".git/HEAD"));
  assert.equal(p.page.exists("node_modules/x/index.js"), true, "the page keeps node_modules");

  // The page's edits reach the copy before the next command, without waiting for the microtask.
  p.page.write("index.ts", "console.log(2)\n");
  p.page.remove("README.md");
  assert.equal(await p.git("status", "-s"), " D README.md\n M index.ts\n");
  await p.git("add", "-A");
  await p.git("commit", "-m", "second");
  assert.equal(await p.git("status", "-s"), "");

  // A command that rewrites the worktree: the page's files follow.
  await p.git("switch", "-c", "other");
  p.page.write("other.ts", "o\n");
  await p.git("add", "other.ts");
  await p.git("commit", "-m", "third");
  await p.git("switch", "main");
  assert.equal(p.page.exists("other.ts"), false, "switching back removed the branch's file on the page");
  await p.git("reset", "--hard", "HEAD~1");
  assert.equal(p.page.readText("README.md"), "# t\n", "reset brought the file back on the page");
  await tick();
  assert.deepEqual(state(p.copy, true), state(p.page));
  assert.equal(await p.git("status", "-s"), "", "the index's cached times match the page's files");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${(e as Error).stack}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
