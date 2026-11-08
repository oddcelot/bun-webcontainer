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

export type LogFn = (level: string, text: string) => void;

export class Runner {
  private worker?: Worker;
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

  /** True while applying a worker-originated op to the page VFS, so it isn't echoed back. */
  private applying = false;

  private mirror(op: "write" | "mkdir" | "remove", path: string, data?: unknown) {
    if (this.applying || !this.worker) return;
    this.worker.postMessage({ type: "vfs", op, path, data }); // cloned, not transferred: the page keeps its data
  }

  /**
   * Preview responses still on their way from the worker, by the service worker's port; true once the head went out.
   * A stopped worker never finishes them, so stop() does.
   */
  protected pending = new Map<MessagePort, boolean>();
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
      this.pending.set(port, false);
      port1.onmessage = ({ data }) => {
        if (!this.pending.has(port)) return;
        if (data.type === "head") {
          const headers = data.headers as [string, string][];
          this.storeCookies(m.req.path, headers.filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => v));
          data = { ...data, headers: headers.filter(([k]) => k.toLowerCase() !== "set-cookie") };
        }
        port.postMessage(data, data.type === "chunk" ? [data.data] : []);
        if (data.type === "head") this.pending.set(port, true);
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

  /** Ends the preview responses still on their way: the program that would have finished them is gone. */
  protected endPending() {
    for (const [port, started] of this.pending) {
      if (started) port.postMessage({ type: "error", message: "The server stopped." });
      else sendText(port, 503, "The server stopped before it answered.");
    }
    this.pending.clear();
  }

  /**
   * Stops the worker. It first gets a moment to write open databases back (their bytes arrive as "vfs" messages),
   * so a Run or Stop doesn't drop a program's last writes; a worker that doesn't answer in time is terminated anyway.
   * A worker that ended itself has written them already (`flush` false).
   */
  async stop(flush = true) {
    const worker = this.worker;
    this.worker = undefined;
    this.endPending();
    if (!worker) return;
    previewChannel.postMessage("stopped");
    if (CONTENT_ORIGIN) notifyStopped();
    if (flush)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT);
        worker.addEventListener("message", (e) => {
          if (e.data?.type !== "flushed") return;
          clearTimeout(timer);
          resolve();
        });
        worker.postMessage({ type: "flush" });
      });
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
    // A restart (Run while running, a save under watch) is a moment without a server while the old one flushes:
    // preview requests in that moment wait for the new one instead of getting "No server running". Not for a test
    // run, which has no server and takes as long as it takes.
    let handOver: (() => void) | undefined;
    if (!tests) this.ready = new Promise<void>((r) => (handOver = r));
    // Before the new worker copies the VFS, so it sees the old one's last database writes. Again if another start
    // got its worker going meanwhile (Run pressed twice), so none is left running unseen.
    do await this.stop();
    while (this.worker);
    resetSyncEsm();
    this.exitCode = undefined;
    let started = false;
    const worker = content ? spawnWorker(content) : new Worker(new URL("./worker/runtime.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    this.ready = new Promise<void>((resolve) => {
      // A test run takes as long as it takes (each test has its own timeout).
      const timer = tests ? undefined : setTimeout(() => {
        this.log("error", "worker start timed out");
        resolve();
      }, 15000);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "console") this.log(m.level, m.text);
        // A WebSocket upgrade's Set-Cookie headers (an HTTP response's are read off its head in onSw).
        else if (m.type === "cookies") this.storeCookies(m.path, m.setCookies);
        else if (m.type === "ready") {
          clearTimeout(timer);
          this.failed = m.failed ?? 0;
          started = true;
          resolve();
        } else if (m.type === "exit") {
          // The program ended itself: process.exit, or an uncaught error.
          if (this.worker !== worker) return;
          clearTimeout(timer);
          this.exitCode = m.code;
          if (tests) this.failed = m.code ? 1 : 0;
          void this.stop(false);
          if (started) this.onExit?.(m.code);
          resolve();
        } else if (m.type === "lazy-read") {
          void serveLazyRead(this.vfs, m);
        } else if (m.type === "vfs") {
          const [a, b] = m.args;
          this.applying = true;
          try {
            if (m.op === "write") this.vfs.write(a, b);
            else if (m.op === "mkdir") this.vfs.mkdir(a);
            else if (m.op === "remove") this.vfs.remove(a);
            else if (m.op === "rename") this.vfs.rename(a, b);
          } finally {
            this.applying = false;
          }
        }
      };
      worker.onerror = (e) => {
        this.log("error", `worker error: ${e.message}`);
        clearTimeout(timer);
        resolve();
      };
    });
    worker.postMessage({ type: "start", entry, args, tests, files: this.vfs.files, dirs: this.vfs.dirs, vfsRoot: vfsRoot() });
    void this.ready.then(handOver);
    return this.ready;
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
