import { isCommonJS, wrapCommonJS } from "./cjs";
import { transpile } from "./transpiler";
import { dirname, norm, type VFS } from "./vfs";

export type ModuleResponse = { status: number; body: string };

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];
const CONDITIONS = new Set(["import", "browser", "module", "default"]);

function resolveFile(vfs: VFS, p: string): string | null {
  if (vfs.files.has(p)) return p;
  for (const e of EXTS) if (vfs.files.has(p + e)) return p + e;
  for (const e of EXTS) if (vfs.files.has(`${p}/index${e}`)) return `${p}/index${e}`;
  return null;
}

function pickTarget(t: unknown): string | null {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    for (const x of t) {
      const r = pickTarget(x);
      if (r) return r;
    }
    return null;
  }
  if (t && typeof t === "object") {
    for (const [k, v] of Object.entries(t)) {
      if (!CONDITIONS.has(k)) continue;
      const r = pickTarget(v);
      if (r) return r;
    }
  }
  return null;
}

function pickExport(exports: unknown, sub: string): string | null {
  const isMap = exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith("."));
  if (!isMap) return sub === "." ? pickTarget(exports) : null;
  return pickTarget((exports as Record<string, unknown>)[sub]);
}

/** `"type"` of the nearest package.json above `path`. */
function packageType(vfs: VFS, path: string): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const text = vfs.readText(dir ? `${dir}/package.json` : "package.json");
    if (text !== undefined) {
      try {
        return (JSON.parse(text) as { type?: string }).type;
      } catch {
        return undefined;
      }
    }
    if (!dir) return undefined;
  }
}

/** Nearest `node_modules/<name>` walking up from `fromDir`, like Node's lookup. */
function findPackage(vfs: VFS, name: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const base = norm(`${dir}/node_modules/${name}`);
    if (vfs.files.has(`${base}/package.json`)) return base;
    if (!dir) return null;
    dir = dirname(dir);
    if (dir.endsWith("/node_modules")) dir = dirname(dir);
  }
}

function resolveBare(vfs: VFS, spec: string, fromDir: string): string | null {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const sub = "." + spec.slice(name.length);
  const base = findPackage(vfs, name, fromDir);
  if (base === null) return null;
  const text = vfs.readText(`${base}/package.json`)!;
  const pkg = JSON.parse(text) as { exports?: unknown; module?: string; main?: string };
  if (pkg.exports !== undefined) {
    const t = pickExport(pkg.exports, sub);
    return t ? resolveFile(vfs, norm(`${base}/${t}`)) : null;
  }
  if (sub !== ".") return resolveFile(vfs, norm(`${base}/${sub}`));
  const entry = pkg.module ?? pkg.main ?? "index.js";
  return resolveFile(vfs, norm(`${base}/${entry}`));
}

const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;

function rewriteImports(vfs: VFS, code: string, dir: string): string {
  return code.replace(SPEC_RE, (m, pre: string, q: string, spec: string) => {
    if (/^(node:|https?:|data:|blob:|\/__vfs\/)/.test(spec)) return m;
    const target = spec.startsWith(".")
      ? resolveFile(vfs, norm(`${dir}/${spec}`))
      : spec.startsWith("/")
        ? resolveFile(vfs, norm(spec))
        : resolveBare(vfs, spec, dir);
    return `${pre}${q}/__vfs/${target ?? `__unresolved__/${encodeURIComponent(spec)}`}${q}`;
  });
}

export async function serveModule(vfs: VFS, rawPath: string, onError: (msg: string) => void): Promise<ModuleResponse> {
  const path = norm(rawPath);
  if (path.startsWith("__unresolved__/")) {
    const msg = `cannot resolve "${decodeURIComponent(path.slice(15))}"`;
    onError(msg);
    return { status: 404, body: msg };
  }
  const src = vfs.readText(path);
  if (src === undefined) {
    onError(`module not found: ${path}`);
    return { status: 404, body: `Not found: ${path}` };
  }
  try {
    let code: string;
    if (path.endsWith(".html")) return { status: 200, body: `export default ${JSON.stringify({ __htmlImport: path })};` };
    if (path.endsWith(".css")) return { status: 200, body: src };
    if (path.endsWith(".json")) code = `export default ${src}`;
    else if (/\.(ts|tsx|jsx)$/.test(path)) code = await transpile(src, path);
    else if (isCommonJS(path, src, packageType(vfs, path))) code = wrapCommonJS(path, src);
    else code = src;
    return { status: 200, body: rewriteImports(vfs, code, dirname(path)) };
  } catch (e) {
    const msg = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    onError(msg);
    return { status: 500, body: msg };
  }
}
