import { serveModule } from "./moduleServer";
import type { VFS } from "./vfs";

/** Tells preview pages (see previewWebSocket in sw.js) that their WebSockets' server is gone. */
const previewChannel = new BroadcastChannel("bun-preview");

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

  private async onSw(e: MessageEvent) {
    const port = e.ports[0];
    const m = e.data;
    if (m.type === "module") {
      port.postMessage(await serveModule(this.vfs, m.path, (msg) => this.log("error", msg), m.target));
    } else if (m.type === "preview") {
      await this.ready;
      if (!this.worker) {
        port.postMessage({ status: 503, statusText: "", headers: [["content-type", "text/plain"]], body: new TextEncoder().encode("No server running. Press Run.").buffer });
        return;
      }
      this.worker.postMessage({ type: "request", req: m.req }, [port]);
    } else if (m.type === "ws") {
      await this.ready;
      if (!this.worker) return port.postMessage({ type: "close", code: 1011, reason: "No server running" });
      this.worker.postMessage(m, [port]);
    }
  }

  stop() {
    if (this.worker) previewChannel.postMessage("stopped");
    this.worker?.terminate();
    this.worker = undefined;
  }

  start(entry: string): Promise<void> {
    this.stop();
    const worker = new Worker(new URL("./worker/runtime.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    this.ready = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log("error", "worker start timed out");
        resolve();
      }, 15000);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "console") this.log(m.level, m.text);
        else if (m.type === "ready") {
          clearTimeout(timer);
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
    worker.postMessage({ type: "start", entry, files: this.vfs.files, dirs: this.vfs.dirs });
    return this.ready;
  }
}
