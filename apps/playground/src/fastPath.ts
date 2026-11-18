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
  // The map and the error reporter come before any script of the page.
  const head = REPORT + map;
  const out = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (m) => m + head) : head + doc;
  return { html: out, modules: seen.size, packages: [...packages], solid: !!solid, ms: { transpile: Math.round(t1 - t0) } };
}

/** Marks the messages the frame posts, so the editor takes only ours. */
const TAG = "runbun-fast";
/** Reports the page's uncaught errors and unhandled rejections to the editor, which logs them in the console. */
const REPORT = `<script>for (const type of ["error", "unhandledrejection"]) addEventListener(type, (e) => { const err = e.error ?? e.reason; parent.postMessage({ tag: ${JSON.stringify(TAG)}, text: String((err && err.stack) || err || e.message) }, "*"); });</script>`;
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads";

let shown: { frame: HTMLIFrameElement; log: Log } | undefined;
type Log = (level: "sys" | "error" | "log", text: string) => void;

addEventListener("message", (e) => {
  const d = e.data as { tag?: unknown; text?: unknown } | null;
  if (!shown || e.source !== shown.frame.contentWindow || d?.tag !== TAG || typeof d.text !== "string") return;
  // A module's own data: URL is its whole source: out of the stack.
  shown.log("error", d.text.replace(/data:[^\s]*?(?=:\d+:\d+)/g, "data:…").slice(0, 4000));
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
