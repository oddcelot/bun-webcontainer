import { globMatch } from "../../resolver";
const cwd = () => (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? "/";

function segments(p: string, abs: boolean): string {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
    } else out.push(s);
  }
  return out.join("/");
}

function check(p: unknown, name = "path"): asserts p is string {
  if (typeof p !== "string") {
    throw Object.assign(new TypeError(`The "${name}" argument must be of type string. Received ${p === null ? "null" : typeof p}`), { code: "ERR_INVALID_ARG_TYPE" });
  }
}

const isAbsolute = (p: string) => (check(p), p.startsWith("/"));

function normalize(p: string): string {
  check(p);
  if (!p) return ".";
  const abs = p.startsWith("/");
  let r = segments(p, abs);
  if (!r && !abs) r = ".";
  if (r && p.endsWith("/")) r += "/";
  return abs ? "/" + r : r;
}

function resolve(...args: string[]): string {
  let resolved = "";
  for (let i = args.length - 1; i >= -1 && !resolved.startsWith("/"); i--) {
    const p = i >= 0 ? args[i] : cwd();
    check(p, `paths[${i}]`);
    if (p) resolved = `${p}/${resolved}`;
  }
  return "/" + segments(resolved, true);
}

function join(...args: string[]): string {
  const parts = args.filter((a) => (check(a), a));
  return parts.length ? normalize(parts.join("/")) : ".";
}

function relative(from: string, to: string): string {
  check(from, "from");
  check(to, "to");
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

function dirname(p: string): string {
  check(p);
  let end = p.length;
  while (end > 1 && p[end - 1] === "/") end--;
  const i = p.lastIndexOf("/", end - 1);
  if (i < 0) return ".";
  let d = i;
  while (d > 0 && p[d - 1] === "/") d--;
  return d === 0 ? "/" : p.slice(0, d);
}

function basename(p: string, ext?: string): string {
  check(p);
  let end = p.length;
  while (end > 1 && p[end - 1] === "/") end--;
  const s = p.slice(0, end);
  const base = s === "/" ? "" : s.slice(s.lastIndexOf("/") + 1);
  return ext && base !== ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 || base === ".." ? "" : base.slice(i);
}

type ParsedPath = { root: string; dir: string; base: string; ext: string; name: string };

function parse(p: string): ParsedPath {
  check(p);
  const root = p.startsWith("/") ? "/" : "";
  const base = basename(p);
  const ext = extname(p);
  const dir = p.includes("/") ? (dirname(p) === "." ? "" : dirname(p)) : "";
  return { root, dir: base === "" ? (root ? root : dir) : dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

function format(o: Partial<ParsedPath>): string {
  const dir = o.dir || o.root;
  const base = o.base || `${o.name ?? ""}${o.ext ? (o.ext.startsWith(".") ? "" : ".") + o.ext : ""}`;
  if (!dir) return base;
  return dir === o.root ? dir + base : `${dir}/${base}`;
}

/** `path.matchesGlob(path, pattern)` (Node 22): Bun's own matcher, as `Bun.Glob#match`; leading dots aren't special. */
function matchesGlob(p: string, pattern: string): boolean {
  if (typeof p !== "string") throw argType("path", p);
  if (typeof pattern !== "string") throw argType("pattern", pattern);
  return globMatch(pattern, p);
}
/** Node's (and Bun's) wording: `The "path" argument must be of type string. Received type number (1)`. */
const received = (v: unknown) =>
  v == null
    ? `Received ${v}`
    : typeof v === "function"
      ? `Received function ${v.name}`
      : typeof v === "object"
        ? `Received an instance of ${(v as object).constructor?.name ?? "Object"}`
        : `Received type ${typeof v} (${String(v)})`;
const argType = (name: string, v: unknown) =>
  Object.assign(new TypeError(`The "${name}" argument must be of type string. ${received(v)}`), { code: "ERR_INVALID_ARG_TYPE" });

const path = {
  sep: "/",
  delimiter: ":",
  isAbsolute,
  normalize,
  resolve,
  join,
  relative,
  dirname,
  basename,
  extname,
  parse,
  format,
  toNamespacedPath: (p: string) => p,
  matchesGlob,
  posix: undefined as unknown,
  win32: undefined as unknown,
};
path.posix = path;
path.win32 = path;

export default path;
