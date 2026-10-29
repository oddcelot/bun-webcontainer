import { CookieJar } from "./cookieJar";
import { serveModule } from "./moduleServer";
import type { VFS } from "./vfs";

/** Tells preview pages (see previewWebSocket in sw.js) that their WebSockets' server is gone. */
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
  private ready: Promise<void> = Promise.resolve();

  constructor(
    private vfs: VFS,
    private log: LogFn,
  ) {
    navigator.serviceWorker.onmessage = (e) => this.onSw(e);
    // Keep the worker's copy of the VFS coherent with edits made on the page while it runs.
    vfs.onChange(({ path, removed }) => {
      if (removed) this.mirror("remove", path);
      else this.mirror("write", path, vfs.read(path));
    });
    vfs.onDir((path, removed) => this.mirror(removed ? "remove" : "mkdir", path));
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
  private pending = new Map<MessagePort, boolean>();
  /** The preview host's cookies; kept across Runs, as a browser keeps them across server restarts. */
  readonly cookies = new CookieJar();

  /** Request headers with the jar's Cookie in place of any the request brought. */
  private withCookies(path: string, headers: [string, string][]) {
    const out = headers.filter(([k]) => k.toLowerCase() !== "cookie");
    const cookie = this.cookies.header(path);
    if (cookie) out.push(["cookie", cookie]);
    return out;
  }

  private async onSw(e: MessageEvent) {
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
      if (!this.worker) return sendText(port, 503, "No server running. Press Run.");
      // Relayed instead of handing the worker `port`, so an unfinished response can still be ended.
      const { port1, port2 } = new MessageChannel();
      this.pending.set(port, false);
      port1.onmessage = ({ data }) => {
        if (!this.pending.has(port)) return;
        if (data.type === "head") {
          const headers = data.headers as [string, string][];
          this.cookies.store(m.req.path, headers.filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => v));
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
      this.worker.postMessage({ type: "request", req: { ...m.req, headers: this.withCookies(m.req.path, m.req.headers) } }, [port2]);
    } else if (m.type === "ws") {
      await this.ready;
      if (!this.worker) return port.postMessage({ type: "close", code: 1011, reason: "No server running" });
      this.worker.postMessage({ ...m, headers: this.withCookies(m.path, m.headers) }, [port]);
    }
  }

  /**
   * Stops the worker. It first gets a moment to write open databases back (their bytes arrive as "vfs" messages),
   * so a Run or Stop doesn't drop a program's last writes; a worker that doesn't answer in time is terminated anyway.
   */
  async stop() {
    const worker = this.worker;
    this.worker = undefined;
    for (const [port, started] of this.pending) {
      if (started) port.postMessage({ type: "error", message: "The server stopped." });
      else sendText(port, 503, "The server stopped before it answered.");
    }
    this.pending.clear();
    if (!worker) return;
    previewChannel.postMessage("stopped");
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

  async start(entry: string, tests?: string[]): Promise<void> {
    // Before the new worker copies the VFS, so it sees the old one's last database writes. Again if another start
    // got its worker going meanwhile (Run pressed twice), so none is left running unseen.
    do await this.stop();
    while (this.worker);
    const worker = new Worker(new URL("./worker/runtime.ts", import.meta.url), { type: "module" });
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
        else if (m.type === "ready") {
          clearTimeout(timer);
          this.failed = m.failed ?? 0;
          resolve();
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
    worker.postMessage({ type: "start", entry, tests, files: this.vfs.files, dirs: this.vfs.dirs });
    return this.ready;
  }
}
