#!/usr/bin/env bun
// The preview's cookies end to end (src/previewCookies.ts, runner.ts withCookies, the host frame's on a content
// origin): a project's server echoes the Cookie header it gets, and a page in the preview (a frame under the preview's
// base, as the preview's own pages are) sets, changes and deletes cookies as a script would. Then the embed reloads,
// which gives the preview a new base: a persistent cookie the old one had must be gone from the browser.
//   bun scripts/cookies.ts [--content-origin [--third-party]]
// --content-origin: project code on its own origin (run.runbun.localhost), as on runbun.dev (src/contentOrigin.ts),
// in a page of the same site. --third-party: in a page of another site, as an embed elsewhere is: the browser refuses
// the content origin's cookies there, so only the server's reach it (from the page's jar), not a script's.
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Frame } from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5194;
const HOST_PORT = 5193;
const CONTENT = process.argv.includes("--content-origin");
const THIRD_PARTY = CONTENT && process.argv.includes("--third-party");
const HOST = `http://${CONTENT && !THIRD_PARTY ? "runbun." : ""}localhost:${HOST_PORT}`;
const EDITOR = `http://${CONTENT ? "runbun." : ""}localhost:${PORT}`;
const PREVIEW_ORIGIN = CONTENT ? `http://run.runbun.localhost:${PORT}` : EDITOR;

const files = {
  "index.ts": `Bun.serve({
  port: 3000,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/set") return new Response("set", { headers: { "set-cookie": "s=1; Path=/admin" } });
    if (path === "/keep") return new Response("kept", { headers: { "set-cookie": "keep=1; Max-Age=3600" } });
    if (path.endsWith("/page")) return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
    return new Response(req.headers.get("cookie") ?? "");
  },
});
console.log("listening");
`,
};

const chrome =
  process.env.CHROME ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const vite = Bun.spawn(
  ["bunx", "vite", "--port", String(PORT), "--strictPort"],
  {
    cwd: app,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      VITE_CACHE_DIR: join(app, "node_modules/.vite-cookies"),
      ...(CONTENT && {
        VITE_CONTENT_ORIGIN: PREVIEW_ORIGIN,
        VITE_EDITOR_ORIGINS: EDITOR,
      }),
    },
  },
);
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=preview"></iframe>
<script>
  window.lines = []; window.events = [];
  const files = ${JSON.stringify(files)};
  let id = 0; const pending = new Map();
  window.rpc = (method, params) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    f.contentWindow.postMessage({ bunPlayground: 1, id: i, method, params }, "${EDITOR}");
  });
  addEventListener("message", (e) => {
    const d = e.data;
    if (d?.bunPlayground !== 1) return;
    if (typeof d.id === "number" && !d.event) { const p = pending.get(d.id); pending.delete(d.id); d.error !== undefined ? p.reject(new Error(d.error)) : p.resolve(d.result); return; }
    window.events.push(d.event);
    if (d.event === "boot") window.rpc("init", { files });
    if (d.event === "console") window.lines.push(...d.data.text.split("\\n"));
  });
</script>`,
      { headers: { "content-type": "text/html" } },
    ),
});

type Win = {
  lines: string[];
  events: string[];
  rpc(m: string, p?: unknown): Promise<unknown>;
};
let bad = 0;
const check = (label: string, got: string, want: string) => {
  if (got === want) console.log(`✓ ${label}`);
  else
    (bad++,
      console.error(
        `✗ ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`,
      ));
};

/** In the preview frame: the server's answer to `path` under the preview's base. */
const get = (pf: Frame, path: string) =>
  pf.evaluate((p: string) => {
    const base = location.pathname.match(/^.*?\/__preview\/@[^/]+/)![0];
    return fetch(base + p).then((r) => r.text());
  }, path);

/** In a page at `dir/page` under the preview's base: `document.cookie = assign`, as the page's script would. */
const script = (pf: Frame, dir: string, assign: string) =>
  pf.evaluate(
    (d: string, a: string) =>
      new Promise<void>((resolve) => {
        const base = location.pathname.match(/^.*?\/__preview\/@[^/]+/)![0];
        const frame = document.createElement("iframe");
        frame.onload = () => {
          frame.contentDocument!.cookie = a;
          frame.remove();
          resolve();
        };
        frame.src = base + d + "page";
        document.body.append(frame);
      }),
    dir,
    assign,
  );

/** In the preview frame: the browser's cookies for `dir` under preview base `base`, as a page there sees them. */
const browserCookies = (pf: Frame, base: string, dir: string) =>
  pf.evaluate(
    (b: string, d: string) =>
      new Promise<string>((resolve) => {
        const frame = document.createElement("iframe");
        frame.onload = () => {
          const c = frame.contentDocument!.cookie;
          frame.remove();
          resolve(c);
        };
        frame.src = b + d + "__runbun_cookies__";
        document.body.append(frame);
      }),
    base,
    dir,
  );

const profile = mkdtempSync(join(tmpdir(), "cookies-"));
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  for (let i = 0; ; i++) {
    if (
      await fetch(`http://localhost:${PORT}/`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (i > 150)
      throw new Error(
        `the dev server didn't come up:\n${await new Response(vite.stderr).text()}`,
      );
    await Bun.sleep(200);
  }
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profile,
  });
  const page = await browser.newPage();
  const crashes: string[] = [];
  page.on("pageerror", (e) =>
    crashes.push(e instanceof Error ? e.message : String(e)),
  );

  /** Loads the embed (again), runs the server, and gives the preview's frame and base. */
  const start = async (): Promise<[Frame, string]> => {
    await page.goto(`${HOST}/`);
    await page.waitForFunction(
      () => (window as unknown as Win).events.includes("ready"),
      { timeout: 60_000 },
    );
    await page.evaluate(() =>
      (window as unknown as Win).rpc("run", { entry: "index.ts" }),
    );
    await page.waitForFunction(
      () => (window as unknown as Win).lines.includes("listening"),
      { timeout: 30_000 },
    );
    let pf: Frame | undefined;
    for (let i = 0; i < 100 && !pf; i++) {
      pf = page
        .frames()
        .find(
          (f) =>
            f.url().startsWith(PREVIEW_ORIGIN + "/") &&
            f.url().includes("/__preview/@"),
        );
      if (!pf) await Bun.sleep(100);
    }
    if (!pf) throw new Error("no preview frame");
    return [
      pf,
      new URL(pf.url()).pathname.match(/^.*?\/__preview\/@[^/]+/)![0],
    ];
  };

  // What the server gets after each step; a third party's scripts can't set cookies, its server's still work.
  const want = THIRD_PARTY
    ? ["", "", "s=1", "s=1", "s=1"]
    : ["a=1", "", "a=1; s=1", "a=1; s=2", "a=1"];
  const [pf, base] = await start();
  // A script on /admin/page sets a cookie: its default path is /admin, which the preview's root can't see.
  await script(pf, "/admin/", "a=1");
  check(
    "a script's cookie with a narrower path reaches the server",
    await get(pf, "/admin/echo"),
    want[0],
  );
  check("... and only under it", await get(pf, "/echo"), want[1]);
  // The server sets one for /admin; a script there changes it, then deletes it.
  await get(pf, "/set");
  check("a server's cookie for /admin", await get(pf, "/admin/echo"), want[2]);
  await script(pf, "/admin/", "s=2");
  check("a script's change to it", await get(pf, "/admin/echo"), want[3]);
  await script(pf, "/admin/", "s=; expires=Thu, 01 Jan 1970 00:00:00 GMT");
  check("a script's deletion of it", await get(pf, "/admin/echo"), want[4]);
  // A persistent cookie, then a reload: the preview gets a new base, and the old one's cookies are swept.
  await get(pf, "/keep");
  check("a persistent cookie", await get(pf, "/echo"), "keep=1");
  if (THIRD_PARTY) {
    // Nothing in the browser to sweep.
    for (const c of crashes) (bad++, console.error(`✗ page error: ${c}`));
    throw "done";
  }
  const [pf2, base2] = await start();
  check("the reload has a new base", String(base2 !== base), "true");
  await get(pf2, "/echo");
  // The sweep runs when the new page first reads cookies; give its frames a moment.
  let left = "";
  for (let i = 0; i < 30; i++) {
    left = await browserCookies(pf2, base, "/admin/");
    if (!left) break;
    await Bun.sleep(100);
  }
  check("the old base's cookies are swept", left, "");
  for (const c of crashes) (bad++, console.error(`✗ page error: ${c}`));
} catch (e) {
  if (e !== "done") throw e;
} finally {
  await browser?.close();
  host.stop(true);
  vite.kill();
  rmSync(profile, { recursive: true, force: true });
}
if (bad) process.exit(1);
