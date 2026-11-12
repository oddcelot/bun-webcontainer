#!/usr/bin/env bun
// Child processes in the browser (src/worker/processes.ts, spawn.ts, node/child_process.ts; the page side in
// src/runner.ts), end to end: a project runs in the embed in headless Chrome and each program prints what its children
// did. Bun.spawn with pipes, stdin, exit codes and kill; child_process spawn/exec/execFile; Bun.$ running `bun` in a
// pipeline; package.json scripts (spawned, and the console's `bun run` of a shell line); a child's file writes;
// grandchildren. The expected lines are what native Bun prints for the same project (checked by running it with `bun`
// in a temp folder, unless --no-native).
//   bun scripts/processes.ts [--no-native] [--content-origin]
// --content-origin: project code on its own origin (run.runbun.localhost), as on runbun.dev (src/contentOrigin.ts).
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = 5198;
const HOST_PORT = 5197;
const CONTENT = process.argv.includes("--content-origin");
const EDITOR = `http://${CONTENT ? "runbun." : ""}localhost:${PORT}`;

const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "procs", scripts: { greet: "echo from-script && bun child.ts s", build: "echo built && bun child.ts b > built.txt && cat built.txt" } }),
  "child.ts": `console.log("child", process.argv.slice(2).join(","), process.env.X ?? "-");\nprocess.exitCode = Number(process.env.CODE ?? 0);`,
  "upper.ts": `let s = "";\nfor await (const c of process.stdin) s += c;\nprocess.stdout.write(s.toUpperCase());`,
  "forever.ts": `console.log("up");\nsetInterval(() => {}, 1000);`,
  "trap.ts": `process.on("SIGTERM", () => { console.log("trapped"); process.exit(5); });\nconsole.log("up");\nsetInterval(() => {}, 1000);`,
  "writer.ts": `await Bun.write("out.txt", "written by child");\nconsole.error("to stderr");`,
  "nested.ts": `const p = Bun.spawn(["bun", "child.ts", "grand"]);\nconsole.log("nested:", (await new Response(p.stdout).text()).trim());`,
  "main.ts": `import { $ } from "bun";
import { exec, execFile, execSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const log = (...a: unknown[]) => console.log(...a);
// Not top-level await: the entry would count as still starting all along (the playground gives that 15 s).
void (async () => {

// Bun.spawn: argv, env, exit code
{
  const p = Bun.spawn(["bun", "child.ts", "a", "b c"], { env: { ...process.env, X: "x1", CODE: "3" } });
  log("spawn:", (await new Response(p.stdout).text()).trim(), await p.exited, p.exitCode);
}
// stdin as a pipe
{
  const p = Bun.spawn(["bun", "upper.ts"], { stdin: "pipe" });
  p.stdin!.write("hello ");
  p.stdin!.write("world");
  p.stdin!.end();
  log("stdin:", await new Response(p.stdout).text());
}
// stdin from a string
{
  const p = Bun.spawn(["bun", "upper.ts"], { stdin: new Response("from response") });
  log("stdin2:", await new Response(p.stdout).text());
}
// stderr piped
{
  const p = Bun.spawn(["bun", "writer.ts"], { stderr: "pipe" });
  log("stderr:", (await new Response(p.stderr).text()).trim(), await p.exited);
  log("file:", readFileSync("out.txt", "utf8"));
}
// kill
{
  const p = Bun.spawn(["bun", "forever.ts"]);
  const reader = p.stdout.getReader();
  await reader.read();
  p.kill();
  log("kill:", await p.exited, p.exitCode, p.signalCode, p.killed);
}
// a SIGTERM handler
{
  const p = Bun.spawn(["bun", "trap.ts"]);
  const reader = p.stdout.getReader();
  await reader.read();
  p.kill("SIGTERM");
  log("trap:", await p.exited, new TextDecoder().decode((await reader.read()).value).trim());
}
// not there
try {
  Bun.spawn(["nope-cmd"]);
} catch (e) {
  log("enoent:", (e as { code?: string }).code);
}
// child_process.spawn
await new Promise<void>((done) => {
  const cp = spawn("bun", ["child.ts", "cp"], { env: { ...process.env, X: "x2" } });
  let out = "";
  cp.stdout.on("data", (c) => (out += c));
  cp.on("close", (code, signal) => {
    log("cp.spawn:", out.trim(), code, signal);
    done();
  });
});
await new Promise<void>((done) => {
  const cp = spawn("nope-cmd");
  cp.on("error", (e: Error & { code?: string }) => {
    log("cp.enoent:", e.code, e.message);
    done();
  });
});
// exec (a shell line) and execFile, promisified
{
  const { stdout } = await promisify(exec)("echo hi && bun child.ts e");
  log("exec:", JSON.stringify(stdout));
  const r = await promisify(execFile)("bun", ["child.ts", "f"]);
  log("execFile:", JSON.stringify(r.stdout));
  try {
    await promisify(exec)("bun child.ts", { env: { ...process.env, CODE: "2" } });
  } catch (e) {
    log("exec fail:", (e as { code?: number }).code);
  }
}
// Bun.$ with a child process in a pipeline
log("$:", (await $\`bun child.ts dollar | cat\`.text()).trim());
log("$ code:", (await $\`bun child.ts\`.env({ ...process.env, CODE: "4" }).nothrow().quiet()).exitCode);
// package.json script
{
  const p = Bun.spawn(["bun", "run", "greet"]);
  log("script:", (await new Response(p.stdout).text()).trim().split("\\n").join(" | "));
}
// a grandchild
{
  const p = Bun.spawn(["bun", "nested.ts"]);
  log((await new Response(p.stdout).text()).trim());
}
try {
  execSync("echo no");
  log("execSync: ran");
} catch (e) {
  log("execSync:", (e as Error).message.includes("not supported"));
}
log("__end__");
})();
`,
};

/** What native Bun prints, except where the playground differs on purpose (execSync runs natively). */
const EXPECTED = [
  "spawn: child a,b c x1 3 3",
  "stdin: HELLO WORLD",
  "stdin2: FROM RESPONSE",
  "stderr: to stderr 0",
  "file: written by child",
  "kill: 143 null SIGTERM true",
  "trap: 5 trapped",
  "enoent: ENOENT",
  "cp.spawn: child cp x2 0 null",
  "cp.enoent: ENOENT Executable not found in $PATH: \"nope-cmd\"",
  'exec: "hi\\nchild e -\\n"',
  'execFile: "child f -\\n"',
  "exec fail: 2",
  "$: child dollar -",
  "$ code: 4",
  "script: from-script | child s -",
  "nested: child grand -",
  "execSync: true",
  "__end__",
];

let bad = 0;
const compare = (label: string, got: string[]) => {
  let wrong = 0;
  for (let i = 0; i < Math.max(got.length, EXPECTED.length); i++) {
    if (got[i] === EXPECTED[i]) continue;
    wrong++;
    console.error(`✗ ${label} line ${i + 1}\n  got  ${JSON.stringify(got[i])}\n  want ${JSON.stringify(EXPECTED[i])}`);
  }
  bad += wrong;
  if (!wrong) console.log(`✓ ${label}: ${got.length} lines`);
};

// Native Bun first: the expectations are its behavior (execSync aside, which runs natively).
if (!process.argv.includes("--no-native")) {
  const dir = mkdtempSync(join(tmpdir(), "procs-"));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    const r = Bun.spawnSync(["bun", "main.ts"], { cwd: dir, env: { ...process.env, X: undefined, CODE: undefined } });
    const lines = r.stdout.toString().trim().split("\n");
    const i = lines.indexOf("execSync: ran");
    if (i >= 0) lines[i] = "execSync: true";
    compare("native bun", lines);
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
  env: {
    ...process.env,
    VITE_CACHE_DIR: join(app, "node_modules/.vite-processes"),
    ...(CONTENT && { VITE_CONTENT_ORIGIN: `http://run.runbun.localhost:${PORT}`, VITE_EDITOR_ORIGINS: EDITOR }),
  },
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
      { headers: { "content-type": "text/html" } },
    ),
});
const profile = mkdtempSync(join(tmpdir(), "processes-"));
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
    if (process.env.DEBUG) {
      page.on("framenavigated", (f) => console.error("navigated", f.url()));
      page.on("console", (m) => console.error("console", m.text()));
    }
    await page.goto(`http://localhost:${HOST_PORT}/`);
    await page.waitForFunction(() => (window as unknown as { events: string[] }).events.includes("ready"), { timeout: 60_000 });
    await page.evaluate(() => (window as unknown as { rpc: (m: string, p?: unknown) => Promise<unknown> }).rpc("run", { entry: "main.ts" }));
    await page.waitForFunction(() => (window as unknown as { lines: string[] }).lines.some((l) => l.includes("__end__") || /^error/.test(l)), { timeout: 60_000 }).catch(() => {});
    await Bun.sleep(300);
    const all = await page.evaluate(() => (window as unknown as { lines: string[] }).lines);
    // The program's own lines (the console also shows the embed's `$ bun main.ts` and such).
    const start = all.findIndex((l) => l.startsWith("spawn:"));
    const got = start < 0 ? all : all.slice(start, all.indexOf("__end__", start) + 1 || undefined).filter((l) => l.trim() !== "");
    compare("playground", got);
    if (bad && start < 0) console.error(all.join("\n"));
    // The console's `bun run` of a script that is a shell line: the program is Bun's shell, its commands children.
    const embed = page.frames().find((f) => f.url().includes("/embed"))!;
    const before = all.length;
    await embed.focus(".xterm-helper-textarea");
    await page.keyboard.type("bun run build\n");
    await page.waitForFunction((n: number) => (window as unknown as { lines: string[] }).lines.slice(n).some((l) => l.includes("exited with code")), { timeout: 30_000 }, before).catch(() => {});
    const after = (await page.evaluate(() => (window as unknown as { lines: string[] }).lines)).slice(before);
    const want = ["built", "child b -"];
    const ran = after.filter((l) => want.includes(l));
    if (JSON.stringify(ran) === JSON.stringify(want)) console.log("✓ console bun run <shell line>");
    else (bad++, console.error(`✗ console bun run build\n  got  ${JSON.stringify(after)}\n  want ${JSON.stringify(want)}`));
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
