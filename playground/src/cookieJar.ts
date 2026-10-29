// Preview servers can't use the browser's cookies: a service worker's synthesized responses can't set them, and the
// requests it intercepts don't carry them. So the page keeps them, like a browser would for the preview's host.

type Cookie = { name: string; value: string; path: string; expires: number };

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

export class CookieJar {
  private cookies = new Map<string, Cookie>();

  /** Applies a response's Set-Cookie headers; `reqPath` is the path it answered. */
  store(reqPath: string, setCookies: string[]) {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const c: Cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), path: defaultPath(reqPath), expires: Infinity };
      if (!c.name) continue;
      let maxAge: number | undefined;
      for (const a of attrs) {
        const i = a.indexOf("=");
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? "" : a.slice(i + 1).trim();
        if (k === "path" && v.startsWith("/")) c.path = v;
        else if (k === "max-age" && /^-?\d+$/.test(v)) maxAge = Number(v);
        else if (k === "expires" && !Number.isNaN(Date.parse(v))) c.expires = Date.parse(v);
      }
      // Max-Age wins over Expires.
      if (maxAge !== undefined) c.expires = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
      const key = `${c.name}\0${c.path}`;
      if (c.expires <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, c);
    }
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
