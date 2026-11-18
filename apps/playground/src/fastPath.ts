// SPIKE (bwc-me5n): an opt-in "import map" fast path for browser-only projects, after the Solid REPL.
//
// A project that qualifies (qualifies()) skips `bun install` and the worker: each project file is transpiled on its
// own by the wasm transpiler (the specifiers of project files become `vfs:/<path>` keys), every file becomes a blob:
// URL, bare imports map to esm.sh, and the lot is one <script type="importmap"> in the preview document, set as the
// preview iframe's `srcdoc`. Opt in with `?fast` in the page's URL or localStorage["playground.fast"] = "1".
import { dirname, norm, type VFS } from "@runbun/vfs";
import { parseBunLock } from "./lockfile";
import { tsconfigFor } from "./tsconfig";
import { loadTranspiler, transpile } from "./transpiler";

export const fastPathOn = (): boolean => {
  try {
    return new URLSearchParams(location.search).has("fast") || localStorage.getItem("playground.fast") === "1";
  } catch {
    return false;
  }
};

const CDN = "https://esm.sh";
const JS = /\.[cm]?[jt]sx?$/;
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".css"];
/** What a browser-only project mustn't use: Bun's or Node's APIs, which need the worker. */
const SERVER_USE = /\bBun\.|\bBun\b\s*\.|["']node:|["']bun:|\brequire\(|\bprocess\.(env|argv|cwd)/;

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; scripts?: Record<string, string> };

/** Why `vfs` isn't a browser-only project, or undefined if it is. Rule: a root index.html, and no project file uses Bun.*, node:*, bun:* or require(). */
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

const blob = (code: string, type = "text/javascript") => URL.createObjectURL(new Blob([code], { type }));

let urls: string[] = [];

export type Fast = { html: string; modules: number; packages: string[]; ms: { transpile: number } };

/** The preview document for a qualifying project: index.html with an import map, over blob: URLs of the transpiled files. */
export async function buildFast(vfs: VFS): Promise<Fast> {
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  const t0 = performance.now();
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
      code = await transpile(src, path, tsconfigFor(vfs, path), (spec) => {
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
    imports[`vfs:/${path}`] = blob(code);
    urls.push(imports[`vfs:/${path}`]);
  }

  // The page's own entries: module scripts, and stylesheets as blobs.
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
    const url = blob(vfs.readText(path) ?? "", "text/css");
    urls.push(url);
    return `<link${a}href="${url}"${b}>`;
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
  const out = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (m) => m + map) : map + doc;
  return { html: out, modules: seen.size, packages: [...packages], ms: { transpile: Math.round(t1 - t0) } };
}

/** Builds and shows the preview in `frame`; the status text for the run. */
export async function runFast(vfs: VFS, frame: HTMLIFrameElement | undefined, log: (level: "sys" | "error" | "log", text: string) => void): Promise<string | undefined> {
  const why = disqualified(vfs);
  if (why) {
    log("sys", `[fast] not used: ${why}`);
    return undefined;
  }
  const t = performance.now();
  const fast = await buildFast(vfs);
  log("sys", `[fast] ${fast.modules} modules in ${fast.ms.transpile} ms, ${fast.packages.length} packages from ${CDN}: ${fast.packages.join(", ")}`);
  if (!frame) throw new Error("no preview frame");
  frame.srcdoc = fast.html;
  performance.mark("fast-preview-set");
  log("sys", `[fast] preview set after ${Math.round(performance.now() - t)} ms`);
  return "Previewed through an import map";
}
