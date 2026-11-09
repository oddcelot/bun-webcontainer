import { CookieJar, parseSetCookie, type Cookie } from "./cookieJar";
import { PANEL_COOKIE, joinCookies } from "./request";
import { resetSyncEsm, serveModule, vfsRoot } from "./moduleServer";
import type { VFS } from "@runbun/vfs";
import { serveLazyRead } from "./pkgStore";
import { CONTENT_ORIGIN } from "./contentOrigin";
import { answerAsks, connectHost, notifyStopped, readContentCookies, spawnWorker, writeContentCookies } from "./contentHost";

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
/** How long a starting program gets before it counts as hung (a test run has no limit). */
const START_TIMEOUT = 15000;
/** How long the program a restart replaced gets to finish the preview responses it had begun. */
const DRAIN_TIMEOUT = 5000;
/** What the console puts before the replaced program's lines while it is still around (see `swap`). */
const PREVIOUS = "[previous] ";

export type LogFn = (level: string, text: string) => void;

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

  /** The worker whose op is being applied to the page VFS, so it isn't echoed back to it. */
  private applying?: Worker;

  /** Hands a page VFS change to the running programs (both while a restart overlaps), except the one that made it. */
  private mirror(op: "write" | "mkdir" | "remove", path: string, data?: unknown) {
    for (const w of [this.worker, this.next?.worker])
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
      const entry = { started: false, owner: this.worker };
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
      this.worker.postMessage({ ...ws, headers }, [port]);
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
    this.worker!.postMessage({ type: "request", req }, [port]);
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
    for (const w of this.draining) w.terminate();
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
    this.worker = undefined;
    if (!worker) return;
    this.endPending(worker);
    this.dropSockets();
    if (flush) await this.flush(worker);
    worker.terminate();
  }

  /** Failed tests of the last `runTests`. */
  failed = 0;

  /** `bun test`: runs test files in a fresh worker (replacing any server) and resolves when the run is over. */
  async runTests(files: string[]): Promise<number> {
    await this.start("", files);
    await this.stop();
    return this.failed;
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
    const { worker, outcome } = this.boot(entry, tests, args, content);
    this.worker = worker;
    this.ready = outcome.then((o) => {
      if (o.kind === "exit") {
        this.exitCode = o.code;
        if (tests) this.failed = o.code ? 1 : 0;
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
      this.exitCode = undefined;
      if (old) this.drain(old);
      if (o.kind === "exit") {
        this.exitCode = 0;
        void this.retire(false);
      }
      return { kind: "swapped" };
    }
    worker.terminate();
    const reason =
      o.kind === "exit" ? `it exited with code ${o.code} while starting` : o.kind === "timeout" ? `it didn't start within ${START_TIMEOUT / 1000}s` : o.kind === "error" ? `its worker failed: ${o.message}` : "it was cancelled";
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
      old.terminate();
    };
    check();
  }

  /**
   * A new worker running `entry` (or the test files). `outcome` settles once it is up, ended itself, or failed to start;
   * after that its messages keep being handled: an "exit" of the program answering previews is its end (`onExit`).
   */
  private boot(entry: string, tests: string[] | undefined, args: string[], content: Awaited<ReturnType<typeof connectHost>> | undefined) {
    const worker = content ? spawnWorker(content) : new Worker(new URL("./worker/runtime.ts", import.meta.url), { type: "module" });
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
      else if (m.type === "ready") {
        this.failed = m.failed ?? 0;
        done({ kind: "ready" });
      } else if (m.type === "exit") {
        // The program ended itself: process.exit, or an uncaught error.
        if (!settled) return done({ kind: "exit", code: m.code });
        if (this.worker !== worker) return;
        this.exitCode = m.code;
        void this.retire(false);
        this.onExit?.(m.code);
      } else if (m.type === "lazy-read") {
        void serveLazyRead(this.vfs, m);
      } else if (m.type === "vfs") {
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
      }
    };
    worker.onerror = (e) => {
      this.log("error", `worker error: ${e.message}`);
      done({ kind: "error", message: e.message });
    };
    worker.postMessage({ type: "start", entry, args, tests, files: this.vfs.files, dirs: this.vfs.dirs, vfsRoot: vfsRoot() });
    const cancel = () => {
      worker.terminate();
      if (this.next?.worker === worker) this.next = undefined;
      done({ kind: "cancelled" });
    };
    return { worker, outcome, cancel };
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
