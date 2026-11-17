// `Bun.FileSystemRouter` over the worker's VFS: a port of Bun's router (bun/src/router/lib.rs) and its JS class
// (bun/src/runtime/api/filesystem_router.rs), down to their quirks: the route order, which file wins, how a path is
// decoded and split from its query, `src` from `origin` and `assetPrefix`.
import { codeError } from "./node/errors";
import fs from "./node/fs";
import nodePath from "./node/path";
import process from "./node/process";

const DEFAULT_EXTENSIONS = ["tsx", "jsx", "ts", "mjs", "cjs", "js"];

const enum Tag {
  Static,
  Dynamic,
  CatchAll,
  OptionalCatchAll,
}

/** One segment of a route name (Bun's `Pattern`): a static string, or a parameter at [offset, offset + len). */
type Pattern = { tag: Tag; str: string; offset: number; plen: number; len: number };

class PatternError extends Error {}

/** Bun's `Pattern::init`: the segment of `input` at `start`, `len` where the next one starts. */
function patternAt(input: string, start: number): Pattern {
  const make = (tag: Tag, len: number, str = "", offset = 0, plen = 0): Pattern => ({ tag, str, offset, plen, len });
  let offset = start;
  while (input.length > offset && input[offset] === "/") offset++;
  if (input.length === 0 || input.length <= offset) return make(Tag.Static, Math.min(input.length, offset));
  const end = input.length - 1;
  if (offset === end) return make(Tag.Static, offset);
  let i = offset;
  for (; i <= end; i++) {
    const c = input[i];
    if (c === "/") return make(Tag.Static, Math.min(i + 1, end), input.slice(offset, i));
    if (c !== "[") continue;
    if (i > offset) return make(Tag.Static, i, input.slice(offset, i));
    let tag = Tag.Dynamic;
    i++;
    let pOffset = i;
    if (i >= end) throw new PatternError("Invalid dynamic route");
    const d = input[i];
    if (d === "/" || d === "]") throw new PatternError("Route is missing a parameter name, e.g. [param]");
    if (d === "[") {
      tag = Tag.OptionalCatchAll;
      if (end < i + 4) throw new PatternError("Invalid optional catch-all route, e.g. should be [[...param]]");
      i++;
      if (!input.startsWith("...", i)) throw new PatternError("Invalid optional catch-all route, e.g. should be [[...param]]");
      i += 3;
      pOffset = i;
    } else if (d === ".") {
      tag = Tag.CatchAll;
      i++;
      if (end < i + 2 || !input.startsWith("..", i)) throw new PatternError("Invalid catch-all route, e.g. should be [...param]");
      i += 2;
      pOffset = i;
    }
    i++;
    while (i <= end && input[i] !== "]") {
      if (input[i] === "/") throw new PatternError("Invalid dynamic route");
      i++;
    }
    if (i > end) throw new PatternError("Route is missing a closing bracket]");
    const plen = i - pOffset;
    i++;
    if (tag === Tag.OptionalCatchAll) {
      if (i > end || input[i] !== "]") throw new PatternError("Route is missing a closing bracket]");
      i++;
    }
    if (tag > Tag.Dynamic && i <= end) throw new PatternError("Catch-all route must be at the end of the path");
    return make(tag, Math.min(i + 1, end), "", pOffset, plen);
  }
  return make(Tag.Static, i, input.slice(offset, i));
}

const isEnd = (p: Pattern, input: string) => p.len >= input.length - 1;

/** Bun's `Pattern::validate`: the route's kind (its most dynamic segment) and parameter count. */
function validate(input: string): { kind: Tag; params: number } {
  let count = 0;
  let kind = Tag.Static;
  for (let offset = 0; offset < input.length - 1; ) {
    const p = patternAt(input, offset);
    offset = p.len;
    if (p.tag > kind) kind = p.tag;
    if (p.tag > Tag.Static) count++;
  }
  return { kind, params: count };
}

type Param = [name: string, value: string];

/** Bun's `Pattern::match_` (with optional catch-alls): `path` without its leading slash against a route's name. */
function matchPattern(path: string, name: string, matchName: string, params: Param[]): boolean {
  let offset = 0;
  let rest = path;
  while (offset < name.length) {
    let p = patternAt(matchName, offset);
    offset = p.len;
    const param = () => name.slice(p.offset, p.offset + p.plen);
    if (p.tag === Tag.Static) {
      const slash = rest.indexOf("/");
      const segment = slash < 0 ? rest : rest.slice(0, slash);
      if (p.str !== segment) return ((params.length = 0), false);
      rest = segment.length < rest.length ? rest.slice(segment.length + 1) : "";
      if (rest === "" && isEnd(p, name)) return true;
    } else if (p.tag === Tag.Dynamic) {
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        params.push([param(), rest.slice(0, slash)]);
        rest = rest.slice(slash + 1);
        if (isEnd(p, name)) return ((params.length = 0), false);
        continue;
      }
      if (isEnd(p, name)) return (params.push([param(), rest]), true);
      const dynamicName = param();
      p = patternAt(matchName, offset);
      if (p.tag === Tag.OptionalCatchAll) return (params.push([dynamicName, rest]), true);
      return ((params.length = 0), false);
    } else if (p.tag === Tag.CatchAll) {
      if (rest === "") return false;
      params.push([param(), rest]);
      return true;
    } else {
      if (rest !== "") params.push([param(), rest]);
      return true;
    }
  }
  return false;
}

type Route = { name: string; matchName: string; filePath: string; kind: Tag; params: number; hasUppercase: boolean; index: boolean };

/** Bun's sort table: `[`, `]` and `/` after every other byte, so deeper and static segments are tried first. */
const sortKey = (c: number) => (c === 0x5b ? 252 : c === 0x5d ? 253 : c === 0x2f ? 254 : c);
function lessByName(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = sortKey(a.charCodeAt(i));
    const y = sortKey(b.charCodeAt(i));
    if (x !== y) return x < y;
  }
  return a.length < b.length;
}
function less(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) return a.kind < b.kind;
  if (a.kind >= Tag.CatchAll && a.params !== b.params) return a.params > b.params;
  return lessByName(a.matchName, b.matchName);
}

type Routes = { list: Route[]; statics: Map<string, Route>; dynamic: Route[]; index?: Route };

/** The routes under `dir` (absolute, no trailing slash): Bun's `RouteLoader`. */
function loadRoutes(dir: string, extensions: string[]): Routes {
  const all: Route[] = [];
  const statics = new Map<string, Route>();
  const dynamicNames = new Map<string, string>();
  let index: Route | undefined;
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const walk = (abs: string, rel: string) => {
    for (const entry of fs.readdirSync(abs || "/", { withFileTypes: true }) as { name: string; isDirectory(): boolean; isFile(): boolean }[]) {
      const base = entry.name;
      if (base.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (base !== "node_modules") walk(`${abs}/${base}`, rel ? `${rel}/${base}` : base);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = base.lastIndexOf(".");
      const ext = dot < 0 ? "" : base.slice(dot);
      if (ext.length < 2 || !extensions.includes(ext.slice(1))) continue;
      const stem = base.slice(0, base.length - ext.length);
      const publicPath = stem === "" ? (rel ? `/${rel}` : "") : `${rel ? `/${rel}` : ""}/${base}`;
      let name = publicPath.slice(0, publicPath.length - ext.length);
      while (name.length > 1 && name.endsWith("/")) name = name.slice(0, -1);
      if (name.endsWith("/index")) name = name.slice(0, -6);
      name = name.replace(/\/+$/, "");
      const filePath = `${abs}/${base}`;
      let route: Route;
      if (name === "") route = { name: "/", matchName: "/", filePath, kind: Tag.Static, params: 0, hasUppercase: false, index: true };
      else {
        let v: { kind: Tag; params: number };
        try {
          v = validate(name.slice(1));
        } catch (e) {
          throw e instanceof PatternError ? new Error(`${e.message} (${filePath})`) : e;
        }
        const hasUppercase = /[A-Z]/.test(publicPath);
        route = { name, matchName: hasUppercase ? name.slice(1).toLowerCase() : name.slice(1), filePath, kind: v.kind, params: v.params, hasUppercase, index: false };
      }
      const defined = (by: string) => fail(`Route "${route.name}" is already defined by ${by}`);
      if (route.index) {
        index = route;
        all.push(route);
      } else if (route.params === 0) {
        const existing = statics.get(route.matchName);
        if (existing) defined(existing.filePath);
        if (route.hasUppercase) {
          const exact = statics.get(route.name.slice(1));
          if (exact) defined(exact.filePath);
          statics.set(route.name.slice(1), route);
        }
        statics.set(route.matchName, route);
        all.push(route);
      } else {
        const existing = dynamicNames.get(route.name);
        if (existing) defined(existing);
        dynamicNames.set(route.name, filePath);
        all.push(route);
      }
    }
  };
  walk(dir, "");
  all.sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
  const dynamic = all.filter((r) => r.kind > Tag.Static && !r.index);
  return { list: all, statics, dynamic, index };
}

/** Bun's `URLPath::parse`: the decoded pathname (query included), the path to match and where the query starts. */
function parseUrlPath(raw: string): { pathname: string; path: string; query: string } {
  let decoded = raw;
  if (raw.includes("%")) {
    const bytes: number[] = [];
    const enc = new TextEncoder();
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== "%") {
        bytes.push(...enc.encode(raw[i]));
        continue;
      }
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error(`DecodingError parsing path: ${raw}`);
      bytes.push(parseInt(hex, 16));
      i += 2;
    }
    decoded = new TextDecoder().decode(new Uint8Array(bytes));
  }
  if (decoded === "") decoded = "/";
  let question = -1;
  let period = -1;
  let lastSlash = -1;
  for (let i = decoded.length - 1; i >= 0; i--) {
    const c = decoded[i];
    if (c === "?") {
      question = Math.max(question, i);
      if (question < period) period = -1;
      if (lastSlash > question) lastSlash = -1;
    } else if (c === ".") period = Math.max(period, i);
    else if (c === "/") lastSlash = Math.max(lastSlash, i);
  }
  if (lastSlash > period) period = -1;
  const extname = period < 0 ? "" : question > -1 ? decoded.slice(period + 1, question) : decoded.slice(period + 1);
  const pathEnd = question < 0 ? decoded.length : question;
  let path = decoded.slice(Math.min(1, pathEnd), pathEnd);
  // A source map's request names its file: `/a.js.map` routes as `/a.js`.
  if (extname === "map" && path.length > 4 && path.slice(0, -4).includes(".")) path = path.slice(0, -4);
  return { pathname: decoded, path: decoded.length === 1 ? "." : path, query: question > -1 ? decoded.slice(question) : "" };
}

/** Bun's `Routes::match_page_with_allocator`. */
function matchPage(routes: Routes, urlPath: string, params: Param[]): Route | undefined {
  let path = urlPath;
  if (path.endsWith("/")) path = path.slice(0, -1);
  while (path.endsWith("/index")) path = path.slice(0, -6);
  if (path === "index") path = "";
  path = path.replace(/\/+$/, "");
  if (path === ".") path = "";
  if (path === "") return routes.index;
  path = path.replace(/^\/+/, "");
  if (path === "") return routes.index;
  const hit = routes.statics.get(path);
  if (hit) return hit;
  for (const r of routes.dynamic) {
    if (matchPattern(path, r.name.slice(1), r.matchName, params)) return r;
    params.length = 0;
  }
  return undefined;
}

/** The origin part of an `origin` option (Bun's `URL.origin`), or undefined when it doesn't make `src` absolute. */
function originOf(origin: string | null): string | undefined {
  if (!origin) return undefined;
  const scheme = /^([a-z][a-z\d+.-]*:)\/\/([^/?#]*)/i.exec(origin);
  if (scheme) return scheme[2] ? `${scheme[1]}//${scheme[2]}` : undefined;
  const host = /^[^/?#]*/.exec(origin)![0];
  return host || undefined;
}

/** `match()`'s answer: its fields are getters, as on Bun's `MatchedRoute`. */
const MatchedRoute = {};
type Matched = { route: Route; pathname: string; queryString: string; params: Param[]; router: FileSystemRouter };
const matched = new WeakMap<object, Matched>();
const get = (o: object) => matched.get(o)!;

/** `params`: each parameter by name, and `query`: the parameters, then the query string's names they don't have. */
function record(entries: Param[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of entries) {
    const had = out[k];
    out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
  }
  return out;
}
const kindName = (name: string) => (name.includes("[[...") ? "optional-catch-all" : name.includes("[...") ? "catch-all" : name.includes("[") ? "dynamic" : "exact");
function src(this: object) {
  const { route, router } = get(this);
  const base = router.dir.endsWith("/") ? router.dir : `${router.dir}/`;
  const rel = route.filePath.startsWith(base) ? route.filePath.slice(base.length) : nodePath.relative(router.dir, route.filePath);
  const origin = originOf(router.origin);
  if (origin === undefined) return rel.replace(/^\/+/, "");
  if (rel.startsWith("..") || rel.startsWith("./")) return `${origin}/abs:${route.filePath}`;
  return `${origin}/${nodePath.normalize(`/${router.assetPrefix ?? ""}${rel}`).replace(/^\/+/, "")}`;
}
Object.defineProperties(MatchedRoute, {
  filePath: { get(this: object) { return get(this).route.filePath; } },
  kind: { get(this: object) { return kindName(get(this).route.name); } },
  name: { get(this: object) { return get(this).route.name; } },
  pathname: { get(this: object) { return get(this).pathname; } },
  params: { get(this: object) { return record(get(this).params); } },
  query: {
    get(this: object) {
      const m = get(this);
      const names = new Set(m.params.map(([k]) => k));
      const query: Param[] = [];
      for (const part of m.queryString.slice(1).split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const k = eq < 0 ? part : part.slice(0, eq);
        if (!names.has(k)) query.push([k, eq < 0 ? "" : part.slice(eq + 1)]);
      }
      return record([...m.params, ...query]);
    },
  },
  src: { get: src },
  scriptSrc: { get: src },
});

type Options = { style?: unknown; dir?: unknown; origin?: unknown; assetPrefix?: unknown; fileExtensions?: unknown };

export class FileSystemRouter {
  /** The routes' directory, absolute, without a trailing slash. */
  readonly dir: string;
  readonly #extensions: string[];
  readonly #origin: string | null;
  readonly #assetPrefix: string | null;
  #routes: Routes;
  #routesObject: Record<string, string> | undefined;

  constructor(options: Options) {
    if (typeof options !== "object" || options === null) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Expected object");
    if (options.style === undefined) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `Expected 'style' option (ex: "style": "nextjs")`);
    if (options.style !== "nextjs") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Only 'nextjs' style is currently implemented");
    const dir = typeof options.dir === "string" ? options.dir : "";
    this.dir = nodePath.resolve(process.cwd(), dir || ".");
    const exts = Array.isArray(options.fileExtensions) ? options.fileExtensions.filter((e): e is string => typeof e === "string" && e !== "").map((e) => e.slice(1)) : [];
    this.#extensions = exts.length ? exts : DEFAULT_EXTENSIONS;
    const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
    this.#origin = str(options.origin);
    this.#assetPrefix = str(options.assetPrefix);
    this.#routes = this.#load();
  }

  #load(): Routes {
    if (!fs.statSync(this.dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Unable to find directory: ${this.dir}`);
    return loadRoutes(this.dir === "/" ? "" : this.dir, this.#extensions);
  }

  get style() {
    return "nextjs";
  }
  get origin() {
    return this.#origin;
  }
  get assetPrefix() {
    return this.#assetPrefix;
  }
  get routes(): Record<string, string> {
    return (this.#routesObject ??= Object.fromEntries(this.#routes.list.map((r) => [r.name, r.filePath])));
  }

  match(input: unknown): object | null {
    let path: string;
    if (typeof input === "string") path = input;
    else if (input instanceof Request || input instanceof Response) path = input.url;
    else throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Expected string, Request or Response");
    if (path === "" || path === "/") path = "/";
    // A URL's path and query (Bun's URL parser keeps the query in `pathname`; the fragment goes).
    const url = /^(?:https?|file):\/\/[^/?#]*([^#]*)/.exec(path);
    if (url) path = url[1] || "/";
    if (!path.startsWith("/")) return null;
    const urlPath = parseUrlPath(path);
    const params: Param[] = [];
    const route = matchPage(this.#routes, urlPath.path, params);
    if (!route) return null;
    const m = Object.create(MatchedRoute) as object;
    matched.set(m, { route, pathname: urlPath.pathname, queryString: urlPath.query, params, router: this });
    return m;
  }

  reload() {
    this.#routes = this.#load();
    this.#routesObject = undefined;
    return this;
  }
}
