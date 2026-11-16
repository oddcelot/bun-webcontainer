// The channel a blocked program reads its synchronous child from (spawnSync, execSync, execFileSync, Bun.spawnSync;
// processes.ts spawnChildSync). The program can't take messages while it waits, so what the page would post it about
// that child (its output, its exit) and the file changes made meanwhile come through a buffer shared with whoever owns
// its Worker: the page (runner.ts), or the content origin's host frame (host/main.ts; a shared buffer can't leave
// its agent cluster for the editor's). That owner writes one part at a time into a fixed window and the program, done
// with it, says so by message (a blocked worker can still post); a part bigger than the window goes over in pieces,
// so any amount of output fits.
//
// Only on a cross-origin isolated page: SharedArrayBuffer and Atomics.wait.

/** The header's Int32 slots, then the data window. */
const STATE = 0; // 0: empty (the owner may write); 1: a part is in the window
const KIND = 1;
const LENGTH = 2;
const MORE = 3; // 1: the part goes on in the next window
const HEAD = 16;
/** How many bytes go over at once. */
export const SYNC_WINDOW = 256 * 1024;

/** A part's kind: the child's stdout or stderr, a file change, its exit (JSON `{ code, signal }`); for `prompt()`, bytes for stdin, or its end. */
export const Part = { Stdout: 1, Stderr: 2, Vfs: 3, Exit: 4, Stdin: 5, StdinEnd: 6 } as const;
export type Part = (typeof Part)[keyof typeof Part];

export type SyncOpen = { type: "sync-open"; id: number; sab: SharedArrayBuffer };
export type VfsOp = { op: "write" | "mkdir" | "remove"; path: string; data?: unknown };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A file change as bytes: a JSON head (its length first), then the file's bytes for a write of bytes. */
function encodeVfs(m: VfsOp): Uint8Array {
  const bytes = m.data instanceof Uint8Array ? m.data : undefined;
  const head = enc.encode(JSON.stringify({ op: m.op, path: m.path, data: bytes ? undefined : m.data }));
  const out = new Uint8Array(4 + head.length + (bytes?.length ?? 0));
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  if (bytes) out.set(bytes, 4 + head.length);
  return out;
}

export function decodeVfs(b: Uint8Array): VfsOp {
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
  const head = JSON.parse(dec.decode(b.subarray(4, 4 + n))) as VfsOp;
  if (head.op === "write" && head.data === undefined) head.data = b.slice(4 + n);
  return head;
}

/**
 * The owner's side, one per Worker: `fromWorker` takes the program's channel messages, `toWorker` what would be
 * posted to it; each says whether it took the message. `deliver` posts to the Worker (for nothing here: everything
 * meant for a blocked program goes into the window).
 */
export class SyncRelay {
  private open?: { id: number; ctl: Int32Array; data: Uint8Array; queue: { kind: Part; bytes: Uint8Array }[]; busy: boolean; ended: boolean };

  /** A message from the Worker: true if it was the channel's. */
  fromWorker(m: unknown): boolean {
    const msg = m as { type?: string; id?: unknown; sab?: unknown } | null;
    if (msg?.type === "sync-open") {
      // The Worker runs project code, which can post anything: only a buffer that holds the window is used.
      const sab = msg.sab;
      if (!(sab instanceof SharedArrayBuffer) || sab.byteLength !== HEAD + SYNC_WINDOW || typeof msg.id !== "number") return true;
      this.open = { id: msg.id, ctl: new Int32Array(sab, 0, HEAD / 4), data: new Uint8Array(sab, HEAD), queue: [], busy: false, ended: false };
      return true;
    }
    // A reader that is done (a `prompt()` got its line): what comes next goes to the Worker as messages again.
    if (msg?.type === "sync-close") {
      if (this.open && msg.id === this.open.id) this.open = undefined;
      return true;
    }
    if (msg?.type === "sync-ack") {
      const o = this.open;
      if (!o || msg.id !== o.id) return true;
      o.busy = false;
      if (o.ended && !o.queue.length) this.open = undefined;
      else this.pump();
      return true;
    }
    return false;
  }

  /** A message for the Worker: true if it went into the window instead (the program is blocked on its child). */
  toWorker(m: unknown): boolean {
    const o = this.open;
    // Once its exit is on the way the program stops reading: later messages wait in its queue as usual.
    if (!o || o.ended) return false;
    const msg = m as { type?: string; id?: number; ev?: string; fd?: number; data?: Uint8Array | null; code?: number; signal?: string | null };
    // The console's input for a program blocked in `prompt()` (reader 0): bytes, or null for its end.
    if (msg?.type === "stdin" && o.id === 0) return this.push(msg.data ? Part.Stdin : Part.StdinEnd, msg.data ?? new Uint8Array(0)), true;
    if (msg?.type === "proc" && msg.id === o.id) {
      if (msg.ev === "out") this.push(msg.fd === 2 ? Part.Stderr : Part.Stdout, msg.data!);
      else if (msg.ev === "exit") {
        this.push(Part.Exit, enc.encode(JSON.stringify({ code: msg.code, signal: msg.signal ?? null })));
        o.ended = true;
      }
      return true;
    }
    // The program sees what its child wrote as soon as it returns, as it would on disk.
    if (msg?.type === "vfs") return this.push(Part.Vfs, encodeVfs(msg as VfsOp)), true;
    return false;
  }

  private push(kind: Part, bytes: Uint8Array) {
    this.open!.queue.push({ kind, bytes });
    this.pump();
  }

  /** The next part (or piece of one) into the window, once the program took the last. */
  private pump() {
    const o = this.open;
    if (!o || o.busy || !o.queue.length) return;
    const head = o.queue[0]!;
    const n = Math.min(head.bytes.length, SYNC_WINDOW);
    o.data.set(head.bytes.subarray(0, n));
    const more = n < head.bytes.length;
    if (more) head.bytes = head.bytes.subarray(n);
    else o.queue.shift();
    Atomics.store(o.ctl, KIND, head.kind);
    Atomics.store(o.ctl, LENGTH, n);
    Atomics.store(o.ctl, MORE, more ? 1 : 0);
    o.busy = true;
    Atomics.store(o.ctl, STATE, 1);
    Atomics.notify(o.ctl, STATE);
  }
}

/** `worker`, its channel messages handled by a relay and what is posted to it going through the relay first. */
export function withSyncRelay(worker: Worker): Worker {
  const relay = new SyncRelay();
  const post = worker.postMessage.bind(worker) as (m: unknown, t?: Transferable[] | StructuredSerializeOptions) => void;
  // Ahead of the owner's onmessage (it is set later), which never sees these.
  worker.addEventListener("message", (e) => relay.fromWorker(e.data) && e.stopImmediatePropagation());
  worker.postMessage = ((m: unknown, t?: Transferable[] | StructuredSerializeOptions) => relay.toWorker(m) || post(m, t)) as Worker["postMessage"];
  return worker;
}

/**
 * The program's side: a channel for child `id`, opened with `post` (before the spawn message, so the owner holds
 * what comes back). `next` blocks until the next whole part, or returns undefined once `deadline` (ms since the
 * epoch) passed.
 */
export class SyncReader {
  private sab = new SharedArrayBuffer(HEAD + SYNC_WINDOW);
  private ctl = new Int32Array(this.sab, 0, HEAD / 4);
  private data = new Uint8Array(this.sab, HEAD);
  private pieces: Uint8Array[] = [];
  constructor(
    private id: number,
    private post: (m: unknown) => void,
  ) {
    post({ type: "sync-open", id, sab: this.sab } satisfies SyncOpen);
  }
  next(deadline = Infinity): { kind: Part; bytes: Uint8Array } | undefined {
    // A part that goes on over several windows is kept across a call that ran out of time.
    const pieces = this.pieces;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      Atomics.wait(this.ctl, STATE, 0, left === Infinity ? undefined : left);
      if (Atomics.load(this.ctl, STATE) !== 1) continue;
      const kind = Atomics.load(this.ctl, KIND) as Part;
      const more = Atomics.load(this.ctl, MORE) === 1;
      pieces.push(this.data.slice(0, Atomics.load(this.ctl, LENGTH)));
      Atomics.store(this.ctl, STATE, 0);
      this.post({ type: "sync-ack", id: this.id });
      if (more) continue;
      this.pieces = [];
      if (pieces.length === 1) return { kind, bytes: pieces[0]! };
      const all = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of pieces) all.set(p, at), (at += p.length);
      return { kind, bytes: all };
    }
  }
}
