// The preview's cookies in the browser, read and written by the page on the preview's origin: the editor's
// (runner.ts), or the content origin's host frame (host/main.ts). A service worker can't read cookies for a URL
// (cookieStore only answers for its own script's), so a hidden blank page does: sw.ts serves `<dir>/__runbun_cookies__`
// anywhere under a preview's base, and its document.cookie is what the browser holds for that directory, cookies
// with a narrower Path (`/admin`, set by a script on `/admin/x`) included.
//
// The base (`/__preview/@<client id>`) changes with every tab and reload, so cookies that outlive a tab (Expires,
// Max-Age) would stay in the browser unread. Each page holds a Web Lock for its base while it lives and records the
// base and the directories it read; a page sweeps the recorded bases nobody holds.

/** sw.ts serves it in any directory under a preview's base. */
export const COOKIE_PAGE = "__runbun_cookies__";

/** Directory pages kept loaded at once; the least recently read goes first. */
const MAX_PAGES = 8;
/** localStorage: `{ [base]: dirs[] }`, the bases this origin's pages had and the directories they read. */
const RECORD = "runbun-preview-cookie-bases";
const lockName = (base: string) => `runbun-preview:${base}`;

/** The directory of a request path (`/a/b?q` → `/a/`), where its page is. */
export const dirOf = (path: string) => {
  const p = path.split("?")[0] || "/";
  return p.slice(0, p.lastIndexOf("/") + 1) || "/";
};

/** The path of `dir`'s page, as cookie paths are matched (no base): `/a/__runbun_cookies__`. */
export const pagePath = (dir: string) => dir + COOKIE_PAGE;

function record(update: (r: Record<string, string[]>) => void) {
  try {
    const r = JSON.parse(localStorage.getItem(RECORD) ?? "{}") as Record<
      string,
      string[]
    >;
    update(r);
    localStorage.setItem(RECORD, JSON.stringify(r));
  } catch {}
}

/** A hidden same-origin frame at `url`, its document once loaded (undefined if it doesn't load). */
function loadPage(url: string): {
  frame: HTMLIFrameElement;
  doc: Promise<Document | undefined>;
} {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  const doc = new Promise<Document | undefined>((resolve) => {
    frame.onload = () => resolve(frame.contentDocument ?? undefined);
    frame.onerror = () => resolve(undefined);
  });
  frame.src = url;
  document.body.append(frame);
  return { frame, doc };
}

/** Expires every cookie a page shows, at each path from the base down to the page's directory (where it may be set). */
function expireAll(doc: Document, base: string, dir: string) {
  const names = new Set(
    doc.cookie
      .split("; ")
      .map((pair) => pair.split("=", 1)[0])
      .filter(Boolean),
  );
  // `/a/b/` → base, base/, base/a, base/a/, base/a/b, base/a/b/.
  const paths = [base, base + "/"];
  let at = "";
  for (const segment of dir.split("/").filter(Boolean))
    paths.push(base + (at += "/" + segment), base + at + "/");
  for (const name of names)
    for (const path of paths)
      doc.cookie = `${name}=; path=${path}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** The cookie pages of one preview base. */
export class PreviewCookies {
  private pages = new Map<
    string,
    { frame: HTMLIFrameElement; doc: Promise<Document | undefined> }
  >();
  private probe: Promise<boolean> | undefined;

  constructor(readonly base: string) {
    // Held until the page goes away: the base is in use, and recorded only then (so no page sweeps it before the lock
    // is held). Then the next page sweeps it. Without Web Locks nothing is recorded or swept.
    void navigator.locks
      ?.request(lockName(base), () => {
        record((r) => void (r[base] ??= []));
        return new Promise<never>(() => {});
      })
      .catch(() => {});
    void sweep(base);
  }

  private page(dir: string): Promise<Document | undefined> {
    let p = this.pages.get(dir);
    if (p) this.pages.delete(dir);
    else {
      p = loadPage(this.base + pagePath(dir));
      record((r) => {
        const dirs = r[this.base];
        if (dirs && !dirs.includes(dir)) dirs.push(dir);
      });
    }
    this.pages.set(dir, p);
    for (const [old, page] of this.pages) {
      if (this.pages.size <= MAX_PAGES) break;
      page.frame.remove();
      this.pages.delete(old);
    }
    return p.doc;
  }

  /** The browser's cookies for requests in `dir` (`a=1; b=2`). */
  async read(dir = "/"): Promise<string> {
    return (await this.page(dir))?.cookie ?? "";
  }

  /**
   * Whether the browser keeps the preview's cookies at all. It doesn't where this origin is a third party (an embed on
   * another site: its SameSite=Lax cookies are refused), and then the server's cookies can only live in the page's jar.
   */
  usable(): Promise<boolean> {
    return (this.probe ??= this.page("/").then((doc) => {
      if (!doc) return false;
      const path = `${this.base}/`;
      doc.cookie = `__runbun_probe=1; path=${path}; SameSite=Lax`;
      const ok = doc.cookie.includes("__runbun_probe=1");
      doc.cookie = `__runbun_probe=; path=${path}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      return ok;
    }));
  }

  /** `document.cookie` assignments (each names its path, so any of the base's pages takes them). */
  async write(lines: string[]) {
    const doc = await this.page("/");
    if (doc) for (const line of lines) doc.cookie = line;
  }
}

let swept = false;

/** Expires the cookies of recorded bases no page holds (but `own`), and forgets those bases. Once per page. */
async function sweep(own: string) {
  if (swept || !navigator.locks) return;
  swept = true;
  let held: Set<string>;
  try {
    const { held: h = [], pending = [] } = await navigator.locks.query();
    held = new Set([...h, ...pending].map((l) => l.name ?? ""));
  } catch {
    return;
  }
  let r: Record<string, string[]> = {};
  record((x) => void (r = { ...x }));
  for (const [base, dirs] of Object.entries(r)) {
    if (base === own || held.has(lockName(base))) continue;
    for (const dir of ["/", ...dirs.filter((d) => d !== "/")]) {
      const { frame, doc } = loadPage(base + pagePath(dir));
      const d = await doc;
      if (d) expireAll(d, base, dir);
      frame.remove();
    }
    record((x) => void delete x[base]);
  }
}
