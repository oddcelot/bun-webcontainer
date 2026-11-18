import { FEATURE_COVERAGE, FEATURE_SNAPSHOTS, lcovPath, PACKED_REQUEST, PACKED_RESPONSE, SYNC_LIMITS, syncPath, type FileData, type ServerMessage } from "@runbun/connect/protocol";
import type { VFS } from "@runbun/vfs";
import type { LocalBun } from "./localBun";
import { SKIP } from "./persist";
import { readConfig } from "./projectConfig";
import { isShellCommand } from "./scripts";
import { Runner, type LogFn, type TestResults } from "./runner";
import { coverageOptions, isCoverageFlag } from "./coverage/options";

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
  /** A test run that asked for its changed snapshots back: the test files it sent as text, the only ones it may rewrite. */
  snapshots?: Set<string>;
  output: string;
  partial: { 1: string; 2: string };
  settle(): void;
  exited: Promise<void>;
  done(): void;
}

const UPDATE_FLAGS = ["-u", "--update-snapshots"];

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
  /** Whether the last test run counted coverage. */
  private coverageOn = false;

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
      this.out("error", `[local] Local Bun runs only "bun <file>" and installed bins, not "${args[1]}".`);
      this.exitCode = 1;
      return;
    }
    // A coverage run (its flags, or bunfig.toml's `[test]`) gets its lcov.info back where Bun writes it.
    // Without the wasm TOML parser (no Memory64), from the flags alone.
    const flagsOnly = () => {
      try {
        return args.some(isCoverageFlag) ? coverageOptions(args, undefined) : undefined;
      } catch {
        return undefined;
      }
    };
    const coverage = tests && this.local.features.includes(FEATURE_COVERAGE) ? ((await this.coverage(args)) ?? flagsOnly()) : undefined;
    const dir = coverage?.dir.replace(/^(\.\/+)+/, "").replace(/\/+$/, "");
    const lcov = coverage?.reporters.lcov ? lcovPath(dir && dir !== "." ? `${dir}/lcov.info` : "lcov.info") : undefined;
    this.coverageOn = !!coverage;
    const c = this.begin(!!tests);
    const files = this.snapshot();
    // Test runs ask for the files they changed (snapshots, inline snapshots) if the runner can send them; `-u` also
    // rewrites the ones that differ. `files` is only taken from a run that asked, and only for the paths it may change.
    const snapshots = !!tests && this.local.features.includes(FEATURE_SNAPSHOTS);
    if (snapshots || lcov) c.snapshots = new Set([...(snapshots ? tests!.filter((t) => typeof files[t] === "string") : []), ...(lcov ? [lcov] : [])]);
    // runbun.json's `env`, as in the browser (worker/runtime.ts); the runner leaves out names it keeps for itself.
    const env = readConfig((path) => this.files.readText(path)).env;
    this.local.send({
      t: "run",
      id: c.id,
      project: this.project,
      files,
      entry,
      args,
      test: tests,
      env,
      ...(snapshots && { updateSnapshots: args.some((a) => UPDATE_FLAGS.includes(a)) }),
      ...(tests && args.some(isCoverageFlag) && { coverage: args.filter(isCoverageFlag) }),
      ...(lcov && { lcov }),
    });
    await this.ready;
  }

  /** Native Bun reports failed tests in all, not per file (no `results`). */
  override async runTests(files: string[], args: string[] = []): Promise<TestResults> {
    // The runner tests the project in its own folder; it sends the changed snapshots and the coverage lcov.info back
    // (an older runner doesn't, and they would be lost).
    // The runner takes no other flags of `bun test`.
    const coverage = args.filter(isCoverageFlag);
    if (coverage.length && !this.local.features.includes(FEATURE_COVERAGE)) {
      this.out("error", `[local] bun test ${coverage.join(" ")}: this runner can't count coverage (update @runbun/connect, or switch Local Bun off for it).`);
      return { failed: 1 };
    }
    const update = args.filter((a) => !isCoverageFlag(a));
    if (update.length && !(update.every((a) => UPDATE_FLAGS.includes(a)) && this.local.features.includes(FEATURE_SNAPSHOTS))) {
      const old = UPDATE_FLAGS.includes(update[0]!) ? " with this runner (update @runbun/connect to update them here)" : "";
      this.out("error", `[local] bun test ${update.join(" ")}: snapshots update only in the browser${old}; switch Local Bun off to update them.`);
      return { failed: 1 };
    }
    await this.start("", files, args);
    await this.current?.exited;
    // Native Bun exits with 1 when a file is below bunfig.toml's coverageThreshold, with no test failed.
    const coverageFailed = this.coverageOn && !this.failed && !!this.exitCode;
    return { failed: this.failed, ...(coverageFailed && { coverageFailed: true }) };
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

  /**
   * Writes the files a test run changed into the project. They are the untrusted program's output: only from the run
   * that asked (`c.snapshots`), once, only paths `syncPath` allows (snapshot files, or a test file this run sent),
   * only text, within SYNC_LIMITS; anything else is dropped.
   */
  private applyFiles(c: Current, files: unknown) {
    const tests = c.snapshots;
    c.snapshots = undefined;
    if (!tests || !Array.isArray(files) || files.length > SYNC_LIMITS.count) return;
    const written: string[] = [];
    let total = 0;
    for (const f of files) {
      const path = syncPath(f?.path, tests);
      if (!path || typeof f.text !== "string" || f.text.length > SYNC_LIMITS.file || (total += f.text.length) > SYNC_LIMITS.total || SKIP.test(path)) continue;
      if (this.files.readText(path) === f.text) continue;
      this.files.write(path, f.text);
      written.push(path);
    }
    if (written.length) this.out("sys", `[local] wrote ${written.join(", ")}`);
  }

  private onMessage(m: ServerMessage) {
    const c = this.current;
    if (m.t === "error") return this.out("error", `[local] ${m.message}`), c && (!m.id || m.id === c.id) && this.finish(c, 1);
    if (!c || !("id" in m) || m.id !== c.id) return;
    if (m.t === "out") {
      if (c.test) c.output += m.data;
      this.line(c, m.fd, m.data);
    } else if (m.t === "phase" && m.phase === "approval") this.out("sys", "[local] allow this page in the runner's terminal");
    else if (m.t === "phase" && m.phase === "install") this.out("sys", "[bun install] running with native Bun on this machine");
    else if (m.t === "started") {
      c.preview = m.preview;
      // A test run is over when it exits; a program is started once it serves, or keeps running for a moment.
      if (!c.test)
        setTimeout(() => {
          if (this.current !== c) return;
          c.started = true;
          c.settle();
        }, SETTLE_MS);
    } else if (m.t === "files") this.applyFiles(c, m.files);
    else if (m.t === "listening") {
      c.started = true;
      c.settle();
    } else if (m.t === "exit") this.finish(c, m.code ?? (m.signal ? 128 : 1));
  }
}
