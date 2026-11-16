#!/usr/bin/env bun
// S3 in the browser (src/worker/s3.ts: Bun.S3Client, Bun.s3, S3 files, s3:// URLs, presign), end to end: a project runs in
// the embed in headless Chrome against a local S3 with CORS (scripts/s3/mock.ts, which checks every SigV4 signature
// itself) and prints what each operation gave. The expected lines are what native Bun prints for the same project
// against the same server; the requests the server saw are compared too (method, path, query, the headers a client
// sets, the signed header names), so the browser's multipart upload, ranges and presigned URLs are the same as Bun's.
//   bun scripts/s3.ts [--no-native]
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";
import { ACCESS_KEY, SECRET_KEY, startMock, type Recorded } from "./s3/mock";

const app = join(import.meta.dir, "..");
const PORT = 5350;
const HOST_PORT = 5351;
const EDITOR = `http://localhost:${PORT}`;

const mock = startMock(0);
const endpoint = mock.url;
const env = { S3_ACCESS_KEY_ID: ACCESS_KEY, S3_SECRET_ACCESS_KEY: SECRET_KEY, S3_BUCKET: "envb", S3_ENDPOINT: endpoint, S3_REGION: "us-east-1" };

const files: Record<string, string> = {
  "runbun.json": JSON.stringify({ env }),
  "main.ts": `
const log = console.log;
const show = async (label: string, f: () => unknown) => {
  try {
    const v = await f();
    log(label, typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    const x = e as Error & { code?: string; path?: string };
    log(label, "ERR", x.name, x.code, x.message, x.path);
  }
};
const mask = (u: string) => u.replace(/X-Amz-Date=[^&]+|X-Amz-Signature=[^&]+/g, (m) => m.split("=")[0] + "=X");
const c = new Bun.S3Client({ accessKeyId: ${JSON.stringify(ACCESS_KEY)}, secretAccessKey: ${JSON.stringify(SECRET_KEY)}, bucket: "b", endpoint: ${JSON.stringify(endpoint)}, region: "us-east-1" });
const chunk = (n: number, size: number) => new Response(new ReadableStream({ start(k) { for (let i = 0; i < n; i++) k.enqueue(new Uint8Array(size).fill(i + 1)); k.close(); } }));

void (async () => {
  await show("write string", () => c.write("hello.txt", "hello world"));
  await show("write bytes", () => c.write("bin/data.bin", new Uint8Array([1, 2, 3, 4])));
  await show("write json", () => c.write("data.json", JSON.stringify({ a: [1, 2] }), { type: "application/json" }));
  await show("write blob", () => c.write("blob.txt", new Blob(["from a blob"])));
  await show("write response", () => c.write("resp.txt", new Response("from a response")));
  await show("write unicode key", () => c.write("dir/ü ö !*'()~.txt", "unicode"));
  await show("write options", () => c.write("opts.txt", "o", { acl: "public-read", storageClass: "STANDARD_IA", contentDisposition: "attachment", contentEncoding: "identity", type: "text/zzz" }));
  await show("text", () => c.file("hello.txt").text());
  await show("json", () => c.file("data.json").json());
  await show("bytes", async () => [...(await c.file("bin/data.bin").bytes())]);
  await show("arrayBuffer", async () => (await c.file("bin/data.bin").arrayBuffer()).byteLength);
  await show("stream", async () => new Response(c.file("hello.txt").stream()).text());
  await show("slice", () => c.file("hello.txt").slice(6, 11).text());
  await show("slice to end", () => c.file("hello.txt").slice(6).text());
  await show("slice props", () => { const s = c.file("hello.txt").slice(2, 5); return [s.size, s.name, c.file("hello.txt").size]; });
  await show("unicode key", () => c.file("dir/ü ö !*'()~.txt").text());
  await show("exists", () => [c.exists("hello.txt"), c.exists("nope")].map((p) => p.then(String)).reduce((a, b) => a.then(async (x) => x + " " + (await b)), Promise.resolve("")));
  await show("size", () => c.size("hello.txt"));
  await show("stat", async () => { const s = await c.stat("data.json"); return [s.size, s.type, s.etag, s.lastModified instanceof Date]; });
  await show("file.exists", () => c.file("hello.txt").exists());
  await show("missing text", () => c.file("nope").text());
  await show("missing stat", () => c.stat("nope"));
  await show("missing size", () => c.size("nope"));
  await show("list", async () => (await c.list()).contents?.map((o) => [o.key, o.size]));
  await show("list prefix", async () => (await c.list({ prefix: "bin/" })).contents?.map((o) => o.key));
  await show("list delimiter", async () => { const r = await c.list({ delimiter: "/" }); return [r.contents?.map((o) => o.key), r.commonPrefixes]; });
  await show("list paging", async () => { const a = await c.list({ maxKeys: 2 }); const b = await c.list({ maxKeys: 2, continuationToken: a.nextContinuationToken }); return [a.isTruncated, a.keyCount, a.contents?.map((o) => o.key), b.contents?.map((o) => o.key)]; });
  await show("file.write", async () => { const f = c.file("fw.txt"); return [await f.write("file write"), await f.text()]; });
  await show("file.write type", async () => { const f = c.file("fw.json", { type: "application/json" }); await f.write("{}"); return (await f.stat()).type; });
  await show("delete", async () => [await c.delete("fw.txt"), await c.exists("fw.txt")]);
  await show("unlink", async () => [await c.unlink("fw.json"), await c.exists("fw.json")]);
  await show("wrong secret", () => new Bun.S3Client({ accessKeyId: ${JSON.stringify(ACCESS_KEY)}, secretAccessKey: "wrong", bucket: "b", endpoint: ${JSON.stringify(endpoint)} }).file("hello.txt").text());
  await show("no credentials", () => new Bun.S3Client({ bucket: "b", endpoint: ${JSON.stringify(endpoint)}, accessKeyId: "", secretAccessKey: "" }).file("hello.txt").text());

  // Multipart: a stream past one part, a writer, a stream of exactly the part size.
  await show("multipart stream", async () => [await c.write("mp1.bin", chunk(12, 1024 * 1024)), (await c.stat("mp1.bin")).etag]);
  await show("multipart uneven", async () => [await c.write("mp2.bin", chunk(9, 1300000)), (await c.stat("mp2.bin")).etag]);
  await show("multipart writer", async () => { const w = c.file("mp3.bin").writer(); for (let i = 0; i < 6; i++) w.write(new Uint8Array(1024 * 1024).fill(i)); return [await w.end(), (await c.stat("mp3.bin")).etag]; });
  await show("multipart read back", async () => { const b = await c.file("mp1.bin").bytes(); return [b.length, b[0], b[b.length - 1]]; });
  await show("small writer", async () => { const w = c.file("w.txt").writer(); w.write("ab"); w.write("cd"); return [await w.end(), await c.file("w.txt").text()]; });

  // Presigned URLs, used: the browser's own fetch with no credentials.
  const get = c.presign("hello.txt", { expiresIn: 60 });
  await show("presign get", async () => [mask(get), (await (await fetch(get)).text())]);
  const put = c.presign("presigned.txt", { method: "PUT", expiresIn: 60, type: "text/plain" });
  await show("presign put", async () => { const r = await fetch(put, { method: "PUT", body: new TextEncoder().encode("via presign") }); return [mask(put), r.status, await c.file("presigned.txt").text()]; });
  await show("presign options", () => mask(c.presign("a b.txt", { acl: "public-read", storageClass: "STANDARD_IA", contentDisposition: "attachment; filename=x", type: "text/plain", expiresIn: 5 })));
  await show("file.presign", () => mask(c.file("hello.txt").presign({ expiresIn: 10 })));
  await show("presign token", () => mask(new Bun.S3Client({ accessKeyId: "a", secretAccessKey: "b", bucket: "b", sessionToken: "tok/+=" }).presign("k")));
  await show("presign vhost", () => mask(new Bun.S3Client({ accessKeyId: "a", secretAccessKey: "b", bucket: "bk", virtualHostedStyle: true }).presign("k")));
  await show("presign R2", () => mask(new Bun.S3Client({ accessKeyId: "a", secretAccessKey: "b", bucket: "bk", endpoint: "https://acct.r2.cloudflarestorage.com" }).presign("k")));
  await show("presign bad", () => c.presign("x", { expiresIn: 0 }));

  // The default client and s3:// URLs read S3_* from the environment (bucket "envb").
  await show("Bun.s3 write", () => Bun.s3.write("env.txt", "from env"));
  await show("Bun.s3 text", () => Bun.s3.file("env.txt").text());
  await show("Bun.s3 list", async () => (await Bun.s3.list()).name);
  await show("Bun.file s3://", () => Bun.file("s3://env.txt").text());
  await show("Bun.file s3:// props", () => { const f = Bun.file("s3://envb2/k.txt"); return [f.name, f.bucket, f instanceof Blob, Object.prototype.toString.call(f)]; });
  await show("Bun.write s3://", () => Bun.write("s3://env2.txt", "written by Bun.write"));
  await show("Bun.write s3 file", () => Bun.write(c.file("bw.txt"), "viaBun"));
  await show("Bun.write s3 from s3", () => Bun.write(c.file("bw2.txt"), c.file("bw.txt")));
  await show("fetch s3 get", async () => { const r = await fetch("s3://env2.txt"); return [r.status, await r.text()]; });
  await show("fetch s3 missing", async () => { const r = await fetch("s3://nope.txt"); return [r.status, r.statusText]; });
  await show("fetch s3 put", async () => { const r = await fetch("s3://fetched.txt", { method: "PUT", body: new TextEncoder().encode("put by fetch") }); return [r.status, await Bun.s3.file("fetched.txt").text()]; });
  await show("fetch s3 head", async () => (await fetch("s3://fetched.txt", { method: "HEAD" })).status);
  await show("fetch s3 delete", async () => (await fetch("s3://fetched.txt", { method: "DELETE" })).status);
  await show("static", async () => [await Bun.S3Client.write("st.txt", "static"), await Bun.S3Client.exists("st.txt"), await Bun.S3Client.size("st.txt"), await Bun.S3Client.file("st.txt").text(), await Bun.S3Client.unlink("st.txt")]);
  await show("static presign", () => mask(Bun.S3Client.presign("k", { expiresIn: 5 })));
  log("__end__");
})();
`,
};

/** The requests a run made, normalized: what a client sets (not what the HTTP library adds), signed header names, no dates. */
const requests = (log: Recorded[]) =>
  log
    .map((r) => ({
      method: r.method,
      path: r.path,
      query: r.query.replace(/X-Amz-(Date|Signature)=[^&]+/g, "X-Amz-$1=X"),
      auth: r.auth.replace(/\d{8}T\d{6}Z/g, "DATE"),
      signed: /SignedHeaders=([^,]+)/.exec(r.headers.authorization ?? "")?.[1] ?? "",
      headers: Object.fromEntries(Object.entries(r.headers).filter(([k, v]) => !(k === "content-length" && v === "0") && ["content-type", "content-disposition", "content-encoding", "content-length", "range"].includes(k) || (k.startsWith("x-amz-") && k !== "x-amz-date"))),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

let bad = 0;
const compare = (label: string, got: unknown[], want: unknown[]) => {
  let wrong = 0;
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    const [g, w] = [typeof got[i] === "string" ? got[i] : JSON.stringify(got[i]), typeof want[i] === "string" ? want[i] : JSON.stringify(want[i])];
    if (g === w) continue;
    wrong++;
    console.error(`✗ ${label} #${i + 1}\n  got  ${JSON.stringify(g)?.slice(0, 400)}\n  want ${JSON.stringify(w)?.slice(0, 400)}`);
  }
  bad += wrong;
  if (!wrong) console.log(`✓ ${label}: ${want.length} ${typeof want[0] === "string" ? "lines" : "requests"}`);
};

let wantLines: string[] = [];
let wantRequests: ReturnType<typeof requests> = [];
const clean = () => {
  mock.objects.clear();
  mock.log.length = 0;
};
if (!process.argv.includes("--no-native")) {
  const dir = mkdtempSync(join(tmpdir(), "s3-"));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    clean();
    // Not spawnSync: the mock S3 runs in this process.
    const p = Bun.spawn(["bun", "main.ts"], { cwd: dir, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    wantLines = out.trim().split("\n");
    wantRequests = requests(mock.log);
    if (p.exitCode) console.error(err);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const chrome = process.env.CHROME ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const vite = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-s3") },
});
// The embedding page, on another origin as a real host is.
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><meta charset="utf-8"><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=console"></iframe>
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
const profile = mkdtempSync(join(tmpdir(), "s3-chrome-"));
try {
  for (let i = 0; ; i++) {
    if (await fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false)) break;
    if (i > 150) throw new Error(`the dev server didn't come up:\n${await new Response(vite.stderr).text()}`);
    await Bun.sleep(200);
  }
  clean();
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile, protocolTimeout: 600_000 });
  try {
    const page = await browser.newPage();
    const crashes: string[] = [];
    page.on("pageerror", (e) => crashes.push(e instanceof Error ? e.message : String(e)));
    if (process.env.DEBUG) page.on("console", (m) => console.error("console", m.text()));
    await page.goto(`http://localhost:${HOST_PORT}/`);
    type W = { events: string[]; lines: string[]; rpc: (m: string, p?: unknown) => Promise<unknown> };
    await page.waitForFunction(() => (window as unknown as W).events.includes("ready"), { timeout: 240_000 });
    await page.evaluate((entry: string) => (window as unknown as W).rpc("run", { entry }), "main.ts");
    await page.waitForFunction(() => (window as unknown as W).lines.some((l) => l.includes("__end__") || /^error/.test(l)), { timeout: 180_000 }).catch(() => {});
    await Bun.sleep(300);
    const all = await page.evaluate(() => (window as unknown as W).lines);
    // The program's own lines (the console also shows the embed's `$ bun main.ts` and such).
    const start = all.findIndex((l) => l.startsWith("write string"));
    const got = start < 0 ? all : all.slice(start, all.indexOf("__end__", start) + 1 || undefined).filter((l) => l.trim() !== "");
    if (process.argv.includes("--no-native")) console.log(got.join("\n"));
    else compare("playground output", got, wantLines);
    if (bad && start < 0) console.error(all.join("\n"));
    if (!process.argv.includes("--no-native")) compare("requests the server saw", requests(mock.log), wantRequests);
    const refused = (l: Recorded[]) => l.filter((r) => r.auth !== "ok").length;
    // Native Bun is refused for the wrong secret on purpose, once.
    if (!process.argv.includes("--no-native") && refused(mock.log) !== wantRequests.filter((r) => r.auth !== "ok").length) (bad++, console.error(`✗ the server refused ${refused(mock.log)} requests, native Bun's run ${wantRequests.filter((r) => r.auth !== "ok").length}`));
    for (const c of crashes) (bad++, console.error(`✗ page error: ${c}`));
  } finally {
    await browser.close();
  }
} finally {
  host.stop(true);
  mock.stop();
  vite.kill();
  await vite.exited;
  rmSync(profile, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
