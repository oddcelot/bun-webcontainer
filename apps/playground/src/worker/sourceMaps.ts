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

function servedLocator(url: string): Locate | null {
  let l = locators.get(url);
  if (l !== undefined) return l;
  l = null;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.send();
    const text = xhr.status === 200 ? xhr.responseText : "";
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

/** Code run from a string with `//# sourceURL=<url>`: its body starts at line `offset`; `mappings` lead to the file. */
const evaluated = new Map<string, { offset: number; mappings?: string; locate?: Locate }>();

export function registerSource(url: string, offset: number, mappings?: string) {
  evaluated.set(url, { offset, mappings });
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

/**
 * A stack frame (`fn (url:line:column)` or `url:line:column`) with a served module's URL under `root` (or a `file:`
 * URL of code the worker evaluated) as its project path, and its line and column the source's where they are known.
 * Frames in the worker's own code (the runtime, its node: shims, the modules it serves for them) become "": Bun
 * doesn't show its internals either.
 */
export function frameMapper(root: () => string) {
  return (frame: string): string => {
    const m = /([a-z][\w+.-]*:\/\/[^\s()]+?):(\d+):(\d+)\)?$/.exec(frame);
    if (!m) return frame;
    const [, url, line, column] = m;
    const base = root();
    let path: string;
    let locate: Locate | null | undefined;
    if (url.startsWith(base)) {
      const rel = url.slice(base.length).replace(/[?#].*$/, "");
      if (/^__(node|host|bun)\//.test(rel)) return "";
      path = "/" + decode(rel.replace(/^__cjs\//, ""));
      locate = servedLocator(url);
    } else if ((locate = evaluatedLocator(url))) path = decode(new URL(url).pathname);
    else return url.startsWith(self.location.origin + "/") ? "" : frame;
    const pos = locate?.(+line - 1, +column - 1);
    if (pos) mapped.add(path);
    const location = pos ? `${path}:${pos[0] + 1}:${pos[1] + 1}` : `${path}:${line}:${column}`;
    return frame.slice(0, m.index) + location + frame.slice(m.index + url.length + line.length + column.length + 2);
  };
}

/** For the error printer's source preview: the file at `path` if frameMapper mapped its frames. */
export const previewSource = (read: (path: string) => string | undefined) => (path: string) => (mapped.has(path) ? read(path.slice(1)) : undefined);
