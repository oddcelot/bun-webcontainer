import { BASE } from "../base";
import { loadSemver } from "../semver";
import { dirname, norm, VFS } from "../vfs";
import { builtins, installTimers, setFs, setStdio } from "./node";
import "./hostPackages";
import { fsError } from "./node/errors";
import { hooks } from "./node/serve";
import nodePath from "./node/path";
import process, { env } from "./node/process";

type Handler = (req: Request, server: unknown) => Response | Promise<Response>;
type HtmlImport = { __htmlImport: string };
type RouteValue = Response | Handler | HtmlImport | Partial<Record<string, Handler | Response>>;
type Routes = Record<string, RouteValue>;

const g = globalThis as unknown as Record<string, unknown>;
const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

// The worker's copy of the page VFS (sent with "start"); node:fs and Bun.file read it synchronously, and
// writes are mirrored to the page.
const vfs = new VFS();
setFs(vfs, (op, ...args) => post({ type: "vfs", op, args }));
setStdio((level, text) => post({ type: "console", level, text }));
g.__nodeBuiltins = builtins;
g.process = process;
g.global ??= globalThis;
g.Buffer ??= (builtins.buffer as { Buffer: unknown }).Buffer;
installTimers();

let handler: Handler | undefined;
let routes: Routes = {};
let server: unknown;

hooks.set = (h) => {
  handler = h;
  routes = {};
};
hooks.get = () => handler;

const isHtmlImport = (v: unknown): v is HtmlImport => typeof v === "object" && v !== null && "__htmlImport" in v;

/** `Bun.serve` route patterns: exact paths, `:param` segments, trailing `*`. */
function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const u = path.split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") return params;
    if (i >= u.length) return null;
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(u[i]);
    else if (p[i] !== u[i]) return null;
  }
  return p.length === u.length ? params : null;
}

/**
 * An HTML import served the way Bun's dev server serves it, minus bundling: local `<script src>` and
 * `<link href>` point at the module server, which transpiles them and resolves their imports.
 */
async function serveHtml(imp: HtmlImport): Promise<Response> {
  const dir = dirname(imp.__htmlImport);
  const html = vfs.readText(imp.__htmlImport) ?? "";
  const out = html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=)(["'])([^"']+)\2/gi, (m, pre: string, q: string, ref: string) =>
    /^(https?:|data:|\/\/|#)/.test(ref) ? m : `${pre}${q}${BASE}__vfs/${norm(ref.startsWith("/") ? ref : `${dir}/${ref}`)}${q}`,
  );
  return new Response(out, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function dispatch(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  for (const [pattern, value] of Object.entries(routes)) {
    const params = matchRoute(pattern, path);
    if (!params) continue;
    Object.assign(req, { params });
    if (value instanceof Response) return value.clone();
    if (isHtmlImport(value)) return serveHtml(value);
    if (typeof value === "function") return value(req, server);
    const byMethod = value[req.method];
    if (byMethod) return byMethod instanceof Response ? byMethod.clone() : byMethod(req, server);
  }
  if (handler) return handler(req, server);
  return new Response("Not Found", { status: 404 });
}
const fmt = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? String(v);
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
};

for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    post({ type: "console", level, text: args.map(fmt).join(" ") });
  };
}

class BunFile {
  readonly name: string;
  constructor(path: string) {
    this.name = norm(nodePath.resolve(path));
  }
  async exists() {
    return vfs.files.has(this.name);
  }
  async bytes() {
    const d = vfs.readBytes(this.name);
    if (d === undefined) throw fsError("ENOENT", "open", "/" + this.name);
    return d.slice();
  }
  async arrayBuffer() {
    const b = await this.bytes();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  async text() {
    return new TextDecoder().decode(await this.bytes());
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

async function write(path: string, data: unknown): Promise<number> {
  let out: string | Uint8Array;
  if (typeof data === "string") out = data;
  else if (data instanceof BunFile) out = await data.bytes();
  else if (data instanceof Blob || data instanceof Response) out = new Uint8Array(await data.arrayBuffer());
  else if (data instanceof ArrayBuffer) out = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) out = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else out = String(data);
  const file = "/" + norm(nodePath.resolve(path));
  const fs = builtins.fs as { mkdirSync(p: string, o: object): void; writeFileSync(p: string, d: string | Uint8Array): void };
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return typeof out === "string" ? new TextEncoder().encode(out).length : out.byteLength;
}

async function main() {
  const semver = await loadSemver();
  g.Bun = {
    version: "1.4.4-browser",
    env,
    gc: () => {},
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    nanoseconds: () => Math.round(performance.now() * 1e6),
    semver: {
      order: semver.order,
      satisfies: semver.satisfies,
    },
    file: (path: string) => new BunFile(path),
    write,
    serve(opts: { port?: number; hostname?: string; fetch?: Handler; routes?: Routes }) {
      handler = opts.fetch;
      routes = opts.routes ?? {};
      const port = opts.port ?? 3000;
      const hostname = opts.hostname ?? "localhost";
      server = {
        port,
        hostname,
        url: new URL(`http://${hostname}:${port}/`),
        development: true,
        /** Swaps handlers in place, as Bun's does; the port and hostname stay. */
        reload(next: { fetch?: Handler; routes?: Routes }) {
          if (next.fetch) handler = next.fetch;
          if (next.routes) routes = next.routes;
        },
        /** No WebSockets in the preview yet. */
        upgrade: () => false,
        async stop() {
          handler = undefined;
          routes = {};
        },
      };
      return server;
    },
  };

  self.addEventListener("unhandledrejection", (e) => {
    post({ type: "console", level: "error", text: `Uncaught (in promise) ${fmt(e.reason)}` });
  });

  self.addEventListener("message", async (e: MessageEvent) => {
    const m = e.data;
    if (m.type === "request") {
      const port = e.ports[0];
      try {
        if (!handler && !Object.keys(routes).length) {
          port.postMessage({ status: 503, statusText: "", headers: [], body: new TextEncoder().encode("No Bun.serve handler registered").buffer });
          return;
        }
        const r = m.req;
        const req = new Request(self.location.origin + r.path, { method: r.method, headers: r.headers, body: r.body });
        const res = await dispatch(req);
        const body = await res.arrayBuffer();
        port.postMessage({ status: res.status, statusText: res.statusText, headers: [...res.headers], body }, [body]);
      } catch (err) {
        console.error(err);
        port.postMessage({ status: 500, statusText: "", headers: [["content-type", "text/plain"]], body: new TextEncoder().encode(fmt(err)).buffer });
      }
    }
  });

  post({ type: "booted" });
}

const booted = main();

self.addEventListener("message", async (e: MessageEvent) => {
  if (e.data.type !== "start") return;
  vfs.load(e.data.files, e.data.dirs);
  await booted;
  try {
    await import(/* @vite-ignore */ `${BASE}__vfs/${e.data.entry}`);
  } catch (err) {
    post({ type: "console", level: "error", text: fmt(err) });
  }
  post({ type: "ready" });
});
