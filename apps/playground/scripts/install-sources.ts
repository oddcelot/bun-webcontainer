#!/usr/bin/env bun
// `bun install` beyond the registry, end to end in headless Chrome (src/install.ts, lockfile.ts, lockfileWrite.ts,
// lifecycle.ts, patches.ts, gitDeps.ts, links.ts): a project with a `file:` folder and tarball, a `link:` folder `bun link`
// registered, a GitHub dependency (through the dev server's git proxy), a patched package and lifecycle scripts (the
// root's, a trusted dependency's, an untrusted one's) installs in the embed's console, and a program prints what got
// installed and what the scripts wrote. What the install printed of the scripts, the program's output, the bun.lock it
// wrote, `bun pm untrusted` and the patch `bun patch --commit` makes must all be native Bun's for the same project (run
// with `bun` in a temp folder). Then a trusted script that needs a native build fails, said so, without holding the
// install. Needs the network (registry.npmjs.org, codeload.github.com).
//   bun scripts/install-sources.ts
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5810;
const HOST_PORT = 5811;
const EDITOR = `http://localhost:${PORT}`;

/** A package tarball (gzipped), made natively: the browser writes the same bytes from their base64. */
function tarball(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    const h = new Uint8Array(512);
    const put = (s: string, off: number) => h.set(enc.encode(s), off);
    put(`package/${name}`, 0);
    put("0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    put("        ", 148);
    h[156] = 48;
    put("ustar\0", 257);
    put("00", 263);
    put(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return Bun.gzipSync(Buffer.concat(blocks));
}

const PATCH = `diff --git a/index.js b/index.js
index 27f19b757f7c1186b92c405a213bf0dd9b6cbe95..e82942f327f789c570b8ad4b679cf4ad598e6a47 100644
--- a/index.js
+++ b/index.js
@@ -16,3 +16,4 @@ module.exports = function(num) {
   }
   return false;
 };
+module.exports.patched = true;
`;

const pkg = {
  name: "sources-app",
  version: "1.0.0",
  scripts: { preinstall: "echo root-pre $npm_lifecycle_event", postinstall: "bun post.ts", prepare: "echo root-prepare" },
  dependencies: {
    "local-pkg": "file:./local",
    "tar-pkg": "file:vendor/tar-pkg-0.3.0.tgz",
    "linked-pkg": "link:linked-pkg",
    "is-odd": "github:jonschlinkert/is-odd#3.0.1",
    "is-number": "7.0.0",
    "ms": "2.1.3",
    "trusted-dep": "file:./trusted",
    "untrusted-dep": "file:./untrusted",
  },
  trustedDependencies: ["trusted-dep"],
  patchedDependencies: { "is-number@7.0.0": "patches/is-number@7.0.0.patch" },
};

const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "sources-app" }),
  "vendor/tar-pkg.b64": Buffer.from(tarball({ "package.json": JSON.stringify({ name: "tar-pkg", version: "0.3.0" }), "index.js": 'module.exports = "from tar-pkg";\n' })).toString("base64"),
  "make-tgz.ts": `await Bun.write("vendor/tar-pkg-0.3.0.tgz", Buffer.from(await Bun.file("vendor/tar-pkg.b64").text(), "base64"));\nconsole.log("tarball written");\n`,
  "patches/is-number@7.0.0.patch": PATCH,
  "local/package.json": JSON.stringify({ name: "local-pkg", version: "1.2.0", main: "index.js", dependencies: { "is-number": "^7.0.0" } }),
  "local/index.js": 'module.exports = "from local-pkg";\n',
  "linked/package.json": JSON.stringify({ name: "linked-pkg", version: "2.0.0", main: "index.js" }),
  "linked/index.js": 'module.exports = "from linked-pkg";\n',
  "trusted/package.json": JSON.stringify({ name: "trusted-dep", version: "1.0.0", scripts: { preinstall: "echo trusted-pre", postinstall: "node build.js" } }),
  "trusted/build.js": `const path = require("node:path");\nrequire("node:fs").writeFileSync("built.txt", [process.env.npm_lifecycle_event, process.env.npm_package_name, path.relative(process.env.INIT_CWD, process.cwd())].join(" "));\n`,
  "untrusted/package.json": JSON.stringify({ name: "untrusted-dep", version: "1.0.0", scripts: { postinstall: "node build.js" } }),
  "untrusted/build.js": `require("node:fs").writeFileSync("built.txt", "ran");\n`,
  "post.ts": `await Bun.write("post.txt", "root " + process.env.npm_lifecycle_event + " " + process.env.npm_package_name);\nconsole.log("root-post");\n`,
  "main.ts": `import { existsSync, readFileSync } from "node:fs";
import isNumber from "is-number";
console.log("local:", require("local-pkg"), require("local-pkg/package.json").version);
console.log("tar:", require("tar-pkg"));
console.log("linked:", require("linked-pkg"));
console.log("is-odd:", require("is-odd")(3), require("is-odd/package.json").version);
console.log("patched:", isNumber.patched === true, isNumber(5));
console.log("trusted:", readFileSync("node_modules/trusted-dep/built.txt", "utf8"));
console.log("untrusted ran:", existsSync("node_modules/untrusted-dep/built.txt"));
console.log("root:", readFileSync("post.txt", "utf8"));
console.log("__end__");
`,
};

let bad = 0;
const compare = (label: string, got: unknown, want: unknown) => {
  const [g, w] = [JSON.stringify(got, null, 1), JSON.stringify(want, null, 1)];
  if (g === w) return console.log(`✓ ${label}`);
  bad++;
  console.error(`✗ ${label}\n  got  ${g}\n  want ${w}`);
};
/**
 * The install's lines about scripts: the commands it echoed (`$ …`, native Bun's stderr), and what they printed and
 * what was blocked (its stdout), each in order.
 */
const scriptLines = (lines: string[]) => {
  const all = lines.map((l) => l.trim());
  return { echoed: all.filter((l) => l.startsWith("$ ")), printed: all.filter((l) => /^(root-|trusted-|Blocked )/.test(l)) };
};
/** A program's output, from its first line to `__end__`. */
const output = (lines: string[]) => {
  const start = lines.findIndex((l) => l.startsWith("local:"));
  return start < 0 ? lines : lines.slice(start, lines.indexOf("__end__", start) + 1);
};
/** `bun pm untrusted`'s report, without its banner. */
const report = (lines: string[]) => lines.map((l) => l.trimEnd()).filter((l) => l && !l.startsWith("bun pm untrusted"));

// Native Bun on the same project, with a global folder of its own for `bun link`.
const nativeDir = mkdtempSync(join(tmpdir(), "install-sources-"));
const env = { ...process.env, BUN_INSTALL: join(nativeDir, ".bun-global"), NO_COLOR: "1" };
const native: { install: ReturnType<typeof scriptLines>; run: string[]; lock: string; untrusted: string[]; trusted: [boolean, string]; patch: string; patchedLock: string } = {} as never;
try {
  const write = (p: string, text: string) => (mkdirSync(dirname(join(nativeDir, p)), { recursive: true }), writeFileSync(join(nativeDir, p), text));
  for (const [p, text] of Object.entries(files)) write(p, text);
  write("package.json", JSON.stringify(pkg, null, 2));
  const sh = (cmd: string[], cwd = nativeDir) => {
    const r = Bun.spawnSync(cmd, { cwd, env, stderr: "pipe" });
    return (r.stdout.toString() + r.stderr.toString()).split("\n");
  };
  sh(["bun", "make-tgz.ts"]);
  sh(["bun", "link"], join(nativeDir, "linked"));
  native.install = scriptLines(sh(["bun", "install"]));
  native.run = output(sh(["bun", "main.ts"]));
  native.lock = readFileSync(join(nativeDir, "bun.lock"), "utf8");
  native.untrusted = report(sh(["bun", "pm", "untrusted"]));
  // Trusting it runs its script, and bun.lock lists it.
  sh(["bun", "pm", "trust", "untrusted-dep"]);
  native.trusted = [existsSync(join(nativeDir, "node_modules/untrusted-dep/built.txt")), readFileSync(join(nativeDir, "bun.lock"), "utf8")];
  // A second patch, made by `bun patch --commit` from an edit.
  sh(["bun", "patch", "ms"]);
  const msFile = join(nativeDir, "node_modules/ms/index.js");
  writeFileSync(msFile, readFileSync(msFile, "utf8").replace("var s = 1000;", "var s = 1000; // a second"));
  sh(["bun", "patch", "--commit", "node_modules/ms"]);
  native.patch = readFileSync(join(nativeDir, "patches/ms@2.1.3.patch"), "utf8");
  native.patchedLock = readFileSync(join(nativeDir, "bun.lock"), "utf8");
  console.log(`native bun: ${native.run.length} lines`);
} finally {
  rmSync(nativeDir, { recursive: true, force: true });
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
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-install-sources") },
});
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
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ),
});
type W = { lines: string[]; events: string[]; rpc: (m: string, p?: unknown) => Promise<unknown> };
const profile = mkdtempSync(join(tmpdir(), "install-sources-chrome-"));
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
    const embed = page.frames().find((f) => f.url().includes("/embed"))!;
    await Bun.sleep(2000);
    const rpc = (method: string, params?: unknown) => page.evaluate((m, p) => (window as unknown as W).rpc(m, p), method, params as never);
    const lines = () => page.evaluate(() => (window as unknown as W).lines);
    /** Types a console command; resolves with the lines it printed once `done` matches one of them. */
    const type = async (command: string, done: RegExp, timeout = 120_000) => {
      const mark = (await lines()).length;
      await embed.focus(".xterm-helper-textarea");
      await page.keyboard.type(`${command}\n`);
      await page
        .waitForFunction((n: number, re: string) => (window as unknown as W).lines.slice(n).some((l) => new RegExp(re).test(l)), { timeout }, mark, done.source)
        .catch(() => console.error(`(timed out waiting for ${done} after \`${command}\`)`));
      await Bun.sleep(300);
      const out = (await lines()).slice(mark);
      if (process.env.DEBUG) console.error(`$ ${command}\n${out.join("\n")}`);
      return out;
    };
    await type("bun make-tgz.ts", /tarball written|error/);
    await type("cd linked && bun link && cd /", /Registered|error/);
    await rpc("writeFile", { path: "package.json", text: JSON.stringify(pkg, null, 2) });
    const install = await type("bun install", /\[bun install\] \d+ packages installed/, 180_000);
    compare("the scripts ran and were blocked as in bun install", scriptLines(install), native.install);
    compare("the installed packages and the scripts' files", output(await type("bun main.ts", /__end__|error/)), native.run);
    compare("bun.lock is native bun install's", await rpc("readFile", { path: "bun.lock" }), native.lock);
    compare("bun pm untrusted", report(await type("bun pm untrusted", /bun pm trust/)), native.untrusted);
    await type("bun pm trust untrusted-dep", /\[bun install\] \d+ packages installed/);
    const built = await rpc("readFile", { path: "node_modules/untrusted-dep/built.txt" }).then(() => true, () => false);
    compare("bun pm trust runs the script and bun.lock lists it", [built, await rpc("readFile", { path: "bun.lock" })], native.trusted);
    // bun patch, an edit, bun patch --commit: the patch native Bun makes, and its bun.lock.
    await type("bun patch ms", /bun patch --commit/);
    const ms = (await rpc("readFile", { path: "node_modules/ms/index.js" })) as string;
    await rpc("writeFile", { path: "node_modules/ms/index.js", text: ms.replace("var s = 1000;", "var s = 1000; // a second") });
    await type("bun patch --commit node_modules/ms", /\[bun install\] \d+ packages installed/, 120_000);
    compare("bun patch --commit writes native Bun's patch", await rpc("readFile", { path: "patches/ms@2.1.3.patch" }).catch(String), native.patch);
    compare("…and its bun.lock", await rpc("readFile", { path: "bun.lock" }), native.patchedLock);
    const patched = (await rpc("readFile", { path: "node_modules/ms/index.js" })) as string;
    compare("the reinstalled ms has the patch", patched.includes("var s = 1000; // a second"), true);
    // A trusted script that needs a native build: an error that says so, and the install ends.
    const gyp = { ...pkg, dependencies: { ...pkg.dependencies, "gyp-dep": "file:./gyp" }, trustedDependencies: [...pkg.trustedDependencies, "gyp-dep"] };
    await rpc("writeFile", { path: "gyp/package.json", text: JSON.stringify({ name: "gyp-dep", version: "1.0.0", scripts: { install: "node-gyp rebuild" } }) });
    await rpc("writeFile", { path: "package.json", text: JSON.stringify(gyp, null, 2) });
    const failed = await type("bun install", /\[bun install\] \d+ packages installed/, 180_000);
    compare(
      "a native build fails, said so",
      failed.some((l) => /error: install script from "gyp-dep" exited with \d+ \(it builds a native addon/.test(l)),
      true,
    );
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
