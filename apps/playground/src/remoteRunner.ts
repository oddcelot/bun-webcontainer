import { PACKED_REQUEST, PACKED_RESPONSE, type FileData, type ServerMessage } from "@runbun/connect/protocol";
import type { VFS } from "@runbun/vfs";
import type { LocalBun } from "./localBun";
import { SKIP } from "./persist";
import { isShellCommand } from "./scripts";
import { Runner, type LogFn, type TestResults } from "./runner";

/** A program that neither serves nor exits by then is running: Run is done starting. */
const SETTLE_MS = 1500;
/** How long Stop waits for the runner to say the program is gone. */
const STOP_TIMEOUT = 3000;

interface Current {
  id: string;
  test: boolean;
  /** Where the runner proxies the program's Bun.serve; set once the run phase starts. */
  preview?: string;
  started: boolean;
  killed: boolean;
  output: string;
  partial: { 1: string; 2: string };
  settle(): void;
  exited: Promise<void>;
  done(): void;
}

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * The Runner that runs the project with native Bun on this machine (localBun.ts) instead of in a Web Worker. The
 * project's files go over with each run (node_modules stays on the runner's side, where native `bun install` fills
 * it); output comes back as console lines; previews keep going through the service worker and Runner's preview path
 * (cookies, redirects, pending responses), with the last hop a fetch to the runner instead of a message to a worker.
 */
export class RemoteRunner extends Runner {
  private current?: Current;
  /** One project per tab: the runner keeps its directory (and node_modules) between runs. */
  private project = `pg-${crypto.randomUUID().slice(0, 8)}`;

  constructor(
    private files: VFS,
    private out: LogFn,
    private local: LocalBun,
  ) {
    super(files, out);
    local.on((m) => this.onMessage(m));
    // boot.ts says so in the console and moves runs to the browser.
    void local.closed.then(() => {
      const c = this.current;
      if (c) this.finish(c, 1);
    });
  }

  private snapshot(): Record<string, FileData> {
    const files: Record<string, FileData> = {};
    for (const path of this.files.files.keys()) {
      if (SKIP.test(path)) continue;
      const text = this.files.textOf(path);
      if (text === undefined) continue;
      files[path] = text === null ? { b64: toBase64(this.files.readBytes(path)!) } : text;
    }
    return files;
  }

  private begin(test: boolean): Current {
    let settle!: () => void, done!: () => void;
    this.ready = new Promise<void>((r) => (settle = r));
    const exited = new Promise<void>((r) => (done = r));
    const c: Current = { id: crypto.randomUUID().slice(0, 12), test, started: false, killed: false, output: "", partial: { 1: "", 2: "" }, settle, exited, done };
    this.current = c;
    this.exitCode = undefined;
    return c;
  }

  override async start(entry: string, tests?: string[], args: string[] = []): Promise<void> {
    await this.stop();
    if (isShellCommand(entry, args)) {
      // The runner takes a file to run; a script line it would have to run through a shell of its own.
      this.out("error", `[local] only "bun <file>" scripts and installed packages' bins run with local Bun: "${args[1]}"`);
      this.exitCode = 1;
      return;
    }
    const c = this.begin(!!tests);
    this.local.send({ t: "run", id: c.id, project: this.project, files: this.snapshot(), entry, args, test: tests });
    await this.ready;
  }

  /** Native Bun reports failed tests in all, not per file (no `results`). */
  override async runTests(files: string[]): Promise<TestResults> {
    await this.start("", files);
    await this.current?.exited;
    return { failed: this.failed };
  }

  /** `bun install` on the runner, without running anything. */
  async install(): Promise<void> {
    await this.stop();
    const c = this.begin(false);
    this.local.send({ t: "run", id: c.id, project: this.project, files: this.snapshot(), entry: "", install: true });
    await c.exited;
  }

  override async stop(): Promise<void> {
    this.endPending();
    const c = this.current;
    if (!c) return;
    c.killed = true;
    this.local.send({ t: "kill", id: c.id });
    await Promise.race([c.exited, new Promise((r) => setTimeout(r, STOP_TIMEOUT))]);
    if (this.current === c) this.current = undefined;
  }

  protected override serving(): boolean {
    return !!this.current?.preview;
  }

  protected override async forward(req: { path: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }, port: MessagePort) {
    const c = this.current!;
    const abort = new AbortController();
    port.onmessage = ({ data }) => data?.type === "cancel" && abort.abort();
    try {
      const res = await fetch(c.preview!.replace(/\/$/, "") + req.path, {
        method: req.method,
        headers: { [PACKED_REQUEST]: JSON.stringify(req.headers.filter(([k]) => !/^(host|origin|referer)$/i.test(k))) },
        body: req.body,
        signal: abort.signal,
      });
      const head = res.headers.get(PACKED_RESPONSE);
      const { status, statusText, headers } = head ? JSON.parse(head) : { status: res.status, statusText: res.statusText, headers: [...res.headers] };
      port.postMessage({ type: "head", status, statusText, headers });
      const reader = res.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const data = value.slice().buffer;
        port.postMessage({ type: "chunk", data }, [data]);
      }
      port.postMessage({ type: "end" });
    } catch (e) {
      if (!abort.signal.aborted) port.postMessage({ type: "error", message: String(e) });
    }
  }

  /** Output arrives in chunks; the console takes lines (stdout as log, stderr as error). */
  private line(c: Current, fd: 1 | 2, data: string) {
    const lines = (c.partial[fd] + data).split("\n");
    c.partial[fd] = lines.pop()!;
    for (const l of lines) this.out(fd === 1 ? "log" : "error", l);
  }

  private finish(c: Current, code: number) {
    for (const fd of [1, 2] as const) if (c.partial[fd]) this.out(fd === 1 ? "log" : "error", c.partial[fd]), (c.partial[fd] = "");
    if (c.test) this.failed = Number(/(\d+) fail/.exec(c.output)?.[1] ?? (code ? 1 : 0));
    if (this.current === c) this.current = undefined;
    if (!c.started) this.exitCode = code;
    else if (!c.killed) this.onExit?.(code);
    c.settle();
    c.done();
  }

  private onMessage(m: ServerMessage) {
    const c = this.current;
    if (m.t === "error") return this.out("error", `[local] ${m.message}`), c && (!m.id || m.id === c.id) && this.finish(c, 1);
    if (!c || !("id" in m) || m.id !== c.id) return;
    if (m.t === "out") {
      if (c.test) c.output += m.data;
      this.line(c, m.fd, m.data);
    } else if (m.t === "phase" && m.phase === "approval") this.out("sys", "[local] waiting for you to allow this page in the terminal where the runner runs");
    else if (m.t === "phase" && m.phase === "install") this.out("sys", "[bun install] on this machine (native Bun)");
    else if (m.t === "started") {
      c.preview = m.preview;
      // A test run is over when it exits; a program is started once it serves, or keeps running for a moment.
      if (!c.test)
        setTimeout(() => {
          if (this.current !== c) return;
          c.started = true;
          c.settle();
        }, SETTLE_MS);
    } else if (m.t === "listening") {
      c.started = true;
      c.settle();
    } else if (m.t === "exit") this.finish(c, m.code ?? (m.signal ? 128 : 1));
  }
}
