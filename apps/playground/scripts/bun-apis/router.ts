// Bun.FileSystemRouter over pages/: routes, match() of paths, Requests and query strings, reload().
import { rmSync } from "node:fs";

export async function router(log: (line: string) => void) {
  const root = import.meta.dir === "/" ? "" : import.meta.dir;
  /** Paths as the project has them, wherever it runs (the project is at the VFS root in the playground). */
  const rel = (s: unknown) => (typeof s === "string" ? s.replace(new RegExp(`(^|: )${RegExp.escape(root)}/(pages|nope)\\b`, "g"), "$1<root>/$2") : s);
  const show = (label: string, v: unknown) => log(`${label}: ${JSON.stringify(v, (_, x) => rel(x))}`);
  const t = (label: string, f: () => unknown) => {
    try {
      show(label, f());
    } catch (e) {
      const err = e as Error & { code?: string };
      log(`${label}: threw ${err.name} ${rel(err.message)}${err.code ? " " + err.code : ""}`);
    }
  };
  type M = ReturnType<Bun.FileSystemRouter["match"]>;
  const fields = (m: M) => m && { filePath: m.filePath, kind: m.kind, name: m.name, pathname: m.pathname, src: m.src, params: { ...m.params }, query: { ...m.query }, scriptSrc: m.scriptSrc };

  const r = new Bun.FileSystemRouter({ style: "nextjs", dir: `${root}/pages`, origin: "https://ex.com", assetPrefix: "_next/static/" });
  t("routes", () => r.routes);
  t("route order", () => Object.keys(r.routes));
  t("props", () => [r.style, r.origin, r.assetPrefix]);
  const paths = [
    "/", "/about", "/about/", "/blog", "/blog/hello", "/blog/new", "/blog/hello?x=1&y=2&x=3", "/docs/a/b/c", "/docs", "/shop", "/shop/a/b",
    "/api/42/info", "/settings/x?tab=q&a=1", "/nope", "/readme", "/_app", "/style", "about", "/blog/hello%20world", "https://other.com/blog/z?a=b",
    "/blog/hello#frag", "/index", "/blog/a?slug=zz", "/blog/x/", "/docs/a%2Fb", "/shop?x=", "/blog/x?a", "/blog/x?a=1&a=2&b", "/blog/index",
    "/api/7/info/", "/api/7", "/blog/caf%C3%A9", "/blog/x?a=b+c&d=%20e&f=1%262", "/blog/x?a=1?b=2", "/blog/x?slug=1&slug=2&z", "/Team", "/team", "/TEAM",
    "/blog/post.js.map", "/blog/x.map", "/x/1", "/x/1/2", "/x/fixed", "/x", "/.dot", "/.hidden/a", "/index/index", "/blog/index/", "///about",
    "/blog/a%2", "/blog/%E0%A4%A", "/blog/x?q=%zz", "file:///blog/f?x=1", "https://a.com/blog/h#frag?z=1", "/x/a?b=1#c", "",
  ];
  for (const p of paths) t(`match ${p}`, () => fields(r.match(p)));
  t("match Request", () => fields(r.match(new Request("http://localhost/blog/req?q=1"))));
  t("match Response", () => fields(r.match(new Response("x"))));
  t("match shape", () => {
    const m = r.match("/blog/x")!;
    return [m.constructor.name, Object.keys(m).length, Object.getPrototypeOf(m.params) === null, Object.getPrototypeOf(m.query) === null, m.query === r.match("/blog/x")!.query];
  });
  const r2 = new Bun.FileSystemRouter({ style: "nextjs", dir: "pages" });
  t("defaults", () => [r2.origin, r2.assetPrefix, r2.style]);
  t("defaults match", () => fields(r2.match("/blog/x?y=1")));
  for (const [origin, assetPrefix] of [["https://ex.com/base/", "/static"], ["https://ex.com", ""], ["http://h:8080/", "a/b/"], ["", "pre/"], ["nope", "x/"]])
    t(`src ${origin} ${assetPrefix}`, () => {
      const m = new Bun.FileSystemRouter({ style: "nextjs", dir: `${root}/pages`, origin, assetPrefix }).match("/docs/a")!;
      return [m.src, m.scriptSrc];
    });
  t("dir with slash", () => Object.keys(new Bun.FileSystemRouter({ style: "nextjs", dir: `${root}/pages/blog/` }).routes));
  t("dir dot", () => Object.keys(new Bun.FileSystemRouter({ style: "nextjs", dir: `${root}/pages/x/.` }).routes));
  t("no style", () => new Bun.FileSystemRouter({ dir: "pages" } as never));
  t("routes cached", () => r.routes === r.routes);
  t("fileExtensions",() => new Bun.FileSystemRouter({ style: "nextjs", dir: `${root}/pages`, fileExtensions: [".md"] }).routes);
  t("fileExtensions no dot", () => new Bun.FileSystemRouter({ style: "nextjs", dir: `${root}/pages`, fileExtensions: ["md", "css"] }).routes);
  t("bad style", () => new Bun.FileSystemRouter({ style: "x", dir: "pages" } as never));
  t("no dir", () => new Bun.FileSystemRouter({ style: "nextjs", dir: `${root}/nope` }));
  t("no options", () => new (Bun.FileSystemRouter as unknown as new () => unknown)());
  t("match no arg", () => (r.match as (x?: unknown) => M)());
  t("match number", () => (r.match as (x?: unknown) => M)(5));
  await Bun.write(`${root}/pages/added.ts`, "");
  t("before reload", () => fields(r2.match("/added")));
  t("reload returns", () => r2.reload() === r2);
  t("after reload", () => fields(r2.match("/added")));
  rmSync(`${root}/pages/added.ts`);
  r2.reload();
  t("after removal", () => fields(r2.match("/added")));
}
