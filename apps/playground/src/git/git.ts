import { BASE } from "../base";
import type { VFS } from "@runbun/vfs";
import { apply, follow, snapshot, type Op } from "./mirror";
import type { FromWorker, ToWorker } from "./worker";

// `git` in the console and the Git panel: gitoxide (gix) compiled to wasm32-wasip1 (crates/git-wasm), a WASI command
// run once per invocation (wasi.ts). It runs in a worker (worker.ts) over a copy of the project's files that follows
// the page's (mirror.ts); what a command changed comes back to the page's VFS. Loaded on first use.

const dec = new TextDecoder();

export type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** What git wrote to stdout, undecoded (a blob that isn't text). */
  bytes: Uint8Array;
};

/** Whether git was started yet: nothing git-related loads until a command or the Git panel needs it. */
export let gitLoaded = false;

type Client = { worker: Worker; flush: () => void; pending: Map<number, (r: FromWorker) => void>; running: number; touched: Set<string> };
const clients = new WeakMap<VFS, Client>();
let ids = 0;

/** The worker for `vfs`, its copy filled and following the page's changes from here on. */
function client(vfs: VFS): Client {
  let c = clients.get(vfs);
  if (c) return c;
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "git" });
  const post = (m: ToWorker) => worker.postMessage(m);
  let applying = false;
  const self: Client = { worker, flush: () => {}, pending: new Map(), running: 0, touched: new Set() };
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const r = e.data;
    if ("changes" in r) {
      applying = true;
      try {
        apply(vfs, r.changes);
      } finally {
        applying = false;
      }
      // A path the user changed while the command ran reached the copy after it: git's version (now the page's) goes
      // back, so the two agree.
      const again: Op[] = [];
      for (const f of r.changes.files) if (self.touched.has(f.path)) again.push({ write: { ...f, data: vfs.read(f.path) as string | Uint8Array } });
      if (again.length) post({ ops: again });
    }
    if (!--self.running) self.touched.clear();
    self.pending.get(r.id)?.(r);
    self.pending.delete(r.id);
  };
  post({ ops: snapshot(vfs) });
  self.flush = follow(
    vfs,
    (ops) => {
      if (self.running) for (const op of ops) if ("write" in op) self.touched.add(op.write.path);
      post({ ops });
    },
    () => applying,
  ).flush;
  clients.set(vfs, (c = self));
  return c;
}

const text = (chunks: Uint8Array[]) => chunks.map((c) => dec.decode(c, { stream: true })).join("") + dec.decode();

/** Every command waits for the one before it: two over one repository would race on .git/. */
let tail: Promise<unknown> = Promise.resolve();

async function exec(vfs: VFS, args: string[], colors: boolean): Promise<GitResult> {
  gitLoaded = true;
  const c = client(vfs);
  const id = ++ids;
  c.flush();
  c.running++;
  const r = await new Promise<FromWorker>((resolve) => {
    c.pending.set(id, resolve);
    c.worker.postMessage({ run: { id, args, env: colors ? { GIT_COLOR: "1" } : {}, wasm: new URL(`${BASE}git.wasm`, location.href).href, proxy: new URL(`${BASE}git-proxy/`, location.href).href } } satisfies ToWorker);
  });
  if ("error" in r) throw new Error(r.error);
  const bytes = new Uint8Array(r.out.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of r.out) {
    bytes.set(b, at);
    at += b.length;
  }
  return { exitCode: r.exitCode, stdout: text(r.out), stderr: text(r.err), bytes };
}

/** Runs `git <args>` over `vfs` (the project root is the repository's worktree), after the commands queued before it. */
export function git(vfs: VFS, args: string[], { colors = true } = {}): Promise<GitResult> {
  const run = tail.then(() => exec(vfs, args, colors));
  tail = run.catch(() => {});
  return run;
}
