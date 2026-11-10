import { VFS } from "@runbun/vfs";
import { CHANNEL_DATA, httpImports, pageChannel, syncXhr, type HttpAsk, type Transport } from "./http";
import { applyOps, collect, type Changes, type Op } from "./mirror";
import { runWasi } from "./wasi";

// The git worker (git.ts starts it): a copy of the project (mirror.ts) and git.wasm run over it, so a command doesn't
// hold up the page, and a network command can block on its requests (http.ts). Messages are handled in order, so a
// command sees every change the page sent before it.

/** A command: `wasm` is git.wasm's URL, `proxy` the git proxy's (`…/git-proxy/`). */
type Run = { id: number; args: string[]; env: Record<string, string>; wasm: string; proxy: string };
export type ToWorker = { ops: Op[] } | { run: Run };
export type FromWorker =
  | { id: number; exitCode: number; out: Uint8Array[]; err: Uint8Array[]; changes: Changes }
  | { id: number; error: string }
  /** What a command is doing (git.wasm's progress lines). */
  | { id: number; progress: string }
  /** The shared memory the page answers HTTP asks into (http.ts pageChannel), sent once. */
  | { channel: SharedArrayBuffer }
  /** A request (or the next chunk of one) for the page to fetch. */
  | { http: HttpAsk };

/** The page fetches, streaming, where memory can be shared; else this worker does, one synchronous request each. */
let made: { proxy: string; transport: Transport } | undefined;
function transportFor(proxy: string): Transport {
  if (made?.proxy === proxy) return made.transport;
  let transport: Transport;
  if (typeof SharedArrayBuffer === "function" && crossOriginIsolated) {
    const sab = new SharedArrayBuffer(16 + CHANNEL_DATA);
    postMessage({ channel: sab } satisfies FromWorker);
    transport = pageChannel(proxy, sab, (http) => postMessage({ http } satisfies FromWorker));
  } else transport = syncXhr(proxy);
  made = { proxy, transport };
  return transport;
}

const copy = new VFS();
let compiled: Promise<WebAssembly.Module> | undefined;
let tail: Promise<unknown> = Promise.resolve();

async function run({ id, args, env, wasm, proxy }: Run) {
  try {
    compiled ??= WebAssembly.compileStreaming(fetch(wasm)).catch((e) => {
      compiled = undefined;
      throw e;
    });
    const module = await compiled;
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let exitCode = 0;
    const changes = await collect(copy, async () => {
      ({ exitCode } = await runWasi(module, copy, {
        args: ["git", ...args],
        env,
        stdout: (b) => out.push(b),
        stderr: (b) => err.push(b),
        // clone, fetch, pull: blocking requests, which a worker may make.
        modules: (memory) => ({ runbun: httpImports(memory, transportFor(proxy), (progress) => postMessage({ id, progress } satisfies FromWorker)) }),
      }));
    });
    // The copy keeps its bytes; the page gets copies, moved rather than copied again.
    for (const f of changes.files) if (typeof f.data !== "string") f.data = f.data.slice();
    const bytes = [...out, ...err, ...changes.files.flatMap((f) => (typeof f.data === "string" ? [] : [f.data]))];
    postMessage({ id, exitCode, out, err, changes } satisfies FromWorker, { transfer: [...new Set(bytes.map((b) => b.buffer as ArrayBuffer))] });
  } catch (e) {
    postMessage({ id, error: String(e) } satisfies FromWorker);
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  // Ops wait for a command running before them: it reads the copy as it was when it started.
  tail = tail.then(() => ("ops" in m ? applyOps(copy, m.ops) : run(m.run)));
};
