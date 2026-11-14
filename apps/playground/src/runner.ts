import { CookieJar, parseSetCookie, type Cookie } from "./cookieJar";
import { PANEL_COOKIE, joinCookies } from "./request";
import { resetSyncEsm, serveModule, vfsRoot } from "./moduleServer";
import type { VFS } from "@runbun/vfs";
import { serveLazyRead } from "./pkgStore";
import { CONTENT_ORIGIN } from "./contentOrigin";
import { answerAsks, connectHost, notifyStopped, readContentCookies, spawnWorker, writeContentCookies } from "./contentHost";

/** A program's child process (worker/processes.ts): its worker, and who started it under which id. */
type Proc = { worker: Worker; parent: Worker; id: number; ended: boolean };
type Host = Awaited<ReturnType<typeof connectHost>>;
const enc = new TextEncoder();

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

export type LogFn = (level: string, text: string) => void;

/** What a `bun test` run found: failed tests in all, and per test file that ran (worker/node/test.ts TestOutcome). */
export type TestResults = { failed: number; results?: { file: string; failed: number }[] };

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
  /** The exit code of the last started program once it ended itself (`process.exit`, an uncaught error). */
  exitCode: number | undefined;
  /** Called when a program that had started ends itself (one that ends while starting sets `exitCode` instead). */
  onExit?: (code: number) => void;
  /**
   * Called with the ports the program answering previews serves, its child processes' after its own, whenever they
   * change (none once it stops).
   */
  onPorts?: (ports: number[]) => void;
  /** Each program's (and child process's) ports as it last reported them: a restart's new program reports before it takes over. */
  private ports = new WeakMap<Worker, number[]>();
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
   * them, and scripts can't create them) and those with a narrower Path than the preview's root (the cookie page can't
   * read those back). Kept across Runs, as a browser keeps them across server restarts.
   */
  readonly cookies = new CookieJar();
  /** The path the preview's cookies live under in the browser (`/__preview/@<id>`), from sw.ts with each request. */
  private base: string | undefined;
  /** A hidden frame at `<base>/__runbun_cookies__`, a blank page whose document.cookie is the browser's preview cookies. */
  private cookiePage: Promise<Document | undefined> | undefined;

  /** The browser's cookies for the preview's root (`a=1; b=2`), read through the cookie page. */
  private async browserCookies(): Promise<string> {
    const base = this.base;
    if (!base) return "";
    // Project cookies live on the content origin: its host frame owns the cookie page.
    if (CONTENT_ORIGIN) return readContentCookies(base).catch(() => "");
    this.cookiePage ??= new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      frame.onload = () => resolve(frame.contentDocument ?? undefined);
      frame.onerror = () => resolve(undefined);
      frame.src = base + COOKIE_PAGE;
      document.body.append(frame);
    });
    return (await this.cookiePage)?.cookie ?? "";
  }

  /**
   * Request headers with the preview's cookies (the browser's, which the preview's scripts can change, and the jar's)
   * in place of any the request brought, joined with the one set in the request panel (request.ts PANEL_COOKIE), which
   * wins for a cookie in all.
   */
  private async withCookies(path: string, headers: [string, string][], base: string | undefined) {
    if (base) this.base = base;
    const panel = headers.find(([k]) => k.toLowerCase() === PANEL_COOKIE)?.[1];
    const out = headers.filter(([k]) => k.toLowerCase() !== "cookie" && k.toLowerCase() !== PANEL_COOKIE);
    const cookie = joinCookies(joinCookies(await this.browserCookies(), this.cookies.header(path)), panel);
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
      if (c.httpOnly || c.path !== "/") this.cookies.put(c);
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
        port.postMessage(await serveModule(this.vfs, m.path, (msg) => this.log("error", msg), m.target));
      } catch (err) {
        port.postMessage(textResponse(500, String(err)));
      }
    } else if (m.type === "preview") {
      await this.ready;
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
      await this.ready;
      const { base, ...ws } = m;
      const headers = await this.withCookies(m.path, m.headers, base);
      if (!this.worker) return port.postMessage({ type: "close", code: 1011, reason: "No server running" });
      const to = this.route(ws.port);
      to.worker.postMessage({ ...ws, headers, port: to.port }, [port]);
    }
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
    const own = this.ports.get(main) ?? [];
    if (port === undefined ? own.length : own.includes(port)) return { worker: main, port };
    for (const w of this.descendants(main)) {
      const ports = this.ports.get(w) ?? [];
      if (port === undefined ? ports.length : ports.includes(port)) return { worker: w, port: port ?? ports[0] };
    }
    return { worker: main, port };
  }

  /** Tells `onPorts` what the program answering previews serves now, its child processes included. */
  private reportPorts() {
    const main = this.worker;
    if (!main) return this.onPorts?.([]);
    const all = [main, ...this.descendants(main)].flatMap((w) => this.ports.get(w) ?? []);
    this.onPorts?.([...new Set(all)]);
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
    this.next?.cancel();
    for (const w of this.draining) this.end(w);
    this.draining.clear();
    this.endPending();
    await this.retire(flush);
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
    this.onPorts?.([]);
    this.endPending(worker);
    this.dropSockets();
    if (flush) await this.flush(worker);
    this.end(worker);
    abort?.();
  }

  /** Failed tests of the last `runTests`. */
  failed = 0;
  /** Failed tests per file of the last `runTests`; undefined when it ended before reporting (process.exit). */
  results: TestResults["results"];

  /** `bun test`: runs test files in a fresh worker (replacing any server) and resolves when the run is over. */
  async runTests(files: string[]): Promise<TestResults> {
    await this.start("", files);
    await this.stop();
    return { failed: this.failed, results: this.results };
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
    this.results = undefined;
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
      } else if (o.kind === "timeout") this.log("error", "worker start timed out");
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
    let settle!: (o: Outcome) => void;
    let settled = false;
    const outcome = new Promise<Outcome>((resolve) => (settle = resolve));
    const timer = tests ? undefined : setTimeout(() => done({ kind: "timeout" }), START_TIMEOUT);
    const done = (o: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(o);
    };
    // The replaced program's lines while it overlaps the new one: marked, so the two don't read as one.
    const previous = () => (this.worker === worker ? !!this.next : this.next?.worker !== worker);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "console") this.log(m.level, previous() ? PREVIOUS + m.text : m.text);
      // A WebSocket upgrade's Set-Cookie headers (an HTTP response's are read off its head in onSw).
      else if (m.type === "cookies") this.storeCookies(m.path, m.setCookies);
      else if (m.type === "ports") {
        this.ports.set(worker, m.ports);
        if (this.worker === worker) this.reportPorts();
      }
      else if (m.type === "ready") {
        // From a worker Stop already let go of (still flushing): its report doesn't count.
        if (this.worker !== worker && this.next?.worker !== worker) return;
        this.failed = m.failed ?? 0;
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
    worker.postMessage({ type: "start", entry, args, tests, files: this.vfs.files, dirs: this.vfs.dirs, vfsRoot: vfsRoot() });
    const cancel = () => {
      this.end(worker);
      if (this.next?.worker === worker) this.next = undefined;
      done({ kind: "cancelled" });
    };
    return { worker, outcome, cancel };
  }

  private newWorker(): Worker {
    return this.host ? spawnWorker(this.host) : new Worker(new URL("./worker/runtime.ts", import.meta.url), { type: "module" });
  }

  /** What any program's worker may ask, a child process's too: file changes, lazy reads, and its own children. */
  private common(worker: Worker, m: { type: string; [k: string]: any }) {
    if (m.type === "lazy-read") void serveLazyRead(this.vfs, m as never);
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
  private spawn(parent: Worker, m: { id: number; launch: { entry?: string; script?: string; args: string[] }; cwd: string; env: Record<string, string> }) {
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
        this.reportPorts();
      } else this.common(worker, c);
    };
    worker.onerror = (e) => {
      out(2, enc.encode(`worker error: ${e.message}\n`));
      this.endChild(proc, 1, null);
    };
    const { entry, script, args } = m.launch;
    worker.postMessage({ type: "start", entry, script, args, files: this.vfs.files, dirs: this.vfs.dirs, vfsRoot: vfsRoot(), proc: { pid: m.id, ppid, cwd: m.cwd, env: m.env } });
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
    const kids = this.kids.get(worker);
    this.kids.delete(worker);
    const self = this.procs.get(worker);
    if (self) {
      self.ended = true;
      this.procs.delete(worker);
      this.kids.get(self.parent)?.delete(self.id);
      // A child process's server goes with it: the previews it was answering end, and its ports leave the list.
      this.endPending(worker);
      if (this.ports.delete(worker)) this.reportPorts();
    }
    for (const kid of kids?.values() ?? []) if (!kid.ended) this.endChild(kid, 137, "SIGKILL");
  }
}

/** The blank page under a preview's base whose document.cookie is the browser's preview cookies (sw.ts serves it). */
const COOKIE_PAGE = "/__runbun_cookies__";

/**
 * A document.cookie assignment that sets (or, expired, deletes) `c` under the preview's base path. The server's `/`
 * is the base without a trailing slash: the default path of a cookie a script on the preview's root page sets, so the
 * two name the same cookie, as they would on a real host.
 */
function browserCookie(base: string, c: Cookie): string {
  const expires = c.expires === Infinity ? "" : `; expires=${new Date(c.expires).toUTCString()}`;
  return `${c.name}=${c.value}; path=${c.path === "/" ? base : base + c.path}${expires}; SameSite=Lax`;
}
