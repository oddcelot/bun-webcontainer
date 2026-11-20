#!/usr/bin/env bun
// A shared project's own share card (worker/card.ts), end to end against the Worker in wrangler's local runtime
// (workerd, where Satori has to load as it does when deployed): makes short links from payloads packed as src/share.ts
// packs them and checks
//   (a) a project whose runbun.json has `card` gets a page with the card's tags, which opens the project from a script,
//   (b) its picture is a 1200x630 PNG, drawn once (the second request is the same bytes), with long-term caching,
//   (c) a project without `card` still gets the plain redirect, and its picture is the site's,
//   (d) `card` falls back to package.json's name, drops a bad accent with the rest of a malformed `card`,
//   (e) text of three bytes a character fits the link's metadata, a payload that inflates without end has no card,
//   (f) markup in a title is escaped in the page.
// It prints one ok/FAIL line per check and exits 1 if any failed. Local only: nothing is deployed or stored remotely.
//   bun scripts/worker-card.ts            (KEEP=<file.png> also writes the first card's picture there, to look at)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8798;
const ORIGIN = `http://localhost:${PORT}`;
const app = new URL("..", import.meta.url).pathname;

let failed = 0;
const report = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

/** A share payload, as src/share.ts packs a project. */
async function pack(files: Record<string, string>): Promise<string> {
  const packed = await new Response(new Blob([JSON.stringify({ v: 1, files })]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
  return Buffer.from(packed).toString("base64url");
}
async function link(files: Record<string, string> | string): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/short`, { method: "POST", headers: { origin: ORIGIN }, body: typeof files === "string" ? files : await pack(files) });
  const body = (await res.json()) as { id?: string; error?: string };
  if (!body.id) throw new Error(`no short link: ${res.status} ${body.error}`);
  return body.id;
}
const page = (id: string) => fetch(`${ORIGIN}/s/${id}`, { redirect: "manual" });
const picture = (id: string) => fetch(`${ORIGIN}/s/${id}/card.png`, { redirect: "manual" });
const config = (c: object) => JSON.stringify(c);

// The static site the Worker serves beside the API: only what these checks ask it for.
const dir = mkdtempSync(join(tmpdir(), "worker-card-"));
const site = join(dir, "site");
await Bun.write(join(site, "index.html"), "<!doctype html><title>site</title>\n");
await Bun.write(join(site, "og.png"), Bun.file(join(app, "public/og.png")));
const wrangler = Bun.spawn(["bunx", "wrangler", "dev", "--local", "--port", String(PORT), "--assets", site, "--persist-to", join(dir, "state")], { cwd: app, stdout: "pipe", stderr: "pipe" });
const log = { text: "" };
for (const stream of [wrangler.stdout, wrangler.stderr]) void (async () => { for await (const chunk of stream) log.text += new TextDecoder().decode(chunk); })();

try {
  const end = Date.now() + 60_000;
  while (!(await fetch(`${ORIGIN}/og.png`).then((r) => r.ok, () => false))) {
    if (Date.now() > end || wrangler.exitCode !== null) throw new Error(`the Worker didn't start:\n${log.text.slice(-2000)}`);
    await Bun.sleep(300);
  }

  // (a) the page of a link with a card.
  const carded = await link({
    "index.ts": "console.log('todo')",
    "package.json": config({ name: "todo-api", description: "from package.json" }),
    "runbun.json": `{ // a comment, as runbun.json may have\n "name": "Todo API with SQLite", "description": "A JSON API over bun:sqlite.", "tags": ["Bun.serve", "SQLite"], "card": { "accent": "#f472b6" } }`,
  });
  const res = await page(carded);
  const html = await res.text();
  const meta = (key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];
  report(
    "(a) a link with a card answers a page with its tags",
    res.status === 200 &&
      meta("og:title") === "Todo API with SQLite" &&
      meta("og:description") === "A JSON API over bun:sqlite." &&
      !!meta("og:image")?.endsWith(`/s/${carded}/card.png`) &&
      meta("twitter:card") === "summary_large_image" &&
      meta("og:image:alt") === "Todo API with SQLite. A JSON API over bun:sqlite. Bun.serve, SQLite" &&
      res.headers.get("x-robots-tag") === "noindex",
    `${res.status}; og:title ${JSON.stringify(meta("og:title"))}, og:image ${meta("og:image")}, alt ${JSON.stringify(meta("og:image:alt"))}`,
  );
  const opened = /location\.replace\("\/#code=([A-Za-z0-9_-]+)"\)/.exec(html)?.[1];
  report("(a) the page opens the project", opened === (await pack({ "index.ts": "console.log('todo')", "package.json": config({ name: "todo-api", description: "from package.json" }), "runbun.json": `{ // a comment, as runbun.json may have\n "name": "Todo API with SQLite", "description": "A JSON API over bun:sqlite.", "tags": ["Bun.serve", "SQLite"], "card": { "accent": "#f472b6" } }` })), opened ? `${opened.length} characters of payload` : "no redirect in the page");

  // (b) the picture.
  const started = Date.now();
  const first = await picture(carded);
  const png = new Uint8Array(await first.arrayBuffer());
  const took = Date.now() - started;
  const view = new DataView(png.buffer);
  const isPng = png.length > 24 && [0x89, 0x50, 0x4e, 0x47].every((b, i) => png[i] === b);
  report(
    "(b) its picture is a 1200x630 PNG, kept for good",
    first.status === 200 && first.headers.get("content-type") === "image/png" && isPng && view.getUint32(16) === 1200 && view.getUint32(20) === 630 && /immutable/.test(first.headers.get("cache-control") ?? ""),
    `${first.status} ${first.headers.get("content-type")}, ${isPng ? `${view.getUint32(16)}x${view.getUint32(20)}` : "not a PNG"}, ${png.length} bytes, drawn in ${took} ms`,
  );
  if (process.env.KEEP && isPng) writeFileSync(process.env.KEEP, png);
  const again = new Uint8Array(await (await picture(carded)).arrayBuffer());
  report("(b) the second request gets the same picture", again.length === png.length && again.every((b, i) => b === png[i]), `${again.length} bytes`);

  // (c) a project that doesn't ask.
  const plain = await link({ "index.ts": "console.log('plain')", "runbun.json": config({ name: "Plain" }) });
  const plainPage = await page(plain);
  const plainPicture = await picture(plain);
  report(
    "(c) a link without a card redirects as before, and its picture is the site's",
    plainPage.status === 302 && /\/#code=/.test(plainPage.headers.get("location") ?? "") && plainPicture.status === 302 && !!plainPicture.headers.get("location")?.endsWith("/og.png"),
    `page ${plainPage.status}, picture ${plainPicture.status} -> ${plainPicture.headers.get("location")}`,
  );

  // (d) defaults and a malformed card.
  const named = await link({ "package.json": config({ name: "from-package", description: "Its description." }), "runbun.json": config({ card: true }) });
  const namedHtml = await (await page(named)).text();
  report("(d) `card: true` takes package.json's name and description", namedHtml.includes('property="og:title" content="from-package"') && namedHtml.includes('property="og:description" content="Its description."'));
  const malformed = await link({ "index.ts": "1", "runbun.json": config({ name: "Bad accent", card: { accent: "red" } }) });
  report("(d) a malformed card is no card", (await page(malformed)).status === 302);
  const nameless = await link({ "index.ts": "2", "runbun.json": config({ card: true }) });
  report("(d) a card with nothing to call the project is no card", (await page(nameless)).status === 302);

  // (e) limits.
  const wide = await link({ "runbun.json": config({ name: "日本語のタイトル".repeat(12), description: "説明".repeat(120), tags: ["タグ".repeat(20), "二", "三", "四"], card: true }) });
  const wideRes = await page(wide);
  const widePicture = await picture(wide);
  report("(e) long text of three bytes a character still makes a link with a card", wideRes.status === 200 && [200, 302].includes(widePicture.status), `page ${wideRes.status}, picture ${widePicture.status}`);
  // 6 MB of one character deflates to a few kB: past what the Worker inflates.
  const bomb = await link(await pack({ "big.txt": "a".repeat(6 * 1024 * 1024), "runbun.json": config({ name: "Bomb", card: true }) }));
  report("(e) a payload that inflates past the limit has no card", (await page(bomb)).status === 302);

  // (f) escaping.
  const markup = await link({ "runbun.json": config({ name: `"><script>alert(1)</script>`, description: "a & b", card: true }) });
  const markupHtml = await (await page(markup)).text();
  report("(f) markup in a title is escaped", !markupHtml.includes("<script>alert(1)") && markupHtml.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;") && markupHtml.includes('content="a &amp; b"'));

  const errors = log.text.split("\n").filter((l) => /\bcard \w{10}:/.test(l));
  report("no card failed to draw", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  report("the checks ran", false, e instanceof Error ? e.message : String(e));
} finally {
  wrangler.kill();
  await wrangler.exited;
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
