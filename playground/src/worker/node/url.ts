import { codeError } from "./errors";
import path from "./path";

export function fileURLToPath(u: string | URL): string {
  const url = typeof u === "string" ? new URL(u) : u;
  if (!(url instanceof URL)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "path" argument must be of type string or an instance of URL.');
  if (url.protocol !== "file:") throw codeError(TypeError, "ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
  if (/%2f/i.test(url.pathname)) throw codeError(TypeError, "ERR_INVALID_FILE_URL_PATH", "File URL path must not include encoded / characters");
  return decodeURIComponent(url.pathname);
}

export function pathToFileURL(p: string): URL {
  let resolved = path.resolve(p);
  if (p.endsWith("/") && !resolved.endsWith("/")) resolved += "/";
  const url = new URL("file:///");
  url.pathname = resolved.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23");
  return url;
}

type Parsed = { protocol: string | null; slashes: boolean | null; auth: string | null; host: string | null; port: string | null; hostname: string | null; hash: string | null; search: string | null; query: string | Record<string, string | string[]> | null; pathname: string | null; path: string | null; href: string };

function parse(s: string, parseQuery = false): Parsed {
  let u: URL | undefined;
  try {
    u = new URL(s);
  } catch {}
  const [rest, hash = ""] = splitOnce(s, "#");
  const [before, search = ""] = splitOnce(rest, "?");
  const query = parseQuery ? Object.fromEntries(new URLSearchParams(search)) : search;
  if (!u) {
    return { protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null, hash: hash ? "#" + hash : null, search: search ? "?" + search : null, query: parseQuery ? query : search || null, pathname: before || null, path: before + (search ? "?" + search : "") || null, href: s };
  }
  const auth = u.username ? u.username + (u.password ? ":" + u.password : "") : null;
  return { protocol: u.protocol, slashes: /^[a-z][a-z0-9+.-]*:\/\//i.test(s), auth, host: u.host || null, port: u.port || null, hostname: u.hostname || null, hash: u.hash || null, search: u.search || null, query: parseQuery ? query : u.search ? u.search.slice(1) : null, pathname: u.pathname, path: u.pathname + u.search, href: u.href };
}

function splitOnce(s: string, sep: string): [string, string?] {
  const i = s.indexOf(sep);
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}

function format(o: string | URL | Partial<Parsed>): string {
  if (typeof o === "string") return o;
  if (o instanceof URL) return o.href;
  const host = o.host ?? (o.hostname ? o.hostname + (o.port ? ":" + o.port : "") : "");
  const proto = o.protocol ? (o.protocol.endsWith(":") ? o.protocol : o.protocol + ":") : "";
  const slashes = o.slashes || /^(https?|ftp|file|wss?):$/.test(proto) ? "//" : "";
  const search = o.search ?? (o.query && typeof o.query === "object" ? "?" + new URLSearchParams(o.query as Record<string, string>) : o.query ? "?" + o.query : "");
  const hash = o.hash ? (o.hash.startsWith("#") ? o.hash : "#" + o.hash) : "";
  const pathname = o.pathname ?? "";
  return `${proto}${slashes}${o.auth ? o.auth + "@" : ""}${host}${host && pathname && !pathname.startsWith("/") ? "/" : ""}${pathname}${search && !search.startsWith("?") ? "?" : ""}${search}${hash}`;
}

export default {
  URL,
  URLSearchParams,
  fileURLToPath,
  pathToFileURL,
  parse,
  format,
  resolve: (from: string, to: string) => new URL(to, new URL(from, "resolve://")).href.replace(/^resolve:\/\/\/?/, from.startsWith("/") ? "/" : ""),
  domainToASCII: (d: string) => new URL(`http://${d}`).hostname,
  domainToUnicode: (d: string) => d,
  urlToHttpOptions: (u: URL) => ({ protocol: u.protocol, hostname: u.hostname, hash: u.hash, search: u.search, pathname: u.pathname, path: u.pathname + u.search, href: u.href, port: u.port ? Number(u.port) : undefined }),
};
