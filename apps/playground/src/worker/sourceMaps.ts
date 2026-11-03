// Stack frames in the program's own lines: served ES modules carry an inline source map (moduleServer.ts), which V8
// doesn't apply to `Error.stack`. A frame's module is fetched again (synchronously: errors print synchronously) the
// first time one of its frames is printed.
import { decodeMappings, originalPosition, type Mappings } from "../sourceMap";

const MAP_PREFIX = "\n//# sourceMappingURL=data:application/json;base64,";
const maps = new Map<string, Mappings | null>();

function mappingsOf(url: string): Mappings | null {
  let m = maps.get(url);
  if (m !== undefined) return m;
  m = null;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.send();
    const text = xhr.status === 200 ? xhr.responseText : "";
    const at = text.lastIndexOf(MAP_PREFIX);
    if (at >= 0) m = decodeMappings((JSON.parse(atob(text.slice(at + MAP_PREFIX.length).trim())) as { mappings: string }).mappings);
  } catch {}
  maps.set(url, m);
  return m;
}

/** Paths whose frames frameMapper mapped with a source map: their lines are the file's. */
const mapped = new Set<string>();

/**
 * A stack frame (`fn (url:line:column)` or `url:line:column`) with a served module's URL under `root` as its project
 * path, and its line and column the source's where the module has a source map. Frames in the worker's own code
 * (the runtime, its node: shims, the modules it serves for them) become "": Bun doesn't show its internals either.
 */
export function frameMapper(root: () => string) {
  return (frame: string): string => {
    const m = /([a-z][\w+.-]*:\/\/[^\s()]+?):(\d+):(\d+)\)?$/.exec(frame);
    if (!m) return frame;
    const [, url, line, column] = m;
    const base = root();
    if (!url.startsWith(base)) return url.startsWith(self.location.origin + "/") ? "" : frame;
    const rel = url.slice(base.length).replace(/[?#].*$/, "");
    if (/^__(node|host|bun)\//.test(rel)) return "";
    let path = "/" + rel;
    try {
      path = "/" + decodeURIComponent(rel);
    } catch {}
    const map = mappingsOf(url);
    const pos = map && originalPosition(map, +line - 1, +column - 1);
    if (pos) mapped.add(path);
    const location = pos ? `${path}:${pos[0] + 1}:${pos[1] + 1}` : `${path}:${line}:${column}`;
    return frame.slice(0, m.index) + location + frame.slice(m.index + url.length + line.length + column.length + 2);
  };
}

/** For the error printer's source preview: the file at `path` if frameMapper mapped its frames. */
export const previewSource = (read: (path: string) => string | undefined) => (path: string) => (mapped.has(path) ? read(path.slice(1)) : undefined);
