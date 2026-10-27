import { loadSemver } from "../semver";
import { dirname, norm } from "../vfs";

type Handler = (req: Request, server: unknown) => Response | Promise<Response>;
type HtmlImport = { __htmlImport: string };
type RouteValue = Response | Handler | HtmlImport | Partial<Record<string, Handler | Response>>;
type Routes = Record<string, RouteValue>;
type Pending = { resolve(v: unknown): void; reject(e: Error): void };

const g = globalThis as unknown as Record<string, unknown>;
const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

let handler: Handler | undefined;
let routes: Routes = {};

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
  const html = (await rpc<string | undefined>("read", imp.__htmlImport)) ?? "";
  const out = html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=)(["'])([^"']+)\2/gi, (m, pre: string, q: string, ref: string) =>
    /^(https?:|data:|\/\/|#)/.test(ref) ? m : `${pre}${q}/__vfs/${norm(ref.startsWith("/") ? ref : `${dir}/${ref}`)}${q}`,
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
    if (typeof value === "function") return value(req, undefined);
    const byMethod = value[req.method];
    if (byMethod) return byMethod instanceof Response ? byMethod.clone() : byMethod(req, undefined);
  }
  if (handler) return handler(req, undefined);
  return new Response("Not Found", { status: 404 });
}
let nextId = 1;
const pending = new Map<number, Pending>();

function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: "rpc", id, op, args });
  });
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
    this.name = norm(path);
  }
  async exists() {
    return rpc<boolean>("exists", this.name);
  }
  async bytes() {
    const d = await rpc<string | Uint8Array | undefined>("read", this.name);
    if (d === undefined) throw new Error(`ENOENT: no such file: ${this.name}`);
    return typeof d === "string" ? new TextEncoder().encode(d) : d;
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
  await rpc("write", norm(path), out);
  return typeof out === "string" ? new TextEncoder().encode(out).length : out.byteLength;
}

async function main() {
  const semver = await loadSemver();
  g.Bun = {
    version: "1.4.4-browser",
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
      const server = {
        port,
        hostname,
        url: new URL(`http://${hostname}:${port}/`),
        stop() {
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
    if (m.type === "rpcResult") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) p?.resolve(m.value);
      else p?.reject(new Error(m.error));
    } else if (m.type === "request") {
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
  await booted;
  try {
    await import(/* @vite-ignore */ `/__vfs/${e.data.entry}`);
  } catch (err) {
    post({ type: "console", level: "error", text: fmt(err) });
  }
  post({ type: "ready" });
});
