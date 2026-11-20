#!/usr/bin/env bun
// A self-hosted copy that makes the playground its own (hosting/README.md): the release archive, unpacked elsewhere and
// configured by its own configure.ts under node as a "Solid Playground" with three of the examples, one of them opened
// by default and no landing page, then opened in headless Chrome on a fresh profile. `/` must open straight into the
// playground, under the new name, with the default project running, and the gallery must list only those three. It has
// no runbun.dev Worker (no `worker` in the hosting file): no Feedback button, no short links, no request to /api/, /s/
// or /git-proxy/.
//   bun scripts/check-hosting.ts [archive.tar.gz]     default: this version's, from playground:release-archive
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5199;
const { version } = await Bun.file(join(app, "../../package.json")).json();
const archive = process.argv[2] ?? join(app, `dist-release/runbun-playground-${version}.tar.gz`);
if (!existsSync(archive)) {
  console.error(`no ${archive}: moon run playground:release-archive`);
  process.exit(1);
}
const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const gallery = ["solid-vite-hmr", "solid-ssr-dashboard", "astro-solid-demo", "reactivescript", "reactivescript-selects"];
// Its own brand too: a logo next to the hosting file, the Solid theme for a first visit, no Local Bun switch.
const hosting = { name: "Solid Playground", brand: { logo: "solid.svg", home: "https://www.solidjs.com/" }, theme: { family: "solid-light" }, localRunner: false, gallery, defaultProject: gallery[0], landing: false, editorOrigins: [`http://localhost:${PORT}`] };
/** An example's card name, as src/examples.ts reads it: runbun.json's over example.json's. */
const nameOf = (folder: string) => {
  const read = (f: string) => (existsSync(join(app, "examples", folder, f)) ? (Bun.JSONC.parse(readFileSync(join(app, "examples", folder, f), "utf8")) as { name?: string }).name : undefined);
  return read("runbun.json") ?? read("example.json");
};
const want = gallery.map(nameOf);

const problems: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "check-hosting-"));
const profile = join(dir, "profile");
let server: Bun.Subprocess | undefined;
try {
  if (Bun.spawnSync(["tar", "-xzf", archive, "-C", dir]).exitCode) throw new Error(`can't unpack ${archive}`);
  const root = join(dir, readdirSync(dir).find((d) => d.startsWith("runbun-playground-"))!);
  await Bun.write(join(dir, "hosting.json"), JSON.stringify(hosting));
  await Bun.write(join(dir, "solid.svg"), Bun.file(join(app, "hosting/brand/solid.svg")));
  const configured = Bun.spawnSync(["node", "configure.ts", "dist", join(dir, "hosting.json")], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (configured.exitCode) throw new Error("configure.ts failed");

  server = Bun.spawn(["bunx", "vite", "preview", "--outDir", join(root, "dist"), "--port", String(PORT), "--strictPort"], { cwd: app, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; !(await fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false)); i++) {
    if (i > 100) throw new Error("vite preview didn't come up");
    await Bun.sleep(200);
  }

  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
  try {
    const page = await browser.newPage();
    const crashes: string[] = [];
    page.on("pageerror", (e) => crashes.push(e instanceof Error ? e.message : String(e)));
    const workerCalls: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.port === String(PORT) && /^\/(api|s|git-proxy)\//.test(u.pathname)) workerCalls.push(u.pathname);
    });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
    const view = await page.evaluate(() => document.documentElement.dataset.view);
    if (view !== "app") problems.push(`a first visit to / shows the landing page (data-view=${view})`);

    // The default project runs: the status settles on Running.
    let status = "";
    for (const end = Date.now() + 90_000; Date.now() < end && !/^Running/.test(status); await Bun.sleep(250))
      status = await page.evaluate(() => document.querySelector("#status")?.textContent?.trim() ?? "").catch(() => "");
    if (!/^Running/.test(status)) problems.push(`the default project didn't start: status "${status}"`);
    const picked = await page.evaluate(() => document.querySelector("#example .name")?.textContent?.trim() ?? "");
    if (picked !== want[0]) problems.push(`the project picker shows "${picked}", not the default project "${want[0]}"`);
    const title = await page.title();
    if (title !== "Solid Playground") problems.push(`the tab title is "${title}"`);
    // The brand: its logo and name in the header (a link to its home), its logo as the page's icon, its theme, and
    // none of runbun's own: the dumpling, the Local Bun switch.
    const brand = await page.evaluate(() => ({
      name: document.querySelector("header #title")?.textContent?.trim(),
      logo: document.querySelector<HTMLImageElement>("header .title a[href='https://www.solidjs.com/'] img.brand-logo")?.naturalWidth ?? 0,
      dumpling: !!document.querySelector("header .logo"),
      localBun: !!document.querySelector("#local-bun"),
      icons: [...document.querySelectorAll<HTMLLinkElement>("link[rel~=icon]")].map((l) => l.href.slice(0, 19)),
      canvas: getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
      poweredBy: [...document.querySelectorAll("footer a")].some((a) => a.textContent?.trim() === "Powered by runbun"),
    }));
    if (brand.name !== "Solid Playground" || !brand.logo || brand.dumpling) problems.push(`the header's brand: ${JSON.stringify(brand)}`);
    if (brand.localBun) problems.push("the header has the Local Bun switch");
    if (brand.icons.join() !== "data:image/svg+xml;") problems.push(`the page's icons: ${brand.icons.join(", ")}`);
    if (!["#eef2f7", "#020e1e"].includes(brand.canvas)) problems.push(`a first visit isn't in the Solid theme (--canvas: ${brand.canvas})`);
    if (!brand.poweredBy) problems.push("the status bar doesn't say Powered by runbun");

    // The gallery: every card in every section.
    await page.click("#example");
    await page.waitForSelector(".gallery-card");
    const cards = new Set<string>();
    const tabs = await page.$$(".gallery [role=tab]");
    for (const tab of tabs.length ? tabs : [null]) {
      await tab?.click();
      for (const n of await page.$$eval(".gallery-card .name", (els) => els.map((e) => e.firstChild?.textContent?.trim() ?? ""))) cards.add(n);
    }
    if ([...cards].sort().join() !== [...want].sort().join()) problems.push(`the gallery lists ${JSON.stringify([...cards])}, expected ${JSON.stringify(want)}`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".gallery"));

    // Without the Worker: no Feedback button, no short link in the share menu.
    const feedback = await page.$$eval("footer button, footer a", (els) => els.some((e) => e.textContent?.trim() === "Feedback"));
    if (feedback) problems.push("the status bar has a Feedback button");
    // An edited project, so Share needs a real link (an unchanged example's ?example= is short already).
    // Only once the editor has the focus: typed into the picker button, the newline would reopen the gallery.
    for (let i = 0; i < 20 && !(await page.evaluate(() => !!document.activeElement?.closest("#editor"))); i++) {
      await page.click("#editor");
      await Bun.sleep(100);
    }
    await page.keyboard.type("// edited\n");
    await Bun.sleep(500);
    await page.click("#share");
    await page.waitForFunction(() => [...document.querySelectorAll("#share-menu *")].some((e) => e.textContent?.trim() === "Copy link"), { timeout: 15_000 }).catch(async (e) => {
      const state = await page.evaluate(() => ({
        gallery: !!document.querySelector(".gallery"),
        menuOpen: document.querySelector("#share-menu")?.matches(":popover-open"),
        menu: document.querySelector("#share-menu")?.textContent?.slice(0, 200),
        active: document.activeElement?.outerHTML.slice(0, 120),
      }));
      throw new Error(`${e.message} ${JSON.stringify(state)}`);
    });
    const short = await page.$$eval("#share-menu *", (els) => els.some((e) => e.textContent?.includes("Copy short link") && e.checkVisibility()));
    if (short) problems.push("the share menu offers a short link");
    if (workerCalls.length) problems.push(`requests to runbun.dev's Worker routes: ${[...new Set(workerCalls)].join(", ")}`);
    if (crashes.length) problems.push(`page errors: ${crashes.join("; ")}`);
    await page.close();
  } finally {
    await browser.close();
  }
} catch (e) {
  problems.push((e as Error).message);
} finally {
  server?.kill();
  await server?.exited;
  rmSync(dir, { recursive: true, force: true });
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`✓ "${hosting.name}": its brand, no landing page, ${want[0]} running, ${want.length} projects in the gallery, no Worker features`);
