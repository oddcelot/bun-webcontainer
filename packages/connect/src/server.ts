// The runner: a loopback-only server the playground connects to. Any page in the browser can try to open
// ws://127.0.0.1, so: the WebSocket needs the token printed at startup and an allowed Origin, every request needs
// a loopback Host (no DNS rebinding), and the token is only handed out to pages the runner serves itself.
//
// Routes, all under /__connect/ so they can't collide with the playground's own paths:
//   /__connect/ws                      the WebSocket (?token=)
//   /__connect/info                    { ws, token, … } for a same-origin page (the playground served from here)
//   /__connect/preview/<token>/<run>/  the run's Bun.serve
// Everything else is the playground (--playground: a URL to proxy, or a built dist/ directory), when enabled.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";
import type { ClientMessage, ConnectInfo, ServerMessage } from "./protocol.ts";
import { detectSandbox, sandboxed, type SandboxKind } from "./sandbox.ts";

export const DEFAULT_ORIGINS = ["https://runbun.dev", "https://canary.runbun.dev", "http://localhost:5173"];

export interface RunnerOptions {
  port?: number;
  token?: string;
  origins?: string[];
  sandbox?: SandboxKind;
  /** Serve the playground: a URL to proxy (https://runbun.dev) or a directory with a playground build. */
  playground?: string;
}

interface Run {
  proc?: Subprocess<"pipe", "pipe", "pipe">;
  killed: boolean;
  port: number;
}

type Socket = ServerWebSocket<{ runs: Set<string>; host: string }>;

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

// What the deployed playground sends (apps/playground/public/_headers); localhost is a secure context, so this
// makes the page cross-origin isolated there too.
const ISOLATION = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" };

export function startRunner(opts: RunnerOptions = {}) {
  const token = opts.token ?? crypto.randomUUID().replaceAll("-", "");
  const sandbox = opts.sandbox ?? detectSandbox();
  const runs = new Map<string, Run>();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runbun-connect-")));
  const cache = join(root, "cache");
  mkdirSync(cache, { recursive: true });
  /** project → the files its last run wrote, to delete the ones a later run no longer has. */
  const manifests = new Map<string, Set<string>>();
  const busyProjects = new Set<string>();

  const loopbackHost = (host: string | null) => !!host && /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);

  const server = Bun.serve<{ runs: Set<string>; host: string }>({
    hostname: "127.0.0.1",
    port: opts.port ?? 7357,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const host = req.headers.get("host");
      if (!loopbackHost(host)) return new Response("bad host", { status: 421 });
      const path = url.pathname;

      const pm = path.match(/^\/__connect\/preview\/([^/]+)\/([^/]+)(\/.*)?$/);
      if (pm) return preview(req, url, pm[1]!, pm[2]!, pm[3] ?? "/");

      if (path === "/__connect/ws") {
        const origin = req.headers.get("origin");
        if (!origin || !origins.has(origin)) return new Response("origin not allowed", { status: 403 });
        if (url.searchParams.get("token") !== token) return new Response("bad token", { status: 403 });
        if (srv.upgrade(req, { data: { runs: new Set(), host: host! } })) return;
        return new Response("upgrade failed", { status: 400 });
      }

      if (path === "/__connect/info") {
        // No CORS headers, so other origins can't read this anyway; Sec-Fetch-Site also turns away cross-site
        // requests outright. A missing header is a non-browser client on this machine.
        const site = req.headers.get("sec-fetch-site");
        if (site && site !== "same-origin" && site !== "none") return new Response("same-origin only", { status: 403 });
        const info: ConnectInfo = { ws: `ws://${host}/__connect/ws?token=${token}`, token, bun: Bun.version, sandbox };
        return Response.json(info, { headers: { "cache-control": "no-store" } });
      }

      if (opts.playground) return playground(req, url);
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
        if (msg.t === "stdin" && run.proc) {
          run.proc.stdin.write(msg.data);
          run.proc.stdin.flush();
        } else if (msg.t === "kill") {
          run.killed = true;
          run.proc?.kill();
        }
      },
      close(ws) {
        for (const id of ws.data.runs) {
          const r = runs.get(id);
          if (r) (r.killed = true), r.proc?.kill();
        }
      },
    },
  });

  const self = [`http://localhost:${server.port}`, `http://127.0.0.1:${server.port}`];
  const origins = new Set([...(opts.origins ?? DEFAULT_ORIGINS), ...(opts.playground ? self : [])]);

  async function preview(req: Request, url: URL, tok: string, id: string, rest: string) {
    // CORS for the allowed origins only, so a playground on another origin (runbun.dev) can fetch the preview.
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
    if (tok !== token) return new Response("bad token", { status: 403 });
    const run = runs.get(id);
    if (!run) return new Response("no such run", { status: 404 });
    const headers = new Headers(req.headers);
    headers.set("host", `localhost:${run.port}`);
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${run.port}${rest}${url.search}`, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
      });
    } catch {
      return new Response("the program isn't listening (yet)", { status: 502, headers: cors });
    }
    const out = new Headers(res.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    // The playground is cross-origin isolated (COEP credentialless): a frame it embeds must opt in.
    out.set("cross-origin-resource-policy", "cross-origin");
    out.set("cross-origin-embedder-policy", "credentialless");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  }

  async function playground(req: Request, url: URL) {
    const src = opts.playground!;
    let res: Response;
    if (/^https?:\/\//.test(src)) {
      res = await fetch(new URL(url.pathname + url.search, src), {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers: { "accept-encoding": "identity", accept: req.headers.get("accept") ?? "*/*" },
      });
      res = new Response(res.body, { status: res.status, headers: res.headers });
      res.headers.delete("content-encoding");
      res.headers.delete("content-length");
    } else {
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
      if (rel.startsWith("..")) return new Response("no", { status: 400 });
      let file = join(src, rel);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        const asDir = join(file, "index.html");
        // An extensionless path is a page: its index.html, or the app's.
        file = existsSync(asDir) ? asDir : extname(rel) ? "" : join(src, "index.html");
      }
      if (!file || !existsSync(file)) return new Response("not found", { status: 404, headers: ISOLATION });
      res = new Response(Bun.file(file));
    }
    for (const [k, v] of Object.entries(ISOLATION)) res.headers.set(k, v);
    return res;
  }

  function send(ws: ServerWebSocket<unknown>, m: ServerMessage) {
    ws.send(JSON.stringify(m));
  }

  /** Runs `bun <args>` in dir, streaming its output; resolves with its exit. */
  async function spawn(ws: Socket, id: string, run: Run, dir: string, args: string[]) {
    const proc = Bun.spawn(sandboxed(sandbox, dir, args, [cache]), {
      cwd: dir,
      // A clean environment: none of the user's tokens or keys. Bun.serve() with no port listens on $PORT.
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: dir,
        TMPDIR: join(dir, ".tmp"),
        PORT: String(run.port),
        BUN_INSTALL_CACHE_DIR: cache,
        NO_COLOR: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    run.proc = proc;
    const pump = async (stream: ReadableStream<Uint8Array>, fd: 1 | 2) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) send(ws, { t: "out", id, fd, data: dec.decode(chunk, { stream: true }) });
    };
    await Promise.all([pump(proc.stdout, 1), pump(proc.stderr, 2), proc.exited]);
    return { code: proc.exitCode, signal: proc.signalCode };
  }

  async function startRun(ws: Socket, msg: Extract<ClientMessage, { t: "run" }>) {
    const bad = (message: string) => send(ws, { t: "error", id: msg.id, message });
    if (!/^[\w-]{1,64}$/.test(msg.id) || runs.has(msg.id)) return bad("bad run id");
    const project = msg.project ?? msg.id;
    if (!/^[\w-]{1,64}$/.test(project)) return bad("bad project id");
    if (busyProjects.has(project)) return bad("this project is already running; stop it first");
    const dir = join(root, "projects", project);

    // Write the files; delete the ones the project's previous run had and this one doesn't.
    const paths = new Set<string>();
    for (const [path, data] of Object.entries(msg.files)) {
      const rel = normalize(path).replace(/^\/+/, "");
      if (isAbsolute(rel) || rel.startsWith("..") || /(^|\/)node_modules(\/|$)/.test(rel)) return bad(`bad path ${path}`);
      paths.add(rel);
    }
    for (const old of manifests.get(project) ?? []) if (!paths.has(old)) rmSync(join(dir, old), { force: true });
    for (const [path, data] of Object.entries(msg.files)) {
      const rel = normalize(path).replace(/^\/+/, "");
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), typeof data === "string" ? data : Buffer.from(data.b64, "base64"));
    }
    manifests.set(project, paths);
    mkdirSync(join(dir, ".tmp"), { recursive: true });

    const run: Run = { killed: false, port: await freePort() };
    runs.set(msg.id, run);
    busyProjects.add(project);
    ws.data.runs.add(msg.id);
    let result: { code: number | null; signal: string | null } = { code: 0, signal: null };
    try {
      if (msg.install ?? paths.has("package.json")) {
        send(ws, { t: "phase", id: msg.id, phase: "install" });
        result = await spawn(ws, msg.id, run, dir, ["install"]);
      }
      if (result.code === 0 && !run.killed && (msg.entry || msg.test)) {
        send(ws, { t: "phase", id: msg.id, phase: "run" });
        send(ws, { t: "started", id: msg.id, preview: `http://${ws.data.host}/__connect/preview/${token}/${msg.id}/` });
        const args = msg.test ? ["test", ...msg.test] : ["run", msg.entry, ...(msg.args ?? [])];
        let exited = false;
        const done = spawn(ws, msg.id, run, dir, args).finally(() => (exited = true));
        // Tell the page once the program accepts connections on its port, so Run can show the preview.
        if (!msg.test)
          void (async () => {
            while (!exited && !run.killed) {
              const up = await Bun.connect({ hostname: "127.0.0.1", port: run.port, socket: { data() {} } }).then(
                (s) => (s.end(), true),
                () => false,
              );
              if (up) return send(ws, { t: "listening", id: msg.id });
              await Bun.sleep(50);
            }
          })();
        result = await done;
      }
    } finally {
      send(ws, { t: "exit", id: msg.id, ...result });
      runs.delete(msg.id);
      busyProjects.delete(project);
      ws.data.runs.delete(msg.id);
    }
  }

  return {
    server,
    token,
    sandbox,
    origins,
    url: `ws://127.0.0.1:${server.port}/__connect/ws?token=${token}`,
    open: `http://localhost:${server.port}/`,
    stop() {
      for (const r of runs.values()) (r.killed = true), r.proc?.kill();
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
