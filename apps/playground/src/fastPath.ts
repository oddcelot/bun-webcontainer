/**
 * The import-map fast path, opt-in with `?fast` in the page's URL: a browser-only project skips `bun install` and the
 * runtime worker. Each project file is transpiled on its own by the wasm transpiler, the specifiers of project files
 * become `vfs:/<path>` keys, every file becomes a `data:` URL, bare imports map to esm.sh, and the lot is one
 * `<script type="importmap">` in the preview document, set as the preview iframe's `srcdoc`.
 *
 * The document runs in a sandboxed frame (opaque origin, scripts only), so project code never shares the editor's
 * origin, which is why the files are `data:` and not `blob:` URLs (a blob URL isn't readable from an opaque origin).
 */
import { dirname, norm, type VFS } from "@runbun/vfs";
import { parseBunLock } from "./lockfile";
import { tsconfigFor } from "./tsconfig";
import { loadTranspiler, transpile } from "./transpiler";

let fastPref = () => false;
/** The settings toggle's getter (workspace.ts), so this module stays free of UI state. */
export const bindFastPref = (get: () => boolean) => void (fastPref = get);
/** Whether the fast path is on: the "Fast path" toggle, or `?fast` in the page's URL (for links). */
export const fastPathOn = (): boolean => {
  const url = new URLSearchParams(location.search).get("fast");
  return fastPref() || (url !== null && url !== "false");
};

const CDN = "https://esm.sh";
const JS = /\.[cm]?[jt]sx?$/;
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".css"];
/** What a browser-only project mustn't use: Bun's or Node's APIs, which need the worker. */
const SERVER_USE = /\bBun\.|\bBun\b\s*\.|["']node:|["']bun:|\brequire\(|\bprocess\.(env|argv|cwd)/;

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; scripts?: Record<string, string> };

/** Why `vfs` isn't a browser-only project, or undefined if it is: it needs a root index.html, and no project file may use Bun.*, node:*, bun:* or require(). */
export function disqualified(vfs: VFS): string | undefined {
  if (!vfs.files.has("index.html")) return "no index.html at the root";
  for (const [path] of vfs.files) {
    if (path.startsWith("node_modules/") || path.includes("/node_modules/") || !JS.test(path)) continue;
    const src = vfs.readText(path) ?? "";
    const hit = SERVER_USE.exec(src);
    if (hit) return `${path} uses ${hit[0].trim()}`;
  }
}
export const qualifies = (vfs: VFS) => disqualified(vfs) === undefined;

const pkgName = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

/** The version of `name`: what bun.lock recorded, else package.json's range (esm.sh takes ranges), else none. */
function versionOf(vfs: VFS, name: string): string {
  try {
    const lock = vfs.readText("bun.lock");
    const entry = lock ? parseBunLock(lock).packages[name]?.[0] : undefined;
    if (typeof entry === "string" && entry.startsWith(`${name}@`)) return entry.slice(name.length + 1);
  } catch {}
  try {
    const p = JSON.parse(vfs.readText("package.json") ?? "{}") as Pkg;
    return p.dependencies?.[name] ?? p.devDependencies?.[name] ?? p.peerDependencies?.[name] ?? "";
  } catch {
    return "";
  }
}

/** Resolves a relative or absolute import of a project file to a VFS path (extension and index probing), or undefined. */
function resolveLocal(vfs: VFS, spec: string, from: string): string | undefined {
  const base = spec.startsWith("/") ? norm(spec.slice(1)) : norm(`${dirname(from)}/${spec}`);
  for (const c of [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)]) if (vfs.files.has(c)) return c;
}

const dataUrl = (code: string, type = "text/javascript") => `data:${type};charset=utf-8,${encodeURIComponent(code)}`;

/**
 * Whether `vfs` is a Solid 2 project, whose JSX only Solid's own compiler turns into DOM code (Bun's transpiler, like
 * every other, would make `jsx()` calls Solid 2 has no runtime for): it depends on `@solidjs/web`, or on solid-js 2.
 */
function solid2(vfs: VFS): boolean {
  return versionOf(vfs, "@solidjs/web") !== "" || /^\D*2\./.test(versionOf(vfs, "solid-js"));
}

type SolidJsx = (src: string, filename: string) => string;
let solidJsx: Promise<SolidJsx> | undefined;
/**
 * Solid 2's JSX compiler: Solid's Babel plugin in @babel/standalone, loaded the first time a Solid 2 project runs. Not
 * Solid's Oxc build (`@solidjs/compiler`): its wasm needs shared memory, which an embed on a page that isn't
 * cross-origin isolated doesn't have. The JSX becomes DOM code; the types stay for the transpiler to strip.
 */
function loadSolidJsx(): Promise<SolidJsx> {
  return (solidJsx ??= Promise.all([import("@babel/standalone"), import("@solidjs/babel-plugin")]).then(([babel, solid]) => {
    const plugin = (solid as Partial<typeof solid>).default ?? (solid as unknown as typeof solid.default);
    return (src, filename) =>
      babel.transform(src, {
        filename,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["jsx", "typescript"] },
        plugins: [[plugin, { generate: "dom", moduleName: "@solidjs/web", dev: true }]],
      })?.code ?? "";
  }));
}

/** What {@link buildFast} made. */
export type Fast = { html: string; modules: number; packages: string[]; solid: boolean; ms: { transpile: number } };

/** The preview document for a qualifying project: index.html with an import map, over data: URLs of the transpiled files. */
export async function buildFast(vfs: VFS): Promise<Fast> {
  const t0 = performance.now();
  const solid = solid2(vfs) ? await loadSolidJsx() : undefined;
  await loadTranspiler();
  const html = vfs.readText("index.html")!;
  const imports: Record<string, string> = {};
  const bare = new Set<string>();
  const seen = new Set<string>();

  async function module(path: string): Promise<void> {
    if (seen.has(path)) return;
    seen.add(path);
    const src = vfs.readText(path) ?? "";
    let code: string;
    if (path.endsWith(".css")) {
      code = `const s = document.createElement("style"); s.dataset.src = ${JSON.stringify(path)}; s.textContent = ${JSON.stringify(src)}; document.head.append(s);\nexport default {};`;
    } else if (path.endsWith(".json")) {
      code = `export default ${src};`;
    } else {
      const next: string[] = [];
      const input = solid && /\.[jt]sx$/.test(path) ? solid(src, path) : src;
      code = await transpile(input, path, tsconfigFor(vfs, path), (spec) => {
        if (/^(?:\.{0,2}\/|\.\.?$)/.test(spec)) {
          const target = resolveLocal(vfs, spec, path);
          if (!target) return null;
          next.push(target);
          return `vfs:/${target}`;
        }
        if (/^(?:https?|data|blob|vfs):/.test(spec)) return null;
        bare.add(spec);
        return null;
      });
      await Promise.all(next.map(module));
    }
    imports[`vfs:/${path}`] = dataUrl(code);
  }

  // The page's own entries: module scripts, and stylesheets as data: URLs.
  const entries: string[] = [];
  let doc = html.replace(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (all, a: string, src: string, b: string) => {
    if (!/type=["']module["']/i.test(a + b) || /^(?:https?:)?\/\//.test(src)) return all;
    const path = resolveLocal(vfs, src, "index.html");
    if (!path) return all;
    entries.push(path);
    return `<script type="module">import "vfs:/${path}";</script>`;
  });
  doc = doc.replace(/<link\b([^>]*?)href=["']([^"']+)["']([^>]*)>/gi, (all, a: string, href: string, b: string) => {
    if (!/rel=["']stylesheet["']/i.test(a + b) || /^(?:https?:)?\/\//.test(href)) return all;
    const path = resolveLocal(vfs, href, "index.html");
    if (!path) return all;
    return `<link${a}href="${dataUrl(vfs.readText(path) ?? "", "text/css")}"${b}>`;
  });
  await Promise.all(entries.map(module));
  const t1 = performance.now();

  // Bare specifiers: esm.sh, the root package's other dependencies external so each framework loads once.
  let pkg: Pkg = {};
  try {
    pkg = JSON.parse(vfs.readText("package.json") ?? "{}") as Pkg;
  } catch {}
  const direct = Object.keys({ ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies }).filter((n) => !n.startsWith("@types/"));
  const specs = new Set<string>(bare);
  for (const name of direct) specs.add(name);
  const packages = new Set<string>();
  for (const spec of specs) {
    const name = pkgName(spec);
    const version = versionOf(vfs, name);
    packages.add(`${name}@${version}`);
    const external = direct.filter((n) => n !== name).join(",");
    const query = [external && `external=${external}`, "dev"].filter(Boolean).join("&");
    imports[spec] = `${CDN}/${name}${version ? `@${version}` : ""}${spec.slice(name.length)}?${query}`;
    // Subpaths other packages import (`react/jsx-runtime`), unscanned: the package's own, without externals.
    imports[`${name}/`] ??= `${CDN}/${name}${version ? `@${version}` : ""}/`;
  }
  const map = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
  // The storage stand-ins, the error reporter, the console forwarder and the map come before any script of the page.
  const head = STORAGE + REPORT + CONSOLE + map;
  const out = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (m) => m + head) : head + doc;
  return { html: out, modules: seen.size, packages: [...packages], solid: !!solid, ms: { transpile: Math.round(t1 - t0) } };
}

/** Marks the messages the frame posts, so the editor takes only ours. */
const TAG = "runbun-fast";
/** Reports the page's uncaught errors and unhandled rejections to the editor, which logs them in the console. */
const REPORT = `<script>for (const type of ["error", "unhandledrejection"]) addEventListener(type, (e) => { const err = e.error ?? e.reason; parent.postMessage({ tag: ${JSON.stringify(TAG)}, text: String((err && err.stack) || err || e.message) }, "*"); });</script>`;
/**
 * localStorage and sessionStorage throw in an opaque origin: in-memory stand-ins with the whole Storage interface (and
 * `storage.key = value`, `in`, `Object.keys`), per run: a Run starts the page, and its storage, over.
 */
const STORAGE = `<script>(() => {
  const make = () => {
    const m = new Map();
    const api = {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => void m.set(String(k), String(v)),
      removeItem: (k) => void m.delete(String(k)),
      clear: () => m.clear(),
      key: (i) => [...m.keys()][Number(i)] ?? null,
    };
    return new Proxy(api, {
      get: (t, p) => (p === "length" ? m.size : p === Symbol.toStringTag ? "Storage" : p in t ? t[p] : typeof p === "string" && m.has(p) ? m.get(p) : undefined),
      set: (t, p, v) => (typeof p === "string" && m.set(p, String(v)), true),
      deleteProperty: (t, p) => (m.delete(p), true),
      has: (t, p) => p in t || m.has(p),
      ownKeys: () => [...m.keys()],
      getOwnPropertyDescriptor: (t, p) => (m.has(p) ? { value: m.get(p), enumerable: true, configurable: true, writable: true } : undefined),
    });
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    const value = make();
    Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => value });
  }
})();</script>`;
/** Most console lines one run forwards: a hot loop mustn't flood the editor; the rest is one "dropped" line. */
const MAX_LINES = 1000;
/**
 * Forwards console.log/info/debug (as `log`), warn and error to the editor, still calling the originals. Arguments are
 * shown as a console would (strings as they are, errors with their stack, objects to a depth of 2 and 20 entries), the
 * lines are batched into one message per microtask burst, and past MAX_LINES the page says so once and stops.
 */
const CONSOLE = `<script>(() => {
  const MAX = ${MAX_LINES}, LEVELS = { log: "log", info: "log", debug: "log", warn: "warn", error: "error" };
  let sent = 0, queue = [], scheduled = false;
  const flush = () => { scheduled = false; const lines = queue; queue = []; parent.postMessage({ tag: ${JSON.stringify(TAG)}, lines }, "*"); };
  const push = (level, text) => {
    if (sent > MAX) return;
    queue.push(sent === MAX ? ["warn", "… more lines dropped (the preview forwards " + MAX + " per run)"] : [level, text]);
    sent++;
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  };
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  const show = (v, depth, seen) => {
    try {
      switch (typeof v) {
        case "string": return depth ? JSON.stringify(clip(v, 200)) : v;
        case "function": return "[Function" + (v.name ? ": " + v.name : " (anonymous)") + "]";
        case "bigint": return v + "n";
        case "object": if (v === null) return "null"; break;
        default: return String(v);
      }
      if (v instanceof Error) return depth ? "[" + String(v) + "]" : String(v.stack || v);
      if (typeof Node !== "undefined" && v instanceof Node) return "<" + v.nodeName.toLowerCase() + ">";
      if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (seen.includes(v)) return "[Circular]";
      const name = v.constructor && v.constructor.name;
      const list = (items, total) => items.join(", ") + (total > items.length ? ", … " + (total - items.length) + " more" : "");
      const next = seen.concat([v]);
      if (Array.isArray(v)) {
        if (depth > 2) return "[Array]";
        return v.length ? "[ " + list(v.slice(0, 20).map((x) => show(x, depth + 1, next)), v.length) + " ]" : "[]";
      }
      if (v instanceof Map || v instanceof Set) {
        if (depth > 2) return "[" + name + "]";
        const items = [...v].slice(0, 20).map((x) => (v instanceof Map ? show(x[0], depth + 1, next) + " => " + show(x[1], depth + 1, next) : show(x, depth + 1, next)));
        return name + "(" + v.size + ") { " + list(items, v.size) + " }";
      }
      if (depth > 2) return "[" + (name || "Object") + "]";
      const keys = Object.keys(v);
      const prefix = name && name !== "Object" ? name + " " : "";
      return keys.length ? prefix + "{ " + list(keys.slice(0, 20).map((k) => k + ": " + show(v[k], depth + 1, next)), keys.length) + " }" : prefix + "{}";
    } catch (e) {
      return "[unprintable]";
    }
  };
  for (const method of Object.keys(LEVELS)) {
    const original = console[method];
    console[method] = function (...args) {
      try { push(LEVELS[method], clip(args.map((a) => show(a, 0, [])).join(" "), 4000)); } catch {}
      return original.apply(this, args);
    };
  }
})();</script>`;
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads";

let shown: { frame: HTMLIFrameElement; log: Log } | undefined;
type Log = (level: "sys" | "error" | "warn" | "log", text: string) => void;

const FORWARDED = new Set(["log", "warn", "error"]);
/** A page's stack has its modules' whole sources in it, as data: URLs. */
const trim = (text: string) => text.replace(/data:[^\s]*?(?=:\d+:\d+)/g, "data:…").slice(0, 4000);

addEventListener("message", (e) => {
  const d = e.data as { tag?: unknown; text?: unknown; lines?: unknown } | null;
  if (!shown || e.source !== shown.frame.contentWindow || d?.tag !== TAG) return;
  if (typeof d.text === "string") shown.log("error", trim(d.text));
  else if (Array.isArray(d.lines)) {
    // The frame is the page's: take only well-formed lines, and no more than a run forwards in one message.
    for (const line of d.lines.slice(0, MAX_LINES + 1) as unknown[]) {
      if (!Array.isArray(line) || typeof line[0] !== "string" || typeof line[1] !== "string" || !FORWARDED.has(line[0])) continue;
      shown.log(line[0] as "log" | "warn" | "error", trim(line[1]));
    }
  }
});

/** Builds the preview in `frame`; the status text for the run, or undefined (after a `sys` line saying why) when the project doesn't qualify. */
export async function runFast(vfs: VFS, frame: HTMLIFrameElement | undefined, log: Log): Promise<string | undefined> {
  const why = disqualified(vfs);
  if (why) {
    log("sys", `[fast] not used, running normally: ${why}`);
    return undefined;
  }
  if (!frame) throw new Error("no preview frame");
  const t = performance.now();
  const fast = await buildFast(vfs);
  log("sys", `[fast] packages come from ${CDN}: ${fast.packages.join(", ") || "none"}`);
  shown = { frame, log };
  frame.setAttribute("sandbox", SANDBOX);
  frame.srcdoc = fast.html;
  log("sys", `[fast] ${fast.modules} modules transpiled${fast.solid ? " (JSX by Solid 2's compiler)" : ""}, preview set after ${Math.round(performance.now() - t)} ms`);
  return "Previewed through an import map";
}

/** Gives `frame` back to the server's preview after {@link runFast} used it: the document and the sandbox go, the next load is the server's. */
export function leaveFast(frame: HTMLIFrameElement | undefined) {
  if (!frame || shown?.frame !== frame) return;
  shown = undefined;
  frame.removeAttribute("srcdoc");
  frame.removeAttribute("sandbox");
}
