// Stack frames in the program's own lines, which V8 doesn't give `Error.stack` from source maps:
// - served ES modules and wrapped CommonJS carry an inline source map (moduleServer.ts). A frame's module is fetched
//   again (synchronously: errors print synchronously) the first time one of its frames is printed. Wrapped CommonJS
//   adds the wrapper's lines before the file's and, for TypeScript and JSX, the mappings of a first transpile.
// - code the worker runs with `new Function` (CommonJS it requires, ES modules it runs itself: node/module.ts) is
//   registered with its mappings and the lines V8 puts before a function's body.
import { decodeMappings, originalPosition, type Mappings } from "../sourceMap";

const MAP_PREFIX = "\n//# sourceMappingURL=data:application/json;base64,";

/** A generated 0-based [line, column] to the file's, or undefined where it isn't the file's. */
type Locate = (line: number, column: number) => [number, number] | undefined;

/**
 * `outer` maps generated positions to an intermediate text whose line `offset` is the first line of the code `inner`
 * maps to the file (either map may be missing: positions stay as they are).
 */
function locator(outer: Mappings | null, offset: number, inner: Mappings | null): Locate {
  return (line, column) => {
    const p = outer ? originalPosition(outer, line, column) : ([line, column] as [number, number]);
    if (!p || p[0] < offset) return undefined;
    return inner ? originalPosition(inner, p[0] - offset, p[1]) : [p[0] - offset, p[1]];
  };
}

const locators = new Map<string, Locate | null>();
/** Served URLs that are a CommonJS file's facade (cjs.ts commonJSFacade): the module ES importers get, not the file. */
const facades = new Set<string>();

function servedLocator(url: string): Locate | null {
  let l = locators.get(url);
  if (l !== undefined) return l;
  l = null;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.send();
    const text = xhr.status === 200 ? xhr.responseText : "";
    if (text.startsWith("import * as __body from ")) facades.add(url);
    const at = text.lastIndexOf(MAP_PREFIX);
    if (at >= 0) {
      const map = JSON.parse(atob(text.slice(at + MAP_PREFIX.length).trim())) as { mappings: string; x_bwcLineOffset?: number; x_bwcInner?: string };
      l = locator(decodeMappings(map.mappings), map.x_bwcLineOffset ?? 0, map.x_bwcInner === undefined ? null : decodeMappings(map.x_bwcInner));
    }
  } catch {}
  locators.set(url, l);
  return l;
}

/** The lines V8 puts before the body of a `new Function(...)` (`(function anonymous(params` and `) {`). */
export const FUNCTION_HEADER_LINES = 2;

/**
 * Code run from a string with `//# sourceURL=<url>`: its body starts at line `offset`; `mappings` lead to the file.
 * `commonJS`: the body is a CommonJS module's function (Bun names its frames `<anonymous>`), else an ES module's.
 */
const evaluated = new Map<string, { offset: number; mappings?: string; commonJS: boolean; locate?: Locate }>();

export function registerSource(url: string, offset: number, mappings: string | undefined, commonJS: boolean) {
  evaluated.set(url, { offset, mappings, commonJS });
}

function evaluatedLocator(url: string): Locate | undefined {
  const e = evaluated.get(url);
  if (!e) return undefined;
  return (e.locate ??= locator(null, e.offset, e.mappings === undefined ? null : decodeMappings(e.mappings)));
}

/** Paths whose frames frameMapper mapped: their lines are the file's. */
const mapped = new Set<string>();

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Where a generated position is in the project: its path, and its 1-based line and column (the file's if `mapped`). */
interface Location {
  path: string;
  line: number;
  column: number;
  mapped: boolean;
}

/**
 * A served module's URL under `root` (or a `file:` URL of code the worker evaluated) as its project path, with the
 * source's line and column where they are known. "" for the worker's own code (the runtime, its node: shims, the
 * modules it serves for them, CommonJS facades): Bun doesn't show its internals either. null for any other URL.
 */
export function mapLocation(root: string, url: string, line: number, column: number): Location | "" | null {
  let path: string;
  let locate: Locate | null | undefined;
  if (url.startsWith(root)) {
    const rel = url.slice(root.length).replace(/[?#].*$/, "");
    if (/^__(node|host|bun)\//.test(rel)) return "";
    path = "/" + decode(rel.replace(/^__(cjs|entry)\//, ""));
    locate = servedLocator(url);
    if (facades.has(url)) return "";
  } else if ((locate = evaluatedLocator(url))) path = decode(new URL(url).pathname);
  else return url.startsWith(self.location.origin + "/") ? "" : null;
  const pos = locate?.(line - 1, column - 1);
  if (pos) mapped.add(path);
  return pos ? { path, line: pos[0] + 1, column: pos[1] + 1, mapped: true } : { path, line, column, mapped: false };
}

/**
 * A stack frame (`fn (url:line:column)` or `url:line:column`) with its location as mapLocation has it ("" for a frame
 * to hide). For stacks V8 didn't format with installStackTraces (other engines; a program's own prepareStackTrace).
 */
export function frameMapper(root: () => string) {
  return (frame: string): string => {
    const m = /([a-z][\w+.-]*:\/\/[^\s()]+?):(\d+):(\d+)\)?$/.exec(frame);
    if (!m) return frame;
    const [, url, line, column] = m;
    const l = mapLocation(root(), url, +line, +column);
    if (!l) return l ?? frame;
    return frame.slice(0, m.index) + `${l.path}:${l.line}:${l.column}` + frame.slice(m.index + url.length + line.length + column.length + 2);
  };
}

/** V8's CallSite (the parts used here). */
export interface CallSite {
  getFileName(): string | null | undefined;
  getScriptNameOrSourceURL?(): string | null | undefined;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  getEnclosingLineNumber?(): number | null;
  getEnclosingColumnNumber?(): number | null;
  getFunctionName(): string | null;
  isConstructor(): boolean;
  isAsync(): boolean;
}

/** Wrapped CommonJS's own functions around a file's body (cjs.ts wrapCommonJS). */
export const CJS_WRAPPER = new Set(["__run", "__cjsModule", "require"]);

/**
 * `Error.prepareStackTrace` as Bun has one (`ErrorPrepareStackTrace`), so `error.stack` reads as in Bun: frames in the
 * project's paths with the files' lines and columns, the worker's own frames left out, and JSC's names: a function's
 * own name (`bar` where V8 says `Foo.bar`; `<anonymous>` for one V8 names after what it was assigned to, `o.fail`),
 * nothing for an ES module's top level and `<anonymous>` for a CommonJS module's, `async fn` for an async function
 * awaiting the one below (but no frame for a module's top-level await). Only V8 has the hook: other engines keep their stacks, which frameMapper maps when printed.
 */
export function installStackTraces(root: () => string, read: (path: string) => string | undefined) {
  function frame(site: CallSite, first: boolean): string {
    const file = site.getFileName();
    const name = site.getFunctionName();
    if (!file) return `${name || "<anonymous>"} (native)`;
    const url = file;
    const evaluatedTop = evaluated.get(url);
    const l = mapLocation(root(), url, site.getLineNumber() ?? 0, site.getColumnNumber() ?? 0);
    if (l === "") return "";
    if (l === null) return `${name ? `${name} (` : ""}${url}:${site.getLineNumber()}:${site.getColumnNumber()}${name ? ")" : ""}`;
    // (`require` only where it is the wrapper's, before the body: a file may define its own.)
    if (url.startsWith(root() + "__cjs/") && name && CJS_WRAPPER.has(name) && (name !== "require" || !l.mapped)) return "";
    // V8 puts an error made with `new X()` at `new`, and a function awaiting at `await`; JSC at what follows.
    let column = l.column;
    const keyword = first ? /^new\s+/ : site.isAsync() ? /^await\s+/ : undefined;
    if (keyword && l.mapped) {
      const text = read(l.path.slice(1))?.split("\n")[l.line - 1];
      const m = text && keyword.exec(text.slice(column - 1));
      if (m) column += m[0].length;
    }
    const location = `${l.path}:${l.line}:${column}`;
    // The module's own body: the function V8 wraps evaluated code in, or a served module's top level.
    const enclosing = [site.getEnclosingLineNumber?.(), site.getEnclosingColumnNumber?.()];
    const top = evaluatedTop ? enclosing[0] === 1 : !name && enclosing[0] === 1 && enclosing[1] === 1;
    if (top) return site.isAsync() ? "" : evaluatedTop?.commonJS ? `<anonymous> (${location})` : location;
    let fn = name && (!name.includes(".") || name.startsWith("[")) ? name : "<anonymous>";
    if (site.isConstructor()) fn = `new ${fn}`;
    else if (site.isAsync()) fn = `async ${fn}`;
    return `${fn} (${location})`;
  }
  function ErrorPrepareStackTrace(error: unknown, sites: CallSite[]): string {
    let head: string;
    try {
      head = Error.prototype.toString.call(error);
    } catch {
      head = "<error>";
    }
    const frames = sites.map((s, i) => frame(s, i === 0)).filter((f) => f);
    return [head, ...frames.map((f) => `    at ${f}`)].join("\n");
  }
  Object.defineProperty(Error, "prepareStackTrace", { value: ErrorPrepareStackTrace, writable: true, enumerable: false, configurable: true });
}

/** For the error printer's source preview: the file at `path` if frameMapper mapped its frames. */
export const previewSource = (read: (path: string) => string | undefined) => (path: string) => (mapped.has(path) ? read(path.slice(1)) : undefined);
