import { CookieJar, parseSetCookie, pathMatches, type Cookie } from "./cookieJar";
import { PreviewCookies, dirOf, pagePath } from "./previewCookies";
import { PANEL_COOKIE, joinCookies } from "./request";
import { pluginAnswered, pluginWorker, resetSyncEsm, serveModule, setCoverage, vfsRoot } from "./moduleServer";
import { watchedBy, type Watched } from "./watched";
import { coverageOptions, isCoverageFlag, type CoverageOptions } from "./coverage/options";
import { loadResolver, parseData } from "./resolver";
import type { VFS } from "@runbun/vfs";
import { serveLazyRead } from "./pkgStore";
import { withSyncRelay } from "./worker/syncChannel";
import { CONTENT_ORIGIN } from "./contentOrigin";
import { attach as attachDebugger, detach as detachDebugger, onDebugMessage } from "./debugSession";
import { answerAsks, connectHost, notifyStopped, readContentCookies, spawnWorker, writeContentCookies } from "./contentHost";

/** A program's child process (worker/processes.ts): its worker, and who started it under which id. */
type Proc = { worker: Worker; parent: Worker; id: number; ended: boolean; coverage?: CoverageOptions };
type Host = Awaited<ReturnType<typeof connectHost>>;
const enc = new TextEncoder();

/**
 * The coverage runs going on: a `bun test --coverage` run's, and spawned ones' (`bun test --coverage` as a child
 * process). While there is one, the project's files are served counting what runs (the latest's options).
 */
const coverageRuns = new Set<CoverageOptions>();
function covering(opts: CoverageOptions | undefined, on: boolean) {
  if (!opts) return;
  if (on) coverageRuns.add(opts);
  else coverageRuns.delete(opts);
  setCoverage([...coverageRuns].at(-1));
}

/** Tells preview pages (see previewWebSocket in swPage.ts) that their WebSockets' server is gone. */
const previewChannel = new BroadcastChannel("bun-preview");
/** A plain-text answer to a module request. */
const textResponse = (status: number, text: string) => ({ status, statusText: "", headers: [["content-type", "text/plain"]], body: new TextEncoder().encode(text).buffer });

/** A plain-text answer to a preview request, in the worker's streamed shape (sendResponse in worker/runtime.ts). */
function sendText(port: MessagePort, status: number, text: string) {
  const data = new TextEncoder().encode(text).buffer;
  port.postMessage({ type: "head", status, statusText: "", headers: [["content-type", "text/plain"]] });
  port.postMessage({ type: "chunk", data }, [data]);
  port.postMessage({ type: "end" });
}

/** How long a stopping worker gets to write its databases back. */
const FLUSH_TIMEOUT = 500;
/** How long a starting program gets before it counts as hung. */
const START_TIMEOUT = 15000;
/** How long `bun test` may run before it's stopped as hung (a test that never yields, which no per-test timeout ends). */
const TEST_TIMEOUT = 30_000;
/** How long the program a restart replaced gets to finish the preview responses it had begun. */
const DRAIN_TIMEOUT = 5000;
/** What the console puts before the replaced program's lines while it is still around (see `swap`). */
const PREVIOUS = "[previous] ";

/** `partial`: text that ends mid-line (a prompt written without its newline). */
export type LogFn = (level: string, text: string, partial?: boolean) => void;

/** What a `bun test` run found: failed tests in all, and per test file that ran (worker/node/test.ts TestOutcome). */
export type TestResults = { failed: number; results?: { file: string; failed: number }[]; coverageFailed?: boolean };

/** How a program's start went: up (its entry ran), ended itself (with this code), or neither in time. */
type Outcome = { kind: "ready" } | { kind: "exit"; code: number } | { kind: "timeout" } | { kind: "error"; message: string } | { kind: "cancelled" };

/** How `swap` went: the new program took over, it didn't start (the old one keeps going), or a Run or Stop came first. */
export type Swap = { kind: "swapped" } | { kind: "failed"; reason: string } | { kind: "superseded" };

export class Runner {
  /** The program that answers previews. */
  private worker?: Worker;
  /** A restart's new program while it starts next to `worker` (see `swap`), and how to give up on it. */
  private next?: { worker: Worker; cancel: () => void };
  /** Programs a restart replaced, finishing the preview responses they had begun. */
  private draining = new Set<Worker>();
  /** Counts Stops and restarts, so a `swap` still on its way can tell that something came after it. */
  private epoch = 0;
  protected ready: Promise<void> = Promise.resolve();
  /**
   * Set while a server that `bun test` replaced is started again after the test (boot.ts runTests): preview requests
   * wait for it instead of finding no server between the test's end and that start. Settles either way.
   */
  restoring?: Promise<void>;
  /** The exit code of the last started program once it ended itself (`process.exit`, an uncaught error). */
  exitCode: number | undefined;
  /** Called when a program that had started ends itself (one that ends while starting sets `exitCode` instead). */
  onExit?: (code: number) => void;
  /**
   * Whether the last started program didn't say it was up within START_TIMEOUT. It keeps running: it may only be slow
   * (`onLateStart` once it is up), or stuck.
   */
  startTimedOut = false;
  /** Called when a program whose start timed out (`startTimedOut`) is up after all. */
  onLateStart?: () => void;
  /**
   * Called with the ports the program answering previews serves, its child processes' after its own, whenever they
   * change (none once it stops), and the one the preview shows (see `choosePort`).
   */
  onPorts?: (ports: number[], shown: number | undefined) => void;
  /** Each program's (and child process's) ports as it last reported them: a restart's new program reports before it takes over. */
  private ports = new WeakMap<Worker, number[]>();
  /** The ports of each one's servers on port 0 (helpers the preview doesn't show), which the run's loopback requests reach too. */
  private helpers = new WeakMap<Worker, number[]>();
  /** Where each one's plain net servers listen (socket paths, ports), which the run's `net.connect`s reach. */
  private sockets = new WeakMap<Worker, (string | number)[]>();
  /** Called when the program starts or stops waiting for input on its stdin: the console then sends what is typed to `stdin`. */
  onStdinWait?: (on: boolean) => void;
  /** Called when the program switches its stdin to raw mode (`process.stdin.setRawMode`) or back: the console then sends each key as typed. */
  onStdinRaw?: (on: boolean) => void;
  /** The console's size in characters: what `process.stdout.columns` and `rows` report. */
  private ttySize = { cols: 80, rows: 24 };
  /** Child processes by their worker, and each program's children by the id it gave them. */
  private procs = new Map<Worker, Proc>();
  private kids = new WeakMap<Worker, Map<number, Proc>>();
  /** The content origin's host frame the programs run in, once a start connected it. */
  private host?: Host;

  constructor(
    private vfs: VFS,
    private log: LogFn,
  ) {
    this.attach();
    // Keep the worker's copy of the VFS coherent with edits made on the page while it runs.
    vfs.onChange(({ path, removed }) => {
      if (removed) this.mirror("remove", path);
      else this.mirror("write", path, vfs.read(path));
    });
    vfs.onDir((path, removed) => this.mirror(removed ? "remove" : "mkdir", path));
  }

  /** Makes this the runner that answers the service worker (previews); with two runners, the one in use. */
  attach() {
    navigator.serviceWorker.onmessage = (e) => this.onSw(e);
    // The content origin's service worker asks through its host frame (contentHost.ts).
    if (CONTENT_ORIGIN) answerAsks((e) => this.onSw(e));
  }

  /** Settles the start under way as stopped before it answered (a test run that didn't finish failed). */
  private abort?: () => void;

  /**
   * The worker whose op is being applied to the page VFS: it isn't echoed back to it, and the embed says the program
   * made the change.
   */
  applying?: Worker;

  /** Hands a page VFS change to the running programs (both while a restart overlaps), except the one that made it. */
  private mirror(op: "write" | "mkdir" | "remove", path: string, data?: unknown) {
    for (const w of [this.worker, this.next?.worker, ...this.procs.keys()])
      if (w && w !== this.applying) w.postMessage({ type: "vfs", op, path, data }); // cloned, not transferred: the page keeps its data
  }

  /**
   * Preview responses still on their way from the worker, by the service worker's port; true once the head went out.
   * A stopped worker never finishes them, so stop() does.
   */
  protected pending = new Map<MessagePort, { started: boolean; owner?: Worker }>();
  /**
   * The preview host's cookies the browser doesn't hold for us: the HttpOnly ones (the preview's scripts mustn't see
   * them, and scripts can't create them), and a copy of those a response set with a narrower Path than the preview's
   * root, for requests whose directory's cookie page doesn't see them (`/admin` from `/`). Kept across Runs, as a
   * browser keeps them across server restarts.
   */
  readonly cookies = new CookieJar();
  /** The path the preview's cookies live under in the browser (`/__preview/@<id>`), from sw.ts with each request. */
  private base: string | undefined;
  /** The browser's preview cookies, through blank pages under the base (previewCookies.ts). */
  private pages: PreviewCookies | undefined;
  /** Whether the browser keeps the preview's cookies (not where its origin is a third party); as last read. */
  private browserKeeps = true;

  /** The browser's cookies for requests in `dir` (`a=1; b=2`): what the page in that directory sees. */
  private async browserCookies(dir = "/"): Promise<string> {
    const base = this.base;
    if (!base) return "";
    // Project cookies live on the content origin: its host frame owns the cookie pages.
    if (CONTENT_ORIGIN) {
      const { cookie, usable } = await readContentCookies(base, dir).catch(() => ({ cookie: "", usable: this.browserKeeps }));
      this.browserKeeps = usable;
      return cookie;
    }
    if (this.pages?.base !== base) this.pages = new PreviewCookies(base);
    this.browserKeeps = await this.pages.usable();
    return this.pages.read(dir);
  }

  /**
   * Request headers with the preview's cookies in place of any the request brought: the browser's for its directory,
   * which the preview's scripts may have set or changed, and the jar's HttpOnly ones and those that page can't see;
   * joined with the one set in the request panel (request.ts PANEL_COOKIE), which wins for a cookie in all. A jar copy
   * of a cookie the page sees but the browser no longer has, a script deleted.
   */
  private async withCookies(path: string, headers: [string, string][], base: string | undefined) {
    if (base) this.base = base;
    const panel = headers.find(([k]) => k.toLowerCase() === PANEL_COOKIE)?.[1];
    const out = headers.filter(([k]) => k.toLowerCase() !== "cookie" && k.toLowerCase() !== PANEL_COOKIE);
    const dir = dirOf(path);
    const browser = await this.browserCookies(dir);
    const names = new Set(browser.split("; ").map((pair) => pair.split("=", 1)[0]));
    // Where the browser keeps none, the jar has them all.
    const seen = (c: Readonly<Cookie>) => this.browserKeeps && !c.httpOnly && pathMatches(pagePath(dir), c.path);
    if (this.base) for (const c of this.cookies.list()) if (seen(c) && !names.has(c.name)) this.cookies.drop(c.name, c.path);
    const jar = this.cookies.header(path, (c) => !this.base || !seen(c));
    const cookie = joinCookies(joinCookies(jar, browser), panel);
    if (cookie) out.push(["cookie", cookie]);
    return out;
  }

  /**
   * A response's Set-Cookie headers, for a request to `path`. Each goes into the browser under the preview's path, so
   * the preview's scripts see it in document.cookie and DevTools lists it, except HttpOnly ones (into the jar, and out
   * of the browser). One for the preview's root (`Path=/`) is the browser's alone, read back through the cookie page;
   * one for a narrower path stays in the jar too, which sends it where it applies.
   */
  private storeCookies(path: string, setCookies: string[]) {
    const base = this.base;
    for (const line of setCookies) {
      const c = parseSetCookie(path, line);
      if (!c) continue;
      if (!base) {
        this.cookies.put(c);
        continue;
      }
      const assign = browserCookie(base, c.httpOnly ? { ...c, expires: 0 } : c);
      if (CONTENT_ORIGIN) void writeContentCookies(base, [assign]).catch(() => {});
      else document.cookie = assign;
      if (c.httpOnly || c.path !== "/" || !this.browserKeeps) this.cookies.put(c);
      else this.cookies.drop(c.name, c.path);
    }
  }

  /** The preview's cookies, from both places (the `cookies` console command); paths as the server sees them. */
  async listCookies(): Promise<Readonly<Cookie>[]> {
    const browser = (await this.browserCookies())
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        return { name: eq < 0 ? "" : pair.slice(0, eq), value: eq < 0 ? pair : pair.slice(eq + 1), path: "/", expires: Infinity };
      });
    return [...browser, ...this.cookies.list()];
  }

  /** Deletes the preview's cookies in both places. */
  async clearCookies() {
    const base = this.base;
    if (base) {
      const lines = (await this.listCookies()).map((c) => browserCookie(base, { ...c, expires: 0 }));
      if (CONTENT_ORIGIN) await writeContentCookies(base, lines).catch(() => {});
      else for (const line of lines) document.cookie = line;
    }
    this.cookies.clear();
  }

  private async onSw(e: Pick<MessageEvent, "data" | "ports">) {
    const port = e.ports[0];
    const m = e.data;
    if (m.type === "module") {
      try {
        port.postMessage(await serveModule(this.vfs, m.path, (msg) => this.log("error", msg), m.target, m.worker));
      } catch (err) {
        port.postMessage(textResponse(500, String(err)));
      }
    } else if (m.type === "preview") {
      await this.serverUp();
      const { base, ...req } = m.req;
      const headers = await this.withCookies(req.path, req.headers, base);
      if (!this.serving()) return sendText(port, 503, "No server running. Press Run.");
      // Relayed instead of handing the worker `port`, so an unfinished response can still be ended.
      const { port1, port2 } = new MessageChannel();
      const entry = { started: false, owner: this.worker && this.route().worker };
      this.pending.set(port, entry);
      port1.onmessage = ({ data }) => {
        if (!this.pending.has(port)) return;
        if (data.type === "head") {
          const headers = data.headers as [string, string][];
          this.storeCookies(m.req.path, headers.filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => v));
          data = { ...data, headers: headers.filter(([k]) => k.toLowerCase() !== "set-cookie") };
        }
        port.postMessage(data, data.type === "chunk" ? [data.data] : []);
        if (data.type === "head") entry.started = true;
        else if (data.type === "end" || data.type === "error") {
          this.pending.delete(port);
          port1.close();
        }
      };
      // A cancel from the service worker (the page went away) goes on to the worker.
      port.onmessage = ({ data }) => port1.postMessage(data);
      this.forward({ ...req, headers }, port2);
    } else if (m.type === "ws") {
      await this.serverUp();
      const { base, ...ws } = m;
      const headers = await this.withCookies(m.path, m.headers, base);
      if (!this.worker) return port.postMessage({ type: "close", code: 1011, reason: "No server running" });
      const to = this.route(ws.port);
      to.worker.postMessage({ ...ws, headers, port: to.port }, [port]);
    }
  }

  /** Until the start under way has settled: again for one that replaced it meanwhile, and after `restoring`. */
  private async serverUp() {
    let ready: Promise<void>;
    do {
      ready = this.ready;
      await ready;
      await this.restoring;
    } while (ready !== this.ready);
  }

  /** Whether a program is there to answer preview requests. */
  protected serving(): boolean {
    return !!this.worker;
  }

  /**
   * Hands a preview request (cookies already in its headers) to the program; the answer comes back on `port` in the
   * streamed shape (`head`, `chunk`…, `end` or `error`; see sendResponse in worker/runtime.ts).
   */
  protected forward(req: { path: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }, port: MessagePort) {
    const to = this.route();
    to.worker.postMessage({ type: "request", req, port: to.port }, [port]);
  }

  /** The program's child processes (and theirs), in the order they were started. */
  private *descendants(worker: Worker): Generator<Worker> {
    for (const kid of this.kids.get(worker)?.values() ?? [])
      if (!kid.ended) {
        yield kid.worker;
        yield* this.descendants(kid.worker);
      }
  }

  /**
   * Who answers a preview request, for `port` if it names one (a WebSocket to another port): the program, if it serves
   * that port or (with none named) any; else the first of its child processes that does (a script's `bun run dev`
   * starting the server), on that port; else the program, whose runtime says it has no server. Only call while a
   * program runs.
   */
  private route(port?: number): { worker: Worker; port?: number } {
    const main = this.worker!;
    // With none named, the port the reader picked (`choosePort`), while it is still served.
    port ??= this.picked;
    const own = this.ports.get(main) ?? [];
    if (port === undefined ? own.length : own.includes(port)) return { worker: main, port };
    for (const w of this.descendants(main)) {
      const ports = this.ports.get(w) ?? [];
      if (port === undefined ? ports.length : ports.includes(port)) return { worker: w, port: port ?? ports[0] };
    }
    return { worker: main, port };
  }

  /**
   * Tells `onPorts` what the program answering previews serves now, its child processes included, and which of those
   * ports the preview shows. A picked port that is no longer served is forgotten: the preview goes back to the default.
   */
  private reportPorts() {
    const main = this.worker;
    const all = main ? [...new Set([main, ...this.descendants(main)].flatMap((w) => this.ports.get(w) ?? []))] : [];
    if (this.picked !== undefined && !all.includes(this.picked)) this.picked = undefined;
    // The default (`route` with no port) is the first of the list: the program's first, else its first child's.
    this.onPorts?.(all, this.picked ?? all[0]);
  }

  /** The port the preview shows when the reader picked one of several (the status bar), until it is no longer served. */
  private picked?: number;

  /**
   * Sends the preview (its requests, and WebSockets that name no port) to the server on `port` instead of the default,
   * while the program or one of its child processes serves it. The caller reloads the preview.
   */
  choosePort(port: number) {
    this.picked = port;
    this.reportPorts();
  }

  /** Ends the preview responses still on their way (only `owner`'s, if given): the program that would have finished them is gone. */
  protected endPending(owner?: Worker) {
    for (const [port, { started, owner: o }] of this.pending) {
      if (owner && o !== owner) continue;
      if (started) port.postMessage({ type: "error", message: "The server stopped." });
      else sendText(port, 503, "The server stopped before it answered.");
      this.pending.delete(port);
    }
  }

  /** Lets `worker` write its open databases back (their bytes arrive as "vfs" messages); gives up after FLUSH_TIMEOUT. */
  private flush(worker: Worker): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FLUSH_TIMEOUT);
      worker.addEventListener("message", (e) => {
        if (e.data?.type !== "flushed") return;
        clearTimeout(timer);
        resolve();
      });
      worker.postMessage({ type: "flush" });
    });
  }

  /** The preview pages' WebSockets were to the program that is gone: they drop, so the pages can reconnect. */
  private dropSockets() {
    previewChannel.postMessage("stopped");
    if (CONTENT_ORIGIN) notifyStopped();
  }

  /**
   * Stops the program, and a restart's new one still starting. It first gets a moment to write open databases back,
   * so a Run or Stop doesn't drop a program's last writes; a worker that doesn't answer in time is terminated anyway.
   * A worker that ended itself has written them already (`flush` false).
   */
  async stop(flush = true) {
    this.epoch++;
    this.startTimedOut = false;
    this.next?.cancel();
    for (const w of this.draining) this.end(w);
    this.draining.clear();
    this.endPending();
    await this.retire(flush);
  }

  /** Text (UTF-8 bytes) for the program's stdin, or null to close it (end of input). */
  stdin(data: Uint8Array | null) {
    this.worker?.postMessage({ type: "stdin", data }, data ? [data.buffer] : []);
  }

  /** The console's terminal changed size (or opened): the program's stdout reports it. */
  resize(cols: number, rows: number) {
    this.ttySize = { cols, rows };
    this.worker?.postMessage({ type: "tty", cols, rows });
  }

  /** What each program watches with `fs.watch` (worker/node/fs.ts), as it last reported. */
  private watching = new WeakMap<Worker, Watched[]>();
  /** Whether the program answering previews watches every one of these files itself (watched.ts). */
  watches(paths: Iterable<string>): boolean {
    return !!this.worker && watchedBy(this.watching.get(this.worker) ?? [], paths);
  }

  /** Whether a program is running (answering previews or not). */
  get running(): boolean {
    return !!this.worker;
  }

  /** Stops the program that answers previews, and only that one (a restart's new program, if any, keeps starting). */
  private async retire(flush: boolean) {
    const worker = this.worker;
    const abort = this.abort;
    this.worker = undefined;
    this.abort = undefined;
    if (!worker) return;
    this.onStdinWait?.(false);
    this.reportPorts();
    this.endPending(worker);
    this.dropSockets();
    if (flush) await this.flush(worker);
    this.end(worker);
    abort?.();
  }

  /** Failed tests of the last `runTests`. */
  failed = 0;
  /** Whether the last `runTests` had a file below its `coverageThreshold`. */
  coverageFailed = false;
  /** Failed tests per file of the last `runTests`; undefined when it ended before reporting (process.exit). */
  results: TestResults["results"];

  /** `bun test`: runs test files in a fresh worker (replacing any server) and resolves when the run is over. */
  async runTests(files: string[], args: string[] = []): Promise<TestResults> {
    // `--coverage`: the project's files are served counting what runs, for this run only.
    const coverage = await this.coverage(args);
    covering(coverage, true);
    try {
      await this.start("", files, args);
      await this.stop();
    } finally {
      covering(coverage, false);
    }
    return { failed: this.failed, results: this.results, ...(this.coverageFailed && { coverageFailed: true }) };
  }

  /**
   * Whether a test run with these flags has coverage (the `[test]` of the bunfig.toml in `cwd`, a VFS path: Bun reads
   * only the working directory's, it doesn't look in parents), and which files it counts in.
   */
  protected async coverage(args: string[], cwd = "/"): Promise<CoverageOptions | undefined> {
    const text = this.bunfig(cwd);
    if (!args.some(isCoverageFlag) && !text?.includes("coverage")) return undefined;
    try {
      await loadResolver(this.vfs);
      const config = text === undefined ? undefined : (parseData(text, "toml") as { test?: Record<string, unknown> } | null);
      const opts = coverageOptions(args, config?.test);
      return opts.enabled ? opts : undefined;
    } catch {
      return undefined; // the worker reports what's wrong
    }
  }

  /** The text of the bunfig.toml in the VFS directory `cwd`. */
  private bunfig(cwd: string): string | undefined {
    const dir = cwd.replace(/^\/+|\/+$/g, "");
    return this.vfs.readText(dir ? `${dir}/bunfig.toml` : "bunfig.toml");
  }

  async start(entry: string, tests?: string[], args: string[] = []): Promise<void> {
    // On the content origin the Worker lives in the host frame (settled by boot already; awaited before any state changes).
    const content = CONTENT_ORIGIN ? await connectHost() : undefined;
    // A restart (Run while running) is a moment without a server while the old one flushes: preview requests in that
    // moment wait for the new one instead of getting "No server running". Not for a test run, which has no server and
    // takes as long as it takes.
    let handOver: (() => void) | undefined;
    if (!tests) this.ready = new Promise<void>((r) => (handOver = r));
    // Before the new worker copies the VFS, so it sees the old one's last database writes. Again if another start
    // got its worker going meanwhile (Run pressed twice), so none is left running unseen.
    do await this.stop();
    while (this.worker);
    resetSyncEsm();
    this.exitCode = undefined;
    this.startTimedOut = false;
    this.results = undefined;
    this.coverageFailed = false;
    const { worker, outcome, cancel } = this.boot(entry, tests, args, content);
    this.worker = worker;
    // Stop settles it as cancelled, once the worker is gone (retire).
    this.abort = cancel;
    // A test that never yields: stopped like Stop does, which settles the run.
    const watchdog = tests
      ? setTimeout(() => {
          this.log("error", `bun test timed out after ${TEST_TIMEOUT / 1000}s`);
          void this.stop();
        }, TEST_TIMEOUT)
      : undefined;
    this.ready = outcome.then((o) => {
      clearTimeout(watchdog);
      if (this.abort === cancel) this.abort = undefined;
      // A test run that didn't report (process.exit, even with code 0; an error; Stop; the watchdog) failed, by file unknown.
      if (tests && o.kind !== "ready") {
        this.failed = 1;
        this.results = undefined;
      }
      if (o.kind === "exit") {
        this.exitCode = o.code;
        if (this.worker === worker) void this.retire(false);
      } else if (o.kind === "timeout") {
        this.startTimedOut = true;
        this.log("error", "worker start timed out");
      }
    });
    void this.ready.then(handOver);
    return this.ready;
  }

  /**
   * Watch's restart without a gap: the new program starts next to the running one, which keeps answering previews
   * until the new one is up (its entry ran, so a `Bun.serve` in it listens), then hands over. The old one finishes the
   * responses it had begun (up to DRAIN_TIMEOUT) and its WebSockets drop, so preview pages reconnect to the new one.
   * A new program that ends with an error while starting, or doesn't start in time, is dropped and the old one keeps
   * going. One that ends cleanly while starting (a script, not a server) takes over as `start` would: `exitCode` is set.
   *
   * The old program writes its databases back before the new one copies the files, as for a Run; what it writes
   * while the two overlap (a request it answers meanwhile) isn't carried over. With nothing running this is `start`.
   */
  async swap(entry: string, args: string[] = []): Promise<Swap> {
    if (!this.worker) return this.start(entry, undefined, args).then(() => ({ kind: "swapped" }));
    const epoch = ++this.epoch;
    this.next?.cancel();
    const content = CONTENT_ORIGIN ? await connectHost() : undefined;
    await this.flush(this.worker);
    if (epoch !== this.epoch) return { kind: "superseded" }; // a Run, a Stop or a newer save meanwhile
    resetSyncEsm();
    const { worker, outcome, cancel } = this.boot(entry, undefined, args, content);
    const next = { worker, cancel };
    this.next = next;
    const o = await outcome;
    if (this.next !== next) return { kind: "superseded" }; // cancelled: a Run, a Stop or a newer save
    this.next = undefined;
    if (o.kind === "ready" || (o.kind === "exit" && o.code === 0)) {
      const old = this.worker;
      this.worker = worker;
      this.reportPorts();
      this.exitCode = undefined;
      if (old) this.drain(old);
      if (o.kind === "exit") {
        this.exitCode = 0;
        void this.retire(false);
      }
      return { kind: "swapped" };
    }
    this.end(worker);
    const reason =
      o.kind === "exit" ? `exited with code ${o.code} while starting` : o.kind === "timeout" ? `didn't start within ${START_TIMEOUT / 1000}s` : o.kind === "error" ? `worker failed: ${o.message}` : "cancelled";
    return { kind: "failed", reason };
  }

  /** The program a restart replaced: lets it finish the responses it had begun, then ends it. */
  private drain(old: Worker) {
    this.draining.add(old);
    this.dropSockets();
    const until = Date.now() + DRAIN_TIMEOUT;
    const check = () => {
      if (!this.draining.has(old)) return; // a Stop ended it already
      if (Date.now() < until && [...this.pending.values()].some((p) => p.owner === old)) return void setTimeout(check, 50);
      this.endPending(old);
      this.draining.delete(old);
      this.end(old);
    };
    check();
  }

  /**
   * A new worker running `entry` (or the test files). `outcome` settles once it is up, ended itself, or failed to start;
   * after that its messages keep being handled: an "exit" of the program answering previews is its end (`onExit`).
   */
  private boot(entry: string, tests: string[] | undefined, args: string[], content: Host | undefined) {
    this.host = content;
    const worker = this.newWorker();
    const debug = attachDebugger(worker);
    let settle!: (o: Outcome) => void;
    let settled = false;
    const outcome = new Promise<Outcome>((resolve) => (settle = resolve));
    // A debug run may stop at a breakpoint before it's ready, for as long as someone looks.
    const timer = tests || debug ? undefined : setTimeout(() => done({ kind: "timeout" }), START_TIMEOUT);
    const done = (o: Outcome) => {
      // Up after its start timed out: still the program (a restart or Stop since resets the flag).
      if (settled) {
        if (o.kind === "ready" && this.startTimedOut && this.worker === worker) {
          this.startTimedOut = false;
          this.onLateStart?.();
        }
        return;
      }
      settled = true;
      clearTimeout(timer);
      settle(o);
    };
    // The replaced program's lines while it overlaps the new one: marked, so the two don't read as one.
    const previous = () => (this.worker === worker ? !!this.next : this.next?.worker !== worker);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "console") this.log(m.level, previous() && !m.partial ? PREVIOUS + m.text : m.text, m.partial === true);
      // The program reads its stdin (process.stdin, Bun.stdin, readline): the console's input goes to it (`stdin`).
      else if (m.type === "stdin-wait") {
        if (this.worker !== worker) return;
        this.onStdinWait?.(m.on === true);
        // A program waiting for input (top-level `await Bun.stdin.text()`) is up, however long the reader takes.
        if (m.on) done({ kind: "ready" });
      }
      else if (m.type === "stdin-raw") {
        if (this.worker === worker) this.onStdinRaw?.(m.on === true);
      }
      // A WebSocket upgrade's Set-Cookie headers (an HTTP response's are read off its head in onSw).
      else if (m.type === "cookies") this.storeCookies(m.path, m.setCookies);
      else if (m.type === "ports") {
        this.ports.set(worker, m.ports);
        this.helpers.set(worker, m.helpers ?? []);
        this.sockets.set(worker, m.net ?? []);
        this.shareTaken(worker);
        if (this.worker === worker) this.reportPorts();
      }
      else if (m.type === "watching") this.watching.set(worker, m.watched);
      else if (m.type === "ready") {
        // From a worker Stop already let go of (still flushing): its report doesn't count.
        if (this.worker !== worker && this.next?.worker !== worker) return;
        this.failed = m.failed ?? 0;
        this.coverageFailed = !!m.coverageFailed;
        this.results = m.results;
        done({ kind: "ready" });
      } else if (m.type === "exit") {
        // The program ended itself: process.exit, or an uncaught error.
        if (!settled) return done({ kind: "exit", code: m.code });
        if (this.worker !== worker) return;
        this.exitCode = m.code;
        void this.retire(false);
        this.onExit?.(m.code);
      } else this.common(worker, m);
    };
    worker.onerror = (e) => {
      this.log("error", `worker error: ${e.message}`);
      done({ kind: "error", message: e.message });
    };
    worker.postMessage({ type: "start", entry, args, tests, files: this.vfs.files, dirs: this.vfs.dirs, vfsRoot: vfsRoot(), debug, tty: this.ttySize });
    const cancel = () => {
      this.end(worker);
      if (this.next?.worker === worker) this.next = undefined;
      done({ kind: "cancelled" });
    };
    return { worker, outcome, cancel };
  }

  private newWorker(): Worker {
    // A program blocked on a synchronous child reads what is meant for it through the relay (worker/syncChannel.ts);
    // on the content origin the host frame relays, as the buffer it reads can't come here.
    return this.host ? spawnWorker(this.host) : withSyncRelay(new Worker(new URL("./worker/runtime.ts", import.meta.url), { type: "module" }));
  }

  /** What any program's worker may ask, a child process's too: file changes, lazy reads, and its own children. */
  private common(worker: Worker, m: { type: string; [k: string]: any }) {
    if (m.type === "lazy-read") void serveLazyRead(this.vfs, m as never);
    // Its runtime plugins (worker/plugins.ts): asked for the modules they make, on this channel.
    else if (m.type === "plugins-token") pluginWorker(m.token, (msg) => worker.postMessage(msg));
    else if (m.type === "plugin-answer") pluginAnswered(m.reply, m.answer);
    else if (m.type.startsWith("dbg-")) onDebugMessage(worker, m);
    // A request to `localhost:<port>` that another process of its run serves (a worker_threads thread's server, a
    // child's): that process answers it on `reply`, as the preview's requests (worker/runtime.ts remoteFetch).
    else if (m.type === "loopback") {
      const root = this.rootOf(worker);
      const to = [root, ...this.descendants(root)].find((w) => w !== worker && [...(this.ports.get(w) ?? []), ...(this.helpers.get(w) ?? [])].includes(m.port));
      if (to) to.postMessage(m, [m.reply]);
      else m.reply.postMessage({ type: "error", message: "ECONNREFUSED" });
    }
    // A `net.connect` to a server of another process of its run (Nuxt's vite-node socket, in the program, from Nitro's
    // thread): that process accepts it on `reply` (worker/node/net.ts).
    else if (m.type === "net-connect") {
      const root = this.rootOf(worker);
      const to = [root, ...this.descendants(root)].find((w) => w !== worker && this.sockets.get(w)?.includes(m.address));
      if (to) to.postMessage(m, [m.reply]);
      else m.reply.postMessage({ type: "refused" });
    }
    else if (m.type === "vfs") {
      const [a, b] = m.args;
      this.applying = worker;
      try {
        if (m.op === "write") this.vfs.write(a, b);
        else if (m.op === "mkdir") this.vfs.mkdir(a);
        else if (m.op === "remove") this.vfs.remove(a);
        else if (m.op === "rename") this.vfs.rename(a, b);
      } finally {
        this.applying = undefined;
      }
    } else if (m.type === "spawn") this.spawn(worker, m as never);
    else if (m.type === "proc-in" || m.type === "proc-kill") {
      const kid = this.kids.get(worker)?.get(m.id);
      if (!kid || kid.ended) return;
      if (m.type === "proc-in") kid.worker.postMessage({ type: "stdin", data: m.data }, m.data ? [m.data.buffer] : []);
      // SIGKILL can't be caught: the worker goes at once. Other signals are the program's to handle (or end by).
      else if (m.signal === "SIGKILL") this.endChild(kid, 137, "SIGKILL");
      else kid.worker.postMessage({ type: "signal", signal: m.signal });
    }
  }

  /**
   * A child process a program started (worker/processes.ts spawnChild): a worker of its own on the project's files as
   * they are now, its stdout and stderr (console lines included) back to the parent as bytes, its exit as a report.
   */
  private spawn(parent: Worker, m: { id: number; launch: { entry?: string; script?: string; test?: string[]; args: string[]; execArgv?: string[]; run?: boolean }; cwd: string; env: Record<string, string>; thread?: object; port?: MessagePort }) {
    const ppid = this.procs.get(parent)?.id ?? 1;
    const worker = this.newWorker();
    const proc: Proc = { worker, parent, id: m.id, ended: false };
    this.procs.set(worker, proc);
    let kids = this.kids.get(parent);
    if (!kids) this.kids.set(parent, (kids = new Map()));
    kids.set(m.id, proc);
    const out = (fd: 1 | 2, data: Uint8Array) => !proc.ended && parent.postMessage({ type: "proc", id: m.id, ev: "out", fd, data }, [data.buffer]);
    worker.onmessage = (e) => {
      const c = e.data;
      if (c.type === "stdio") out(c.fd, c.data);
      else if (c.type === "console") out(c.level === "error" || c.level === "warn" ? 2 : 1, enc.encode(`${c.text}\n`));
      else if (c.type === "exit") this.endChild(proc, c.code, c.signal ?? null);
      // A server it starts answers previews when the program serves none (see `route`).
      else if (c.type === "ports") {
        this.ports.set(worker, c.ports);
        this.helpers.set(worker, c.helpers ?? []);
        this.sockets.set(worker, c.net ?? []);
        this.shareTaken(worker);
        this.reportPorts();
      } else this.common(worker, c);
    };
    worker.onerror = (e) => {
      out(2, enc.encode(`worker error: ${e.message}\n`));
      this.endChild(proc, 1, null);
    };
    const { entry, script, test, args, execArgv, run } = m.launch;
    // A worker_threads thread also gets its channel to the Worker (worker/node/worker_threads.ts). On the content origin
    // the host frame keeps both and sends references (host/main.ts keepThread): they pass through as they are.
    const thread = m.port ? { thread: m.thread, port: m.port } : {};
    const start = () =>
      worker.postMessage({ type: "start", entry, script, childTest: test, args, execArgv, run, files: this.vfs.files, dirs: this.vfs.dirs, vfsRoot: vfsRoot(), proc: { pid: m.id, ppid, cwd: m.cwd, env: m.env }, ...thread }, m.port instanceof MessagePort ? [m.port] : []);
    // A `bun test --coverage` (or one bunfig.toml's `[test]` turns coverage on for) counts what it loads, served so
    // until it ends; it starts once that is set up.
    if (test && (args.some(isCoverageFlag) || this.bunfig(m.cwd)?.includes("coverage")))
      void this.coverage(args, m.cwd).then((opts) => {
        if (proc.ended) return;
        proc.coverage = opts;
        covering(opts, true);
        start();
      });
    else start();
    // Before its code runs (the worker handles it ahead of the start, which awaits the wasm), so its first Bun.serve sees them.
    this.shareTaken(worker);
  }

  /**
   * A shell line in a worker of its own, outside any run (`bun install`'s lifecycle scripts, install.ts): `cwd` and `env`
   * as a child process gets them, its output to `out` as it comes, its own child processes as a program's. Resolves
   * with how it ended; past `timeout` it is ended (SIGKILL), so a script that never ends doesn't hold the install.
   */
  async exec(script: string, cwd: string, env: Record<string, string>, out: (fd: 1 | 2, data: Uint8Array) => void, timeout: number): Promise<{ code: number; signal: string | null }> {
    if (CONTENT_ORIGIN) this.host = await connectHost();
    const worker = this.newWorker();
    return new Promise((resolve) => {
      let ended = false;
      const done = (code: number, signal: string | null) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        this.end(worker);
        resolve({ code, signal });
      };
      const timer = setTimeout(() => done(137, "SIGKILL"), timeout);
      worker.onmessage = (e) => {
        const c = e.data;
        if (c.type === "stdio") out(c.fd, c.data);
        else if (c.type === "console") out(c.level === "error" || c.level === "warn" ? 2 : 1, enc.encode(`${c.text}\n`));
        else if (c.type === "exit") done(c.code, c.signal ?? null);
        else if (c.type !== "ports" && c.type !== "ready") this.common(worker, c);
      };
      worker.onerror = (e) => {
        out(2, enc.encode(`worker error: ${e.message}\n`));
        done(1, null);
      };
      worker.postMessage({ type: "start", script, args: [], files: this.vfs.files, dirs: this.vfs.dirs, vfsRoot: vfsRoot(), proc: { pid: 2, ppid: 1, cwd, env } });
    });
  }

  /** The program a child process belongs to (the one Run, a restart or a test run started). */
  private rootOf(worker: Worker): Worker {
    for (let p = this.procs.get(worker); p; p = this.procs.get(worker)) worker = p.parent;
    return worker;
  }

  /**
   * Tells each process of `worker`'s run which ports the others serve (worker/runtime.ts `listen`), so a Bun.serve on
   * one of them throws EADDRINUSE there and then, as on a real machine, instead of the port going to whoever was
   * started first. Pushed ahead, not asked for: Bun.serve is synchronous. Two processes binding the same port at the
   * same moment both get it (each hears of the other too late); `route` then takes the first. A restart's new program
   * is a run of its own: it takes over the old one's ports.
   */
  private shareTaken(worker: Worker) {
    const root = this.rootOf(worker);
    const run = [root, ...this.descendants(root)];
    for (const w of run) {
      const taken = run.flatMap((o) => (o === w ? [] : [...(this.ports.get(o) ?? []), ...(this.helpers.get(o) ?? [])]));
      w.postMessage({ type: "taken", ports: [...new Set(taken)] });
    }
  }

  /** A child process ended (by itself, or a signal): its parent hears how, and it goes, with its own children. */
  private endChild(proc: Proc, code: number, signal: string | null) {
    if (proc.ended) return;
    proc.ended = true;
    proc.parent.postMessage({ type: "proc", id: proc.id, ev: "exit", code, signal });
    this.end(proc.worker);
  }

  /** Ends a program's worker and every child process under it. */
  private end(worker: Worker) {
    worker.terminate();
    detachDebugger(worker);
    const kids = this.kids.get(worker);
    this.kids.delete(worker);
    const self = this.procs.get(worker);
    if (self) {
      self.ended = true;
      covering(self.coverage, false);
      this.procs.delete(worker);
      this.kids.get(self.parent)?.delete(self.id);
      // A child process's server goes with it: the previews it was answering end, and its ports leave the list.
      this.endPending(worker);
      this.helpers.delete(worker);
      this.sockets.delete(worker);
      if (this.ports.delete(worker)) {
        this.shareTaken(self.parent);
        this.reportPorts();
      }
    }
    for (const kid of kids?.values() ?? []) if (!kid.ended) this.endChild(kid, 137, "SIGKILL");
  }
}

/** The blank page under a preview's base whose document.cookie is the browser's preview cookies (sw.ts serves it). */

/**
 * A document.cookie assignment that sets (or, expired, deletes) `c` under the preview's base path. The server's `/`
 * is the base without a trailing slash: the default path of a cookie a script on the preview's root page sets, so the
 * two name the same cookie, as they would on a real host.
 */
function browserCookie(base: string, c: Cookie): string {
  const expires = c.expires === Infinity ? "" : `; expires=${new Date(c.expires).toUTCString()}`;
  return `${c.name}=${c.value}; path=${c.path === "/" ? base : base + c.path}${expires}; SameSite=Lax`;
}
