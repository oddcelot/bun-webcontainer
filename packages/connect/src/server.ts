// The runner: a loopback-only server the playground connects to. Every request must carry the token printed at
// startup and come from an allowed origin with a loopback Host (no DNS rebinding); any page in the browser can
// try to open ws://127.0.0.1, so these checks are what keep other sites out.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import type { ServerWebSocket, Subprocess } from "bun";
import type { ClientMessage, ServerMessage } from "./protocol.ts";
import { detectSandbox, sandboxed, type SandboxKind } from "./sandbox.ts";

export const DEFAULT_ORIGINS = ["https://runbun.dev", "https://canary.runbun.dev", "http://localhost:5173"];

export interface RunnerOptions {
  port?: number;
  token?: string;
  origins?: string[];
  sandbox?: SandboxKind;
}

interface Run {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  dir: string;
  port: number;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

export function startRunner(opts: RunnerOptions = {}) {
  const token = opts.token ?? crypto.randomUUID().replaceAll("-", "");
  const origins = new Set(opts.origins ?? DEFAULT_ORIGINS);
  const sandbox = opts.sandbox ?? detectSandbox();
  const runs = new Map<string, Run>();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runbun-connect-")));

  const loopbackHost = (host: string | null) => !!host && /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);

  const server = Bun.serve<{ runs: Set<string> }>({
    hostname: "127.0.0.1",
    port: opts.port ?? 7357,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!loopbackHost(req.headers.get("host"))) return new Response("bad host", { status: 421 });

      // /preview/<token>/<run id>/<path>: what the run's Bun.serve answers. Token in the path, as an iframe
      // can't send headers.
      const pm = url.pathname.match(/^\/preview\/([^/]+)\/([^/]+)(\/.*)?$/);
      if (pm) {
        // CORS for the allowed origins only, so the playground (or its service worker) can fetch the preview.
        const origin = req.headers.get("origin");
        const cors: Record<string, string> =
          origin && origins.has(origin)
            ? { "access-control-allow-origin": origin, "access-control-allow-private-network": "true", vary: "origin" }
            : {};
        if (req.method === "OPTIONS")
          return new Response(null, {
            status: 204,
            headers: { ...cors, "access-control-allow-methods": "*", "access-control-allow-headers": "*" },
          });
        if (pm[1] !== token) return new Response("bad token", { status: 403 });
        const run = runs.get(pm[2]!);
        if (!run) return new Response("no such run", { status: 404 });
        const target = `http://127.0.0.1:${run.port}${pm[3] ?? "/"}${url.search}`;
        const res = await fetch(target, { method: req.method, headers: req.headers, body: req.body, redirect: "manual" });
        const headers = new Headers(res.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        // The playground is cross-origin isolated (COEP credentialless): a frame it embeds must opt in.
        headers.set("cross-origin-resource-policy", "cross-origin");
        headers.set("cross-origin-embedder-policy", "credentialless");
        return new Response(res.body, { status: res.status, headers });
      }

      if (url.pathname === "/ws") {
        const origin = req.headers.get("origin");
        if (!origin || !origins.has(origin)) return new Response("origin not allowed", { status: 403 });
        if (url.searchParams.get("token") !== token) return new Response("bad token", { status: 403 });
        if (srv.upgrade(req, { data: { runs: new Set() } })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("runbun connect", { status: 404 });
    },
    websocket: {
      open(ws) {
        send(ws, { t: "hello", bun: Bun.version, platform: process.platform, sandbox });
      },
      async message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return send(ws, { t: "error", message: "bad json" });
        }
        if (msg.t === "run") return startRun(ws, msg);
        const run = runs.get(msg.id);
        if (!run) return send(ws, { t: "error", id: msg.id, message: "no such run" });
        if (msg.t === "stdin") {
          run.proc.stdin.write(msg.data);
          run.proc.stdin.flush();
        } else if (msg.t === "kill") run.proc.kill();
      },
      close(ws) {
        for (const id of ws.data.runs) runs.get(id)?.proc.kill();
      },
    },
  });

  function send(ws: ServerWebSocket<unknown>, m: ServerMessage) {
    ws.send(JSON.stringify(m));
  }

  async function startRun(ws: ServerWebSocket<{ runs: Set<string> }>, msg: Extract<ClientMessage, { t: "run" }>) {
    if (!/^[\w-]{1,64}$/.test(msg.id) || runs.has(msg.id)) return send(ws, { t: "error", id: msg.id, message: "bad run id" });
    const dir = join(root, msg.id);
    for (const [path, text] of Object.entries(msg.files)) {
      const rel = normalize(path).replace(/^\/+/, "");
      if (isAbsolute(rel) || rel.startsWith("..")) return send(ws, { t: "error", id: msg.id, message: `bad path ${path}` });
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    mkdirSync(join(dir, ".tmp"), { recursive: true });
    const port = await freePort();
    const proc = Bun.spawn(sandboxed(sandbox, dir, ["run", msg.entry, ...(msg.args ?? [])]), {
      cwd: dir,
      // A clean environment: none of the user's tokens or keys. Bun.serve() with no port listens on $PORT.
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: dir, TMPDIR: join(dir, ".tmp"), PORT: String(port), NO_COLOR: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    runs.set(msg.id, { proc, dir, port });
    ws.data.runs.add(msg.id);
    send(ws, { t: "started", id: msg.id, preview: `http://127.0.0.1:${server.port}/preview/${token}/${msg.id}/` });
    const pump = async (stream: ReadableStream<Uint8Array>, fd: 1 | 2) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) send(ws, { t: "out", id: msg.id, fd, data: dec.decode(chunk, { stream: true }) });
    };
    await Promise.all([pump(proc.stdout, 1), pump(proc.stderr, 2), proc.exited]);
    send(ws, { t: "exit", id: msg.id, code: proc.exitCode, signal: proc.signalCode });
    runs.delete(msg.id);
    ws.data.runs.delete(msg.id);
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    server,
    token,
    sandbox,
    url: `ws://127.0.0.1:${server.port}/ws?token=${token}`,
    stop() {
      for (const r of runs.values()) r.proc.kill();
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
