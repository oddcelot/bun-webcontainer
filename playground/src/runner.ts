import { serveModule } from "./moduleServer";
import type { VFS } from "./vfs";

export type LogFn = (level: string, text: string) => void;

export class Runner {
  private worker?: Worker;
  private ready: Promise<void> = Promise.resolve();

  constructor(
    private vfs: VFS,
    private log: LogFn,
  ) {
    navigator.serviceWorker.onmessage = (e) => this.onSw(e);
  }

  private async onSw(e: MessageEvent) {
    const port = e.ports[0];
    const m = e.data;
    if (m.type === "module") {
      port.postMessage(await serveModule(this.vfs, m.path, (msg) => this.log("error", msg)));
    } else if (m.type === "preview") {
      await this.ready;
      if (!this.worker) {
        port.postMessage({ status: 503, statusText: "", headers: [["content-type", "text/plain"]], body: new TextEncoder().encode("No server running. Press Run.").buffer });
        return;
      }
      this.worker.postMessage({ type: "request", req: m.req }, [port]);
    }
  }

  stop() {
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
        } else if (m.type === "rpc") {
          try {
            let value: unknown;
            if (m.op === "read") value = this.vfs.read(m.args[0]);
            else if (m.op === "exists") value = this.vfs.exists(m.args[0]);
            else if (m.op === "write") this.vfs.write(m.args[0], m.args[1]);
            else throw new Error(`unknown rpc ${m.op}`);
            worker.postMessage({ type: "rpcResult", id: m.id, ok: true, value });
          } catch (err) {
            worker.postMessage({ type: "rpcResult", id: m.id, ok: false, error: String(err) });
          }
        }
      };
      worker.onerror = (e) => {
        this.log("error", `worker error: ${e.message}`);
        clearTimeout(timer);
        resolve();
      };
    });
    worker.postMessage({ type: "start", entry });
    return this.ready;
  }
}
