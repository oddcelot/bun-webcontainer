#!/usr/bin/env bun
// node:crypto's ciphers, keys, signatures and RSA encryption end to end (src/worker/node/crypto*.ts over crypto-wasm,
// loaded by a synchronous XHR in the worker): the fixture project (fixtures/crypto: cases.ts prints what is
// deterministic, or a verdict) runs in the embed in headless Chrome and must print what native Bun prints for the same
// files; then `jsonwebtoken` (RS256, PS256, ES256 and HS256: it signs through createSign, KeyObject and createHmac) is
// installed there and its tokens and verdicts compared the same way. ChaCha20-Poly1305, which Bun lacks, is checked
// against RFC 8439 by the fixture itself.
//   bun scripts/crypto.ts [--no-native] [--no-jwt]
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { nativeEnv } from "./native-env";

const app = join(import.meta.dir, "..");
const PORT = 5240;
const HOST_PORT = 5241;
const EDITOR = `http://localhost:${PORT}`;
const JWT = !process.argv.includes("--no-jwt");

const fixture = (name: string) => readFileSync(join(app, "fixtures/crypto", name), "utf8");
const files: Record<string, string> = {
  "cases.ts": fixture("cases.ts"),
  "data.ts": fixture("data.ts"),
  "main.ts": fixture("main.ts"),
  "package.json": JSON.stringify({ name: "crypto-check", dependencies: { jsonwebtoken: "9.0.2" } }),
  // Everything printed is deterministic: RS256 and HS256 signatures are, and a token made at random (ES256, PS256) is
  // checked by verifying it.
  "jwt.ts": `import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { rsaPrivate, ec256Private } from "./data.ts";

const rsaPublic = crypto.createPublicKey(rsaPrivate).export({ type: "spki", format: "pem" }) as string;
const ecPublic = crypto.createPublicKey(ec256Private).export({ type: "spki", format: "pem" }) as string;
const payload = { sub: "user-1", admin: true, iat: 1700000000 };
const t = (label: string, f: () => unknown) => {
  try {
    console.log(label + ":", f());
  } catch (e) {
    console.log(label + ": ! " + (e as Error).name + " " + (e as Error).message);
  }
};
t("hs256", () => jwt.sign(payload, "shhh", { algorithm: "HS256" }));
t("hs256 verify", () => JSON.stringify(jwt.verify(jwt.sign(payload, "shhh"), "shhh")));
t("hs256 key object", () => jwt.sign(payload, crypto.createSecretKey(Buffer.from("shhh"))) === jwt.sign(payload, "shhh"));
t("hs256 wrong secret", () => jwt.verify(jwt.sign(payload, "shhh"), "nope"));
t("rs256", () => jwt.sign(payload, rsaPrivate, { algorithm: "RS256" }));
t("rs256 verify", () => JSON.stringify(jwt.verify(jwt.sign(payload, rsaPrivate, { algorithm: "RS256" }), rsaPublic, { algorithms: ["RS256"] })));
t("rs384 verify", () => (jwt.verify(jwt.sign(payload, rsaPrivate, { algorithm: "RS384" }), rsaPublic) as { sub: string }).sub);
t("rs256 key object", () => jwt.sign(payload, crypto.createPrivateKey(rsaPrivate), { algorithm: "RS256" }) === jwt.sign(payload, rsaPrivate, { algorithm: "RS256" }));
t("rs256 public key object", () => (jwt.verify(jwt.sign(payload, rsaPrivate, { algorithm: "RS256" }), crypto.createPublicKey(rsaPublic)) as { sub: string }).sub);
t("rs256 tampered", () => jwt.verify(jwt.sign(payload, rsaPrivate, { algorithm: "RS256" }).replace(/.$/, (c) => (c === "A" ? "B" : "A")), rsaPublic));
t("rs256 wrong key", () => jwt.verify(jwt.sign(payload, rsaPrivate, { algorithm: "RS256" }), ecPublic));
t("ps256 verify", () => (jwt.verify(jwt.sign(payload, rsaPrivate, { algorithm: "PS256" }), rsaPublic) as { sub: string }).sub);
t("es256 verify", () => (jwt.verify(jwt.sign(payload, ec256Private, { algorithm: "ES256" }), ecPublic) as { sub: string }).sub);
t("es256 length", () => jwt.sign(payload, ec256Private, { algorithm: "ES256" }).split(".")[2].length);
t("decode", () => JSON.stringify(jwt.decode(jwt.sign(payload, "k"), { complete: true })));
t("expired", () => jwt.verify(jwt.sign({ exp: 1 }, "k"), "k"));
console.log("__jwt_end__");
`,
};

let bad = 0;
const compare = (label: string, got: string[], want: string[]) => {
  let wrong = 0;
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] === want[i]) continue;
    wrong++;
    console.error(`✗ ${label} line ${i + 1}\n  got  ${JSON.stringify(got[i]?.slice(0, 300))}\n  want ${JSON.stringify(want[i]?.slice(0, 300))}`);
  }
  bad += wrong;
  if (!wrong) console.log(`✓ ${label}: ${got.length} lines`);
};

// Native Bun first: its output is what the playground must print (without the chacha20 line, which is the fixture's own check).
let wantMain: string[] = [];
let wantJwt: string[] = [];
if (!process.argv.includes("--no-native")) {
  const dir = mkdtempSync(join(tmpdir(), "crypto-"));
  try {
    for (const [p, text] of Object.entries(files)) writeFileSync(join(dir, p), text);
    const run = (entry: string) => {
      const r = Bun.spawnSync(["bun", entry], { cwd: dir, env: nativeEnv() });
      if (r.exitCode) throw new Error(`native bun ${entry}:\n${r.stderr.toString()}`);
      return r.stdout.toString().trimEnd().split("\n");
    };
    wantMain = run("main.ts").filter((l) => !l.startsWith("chacha20:"));
    if (JWT) {
      const install = Bun.spawnSync(["bun", "install", "--no-progress"], { cwd: dir, env: nativeEnv() });
      if (install.exitCode) throw new Error(`native bun install:\n${install.stderr.toString()}`);
      wantJwt = run("jwt.ts");
    }
    console.log(`✓ native bun: ${wantMain.length} + ${wantJwt.length} lines`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const vite = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-crypto") },
});
// The embedding page, on another origin as a real host is.
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=console" allow="cross-origin-isolated"></iframe>
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
      { headers: { "content-type": "text/html; charset=utf-8", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" } },
    ),
});
type W = { lines: string[]; events: string[]; rpc: (m: string, p?: unknown) => Promise<unknown> };
const profile = mkdtempSync(join(tmpdir(), "crypto-chrome-"));
try {
  for (let i = 0; ; i++) {
    if (await fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false)) break;
    if (i > 150) throw new Error(`the dev server didn't come up:\n${await new Response(vite.stderr).text()}`);
    await Bun.sleep(200);
  }
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
  try {
    const page = await browser.newPage();
    const crashes: string[] = [];
    page.on("pageerror", (e) => crashes.push(e instanceof Error ? e.message : String(e)));
    if (process.env.DEBUG) page.on("console", (m) => console.error("console", m.text()));
    await page.goto(`http://localhost:${HOST_PORT}/`);
    await page.waitForFunction(() => (window as unknown as W).events.includes("ready"), { timeout: 60_000 });

    /** The lines a run of `entry` prints, from the one starting `first` to the one starting `last` (the console also shows `$ bun entry` and such). */
    const run = async (entry: string, first: string, last: string) => {
      const mark = await page.evaluate(() => (window as unknown as W).lines.length);
      await page.evaluate((e: string) => (window as unknown as W).rpc("run", { entry: e }), entry);
      await page.waitForFunction((n: number, end: string) => (window as unknown as W).lines.slice(n).some((l) => l.startsWith(end) || /^error/.test(l)), { timeout: 240_000 }, mark, last).catch(() => {});
      await Bun.sleep(300);
      const all = (await page.evaluate(() => (window as unknown as W).lines)).slice(mark);
      const start = all.findIndex((l) => l.startsWith(first));
      return { all, lines: (start < 0 ? all : all.slice(start)).filter((l) => l.trim() !== "") };
    };

    const main = await run("main.ts", "aes-128-cbc:", "chacha20:");
    const chachaLine = main.lines.find((l) => l.startsWith("chacha20:"));
    const got = main.lines.slice(0, main.lines.findIndex((l) => l.startsWith("chacha20:")) + 1 || undefined).filter((l) => !l.startsWith("chacha20:"));
    if (chachaLine === "chacha20: ok") console.log("✓ chacha20-poly1305 matches RFC 8439");
    else (bad++, console.error(`✗ chacha20-poly1305: ${chachaLine}`));
    if (wantMain.length) compare("crypto fixture", got, wantMain);
    else console.log(`(no native Bun: ${got.length} lines printed, not compared)`);
    if (bad && !got.length) console.error(main.all.join("\n"));

    if (JWT) {
      await page.evaluate(() => (window as unknown as W).rpc("install"));
      const jwt = await run("jwt.ts", "hs256:", "__jwt_end__");
      const lines = jwt.lines.slice(0, jwt.lines.indexOf("__jwt_end__") >>> 0 || undefined);
      if (wantJwt.length) compare("jsonwebtoken", lines, wantJwt.filter((l) => l !== "__jwt_end__"));
      else console.log(`(no native Bun: ${lines.length} jsonwebtoken lines printed, not compared)\n${lines.join("\n")}`);
      if (bad && !lines.length) console.error(jwt.all.join("\n"));
    }
    for (const c of crashes) (bad++, console.error(`✗ page error: ${c}`));
  } finally {
    await browser.close();
  }
} finally {
  host.stop(true);
  vite.kill();
  await vite.exited;
  rmSync(profile, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
