// A service worker's synthesized responses can't set cookies, and the requests it intercepts don't show them. So the
// preview's cookies go through the page (runner.ts): written into the browser's store under the preview's path where
// the service worker can read them back (cookieStore), and kept here otherwise. HttpOnly ones always stay here, where
// the preview's scripts can't read them.

export type Cookie = { name: string; value: string; path: string; expires: number; httpOnly?: boolean };

/** RFC 6265 default-path: the request path up to its last "/". */
const defaultPath = (reqPath: string) => {
  const p = reqPath.split("?")[0];
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};

const pathMatches = (reqPath: string, cookiePath: string) => {
  const p = reqPath.split("?")[0] || "/";
  return p === cookiePath || (p.startsWith(cookiePath) && (cookiePath.endsWith("/") || p[cookiePath.length] === "/"));
};

/** One Set-Cookie header, answering a request to `reqPath`; undefined when it has no name. `expires` 0: delete it. */
export function parseSetCookie(reqPath: string, line: string): Cookie | undefined {
  const [pair, ...attrs] = line.split(";");
  const eq = pair.indexOf("=");
  if (eq < 0) return undefined;
  const c: Cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), path: defaultPath(reqPath), expires: Infinity };
  if (!c.name) return undefined;
  let maxAge: number | undefined;
  for (const a of attrs) {
    const i = a.indexOf("=");
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? "" : a.slice(i + 1).trim();
    if (k === "path" && v.startsWith("/")) c.path = v;
    else if (k === "max-age" && /^-?\d+$/.test(v)) maxAge = Number(v);
    else if (k === "expires" && !Number.isNaN(Date.parse(v))) c.expires = Date.parse(v);
    else if (k === "httponly") c.httpOnly = true;
  }
  // Max-Age wins over Expires.
  if (maxAge !== undefined) c.expires = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
  return c;
}

export class CookieJar {
  private cookies = new Map<string, Cookie>();

  /** Applies a response's Set-Cookie headers; `reqPath` is the path it answered. */
  store(reqPath: string, setCookies: string[]) {
    for (const line of setCookies) {
      const c = parseSetCookie(reqPath, line);
      if (c) this.put(c);
    }
  }

  /** Keeps a parsed cookie, or deletes it when it has expired. */
  put(c: Cookie) {
    const key = `${c.name}\0${c.path}`;
    if (c.expires <= Date.now()) this.cookies.delete(key);
    else this.cookies.set(key, c);
  }

  /** Forgets a cookie (one now kept in the browser's store instead). */
  drop(name: string, path: string) {
    this.cookies.delete(`${name}\0${path}`);
  }

  /** The cookies currently kept (expired ones dropped). */
  list(): Readonly<Cookie>[] {
    this.header("/");
    return [...this.cookies.values()];
  }

  clear() {
    this.cookies.clear();
  }

  /** The Cookie header for a request to `reqPath`, or undefined when no cookie applies. Longer paths go first. */
  header(reqPath: string): string | undefined {
    const now = Date.now();
    const out: Cookie[] = [];
    for (const [key, c] of this.cookies) {
      if (c.expires <= now) this.cookies.delete(key);
      else if (pathMatches(reqPath, c.path)) out.push(c);
    }
    if (!out.length) return undefined;
    return out
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
}
