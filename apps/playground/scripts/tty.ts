#!/usr/bin/env bun
// The console as a terminal (src/console.ts `rawMode`, src/runner.ts `stdin-raw`, src/worker/stdin.ts, node/tty.ts,
// node/readline.ts), end to end: programs that put stdin in raw mode run in the embed in headless Chrome, a script
// presses keys in the console, and what the programs print must be what native Bun prints when it runs the same
// program on a pty and is fed the same bytes. The bytes themselves are the ones a terminal sends for each key (the
// expectation). Covered: `isTTY` and the other terminal properties, the bytes of every key in raw mode (Ctrl+C and
// Ctrl+D included, delivered to the program), `emitKeypressEvents`' key objects, node:readline's terminal mode (line
// editing, echo), and @clack/prompts (select, text, confirm), which also has to draw in place in the console.
//   bun scripts/tty.ts [--no-native]
// @clack/prompts is installed from npm (in the playground, and for native Bun), so this needs the network.
// Ports: PORT (the editor) and HOST_PORT (the embedding page). Chrome: CHROME=<path to the binary>, else the usual install.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 5310);
const HOST_PORT = Number(process.env.HOST_PORT ?? 5311);
const EDITOR = `http://localhost:${PORT}`;

/** What a terminal sends for a key (xterm's, in the console): what a program in raw mode reads. */
const KEYS: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Delete: "\x1b[3~",
  "Ctrl+A": "\x01",
  "Ctrl+C": "\x03",
  "Ctrl+D": "\x04",
};
/** A step: wait until the program printed `wait`, then press `keys` (a key's name from KEYS, else text typed as it is). */
type Step = { wait: string; keys: string[]; /** The wait is for this many of it (default 1). */ n?: number };
type Case = {
  name: string;
  file: string;
  code: string;
  steps: Step[];
  /** Printed once the program is done. */
  end: string;
  /** Which of the program's lines are compared with native Bun's. */
  keep?: RegExp;
  /** Checked on the console's screen before the step with that index. */
  screen?: Record<number, (screen: string) => string | undefined>;
  deps?: Record<string, string>;
};

const raw = (wait: string, ...keys: string[]): Step => ({ wait, keys });

const HEX = `const hex = (d) => [...d].map((b) => b.toString(16).padStart(2, "0")).join(" ");`;
const cases: Case[] = [
  {
    name: "raw mode: terminal properties and the bytes of each key",
    file: "raw.ts",
    code: `import tty from "node:tty";
${HEX}
const { stdin, stdout, stderr } = process;
console.log(["tty", stdin.isTTY, stdout.isTTY, stderr.isTTY, tty.isatty(0), tty.isatty(1), stdin instanceof tty.ReadStream, typeof stdout.columns, typeof stdout.rows, stdout.getWindowSize().length, stdout.getColorDepth() > 1, stdout.hasColors()].join(" "));
console.log("raw before " + stdin.isRaw);
stdin.setRawMode(true);
console.log("raw " + stdin.isRaw);
stdin.on("data", (d) => {
  console.log("key " + hex(d));
  if (d[0] === 4) {
    stdin.setRawMode(false);
    stdin.pause();
    console.log("done " + stdin.isRaw);
  }
});`,
    steps: [
      raw("raw true", "a"),
      raw("key 61", "Enter"),
      raw("key 0d", "Backspace"),
      raw("key 7f", "ArrowUp"),
      raw("key 1b 5b 41", "ArrowDown"),
      raw("key 1b 5b 42", "ArrowRight"),
      raw("key 1b 5b 43", "ArrowLeft"),
      raw("key 1b 5b 44", "Tab"),
      raw("key 09", "Escape"),
      raw("key 1b\n", "Home"),
      raw("key 1b 5b 48", "End"),
      raw("key 1b 5b 46", "Delete"),
      raw("key 1b 5b 33 7e", "Ctrl+C"),
      raw("key 03", "é"),
      raw("key c3 a9", "Ctrl+D"),
    ],
    end: "done false\n",
  },
  {
    name: "emitKeypressEvents: key objects",
    file: "keypress.ts",
    code: `import readline from "node:readline";
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
console.log("ready");
process.stdin.on("keypress", (str, key) => {
  console.log("keypress " + JSON.stringify(str) + " " + JSON.stringify([key.name, key.ctrl, key.meta, key.shift, key.sequence]));
  if (key.ctrl && key.name === "d") {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    console.log("done");
  }
});`,
    steps: [
      raw("ready", "a"),
      raw('["a",false,false,false', "A"),
      raw('["a",false,false,true', "7"),
      raw('["7"', " "),
      raw('["space"', "Enter"),
      raw('["return"', "Tab"),
      raw('["tab"', "Backspace"),
      raw('["backspace"', "ArrowUp"),
      raw('["up"', "ArrowLeft"),
      raw('["left"', "Home"),
      raw('["home"', "End"),
      raw('["end"', "Delete"),
      raw('["delete"', "Escape"),
      raw('["escape"', "Ctrl+C"),
      raw('["c",true', "Ctrl+A"),
      raw('["a",true', "Ctrl+D"),
    ],
    end: "done\n",
  },
  {
    name: "readline in a terminal: echo and line editing",
    file: "rl.ts",
    code: `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log("terminal " + rl.terminal);
rl.question("Name? ", (name) => {
  console.log("hi " + name);
  rl.question("Again? ", (again) => {
    console.log("again " + again);
    rl.on("line", (line) => console.log("line " + line));
    rl.setPrompt("$ ");
    rl.prompt();
  });
});
rl.on("close", () => console.log("closed"));`,
    steps: [
      raw("Name? ", "Zeb", "Backspace", "d"),
      raw("Name? ", "Enter"),
      raw("Again? ", "ac", "ArrowLeft", "b", "Enter"),
      raw("$ ", "ab", "Ctrl+A", "x", "Enter"),
      raw("line xab", "ArrowUp", "Enter"),
      { wait: "line xab", n: 2, keys: ["Ctrl+D"] },
    ],
    end: "closed\n",
    keep: /^(terminal|hi|again|line|closed)\b/,
    screen: {
      // The echo is on the prompt's row, and a redraw leaves one prompt, not a copy per key.
      1: (s) => (/^Name\? Zed$/m.test(s) ? undefined : `no "Name? Zed" row:\n${s}`),
    },
  },
  {
    name: "@clack/prompts: select, text and confirm",
    file: "clack.ts",
    code: `import * as p from "@clack/prompts";
console.log("ready");
const pick = await p.select({ message: "Pick one", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Gamma" }] });
console.log("chosen:" + String(pick));
const name = await p.text({ message: "Your name", placeholder: "nobody" });
console.log("name:" + String(name));
const sure = await p.confirm({ message: "Sure?" });
console.log("sure:" + String(sure));
console.log("end");`,
    steps: [
      raw("Pick one", "ArrowDown"),
      raw("Pick one", "Enter"),
      raw("Your name", "Zex", "Backspace", "d", "Enter"),
      raw("Sure?", "n"),
    ],
    end: "end\n",
    keep: /^(chosen|name|sure|end)\b/,
    deps: { "@clack/prompts": "1.9.0" },
    screen: {
      // Before Enter: the select is drawn once, updated in place (Beta marked, not a second list below the first).
      1: (s) => {
        const rows = s.split("\n");
        const count = (re: RegExp) => rows.filter((r) => re.test(r)).length;
        if (count(/Pick one/) !== 1) return `"Pick one" shown ${count(/Pick one/)} times:\n${s}`;
        if (!rows.some((r) => /[●>]\s*Beta/.test(r))) return `Beta is not the selected option:\n${s}`;
        if (rows.some((r) => /[●>]\s*Alpha/.test(r))) return `Alpha is still selected:\n${s}`;
        return undefined;
      },
    },
  },
];

let bad = 0;
const check = (name: string, got: string, want: string) => {
  if (got === want) console.log(`✓ ${name}`);
  else (bad++, console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`));
};
const lines = (out: string, keep?: RegExp) =>
  out
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\r/g, ""))
    .filter((l) => (keep ? keep.test(l) : l.trim() !== ""))
    .join("\n");

const noNative = process.argv.includes("--no-native");
const expected = new Map<string, string>();
if (!noNative) {
  const dir = mkdtempSync(join(tmpdir(), "tty-native-"));
  try {
    const sh = (cmd: string[], cwd: string) => Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    for (const c of cases) {
      const cdir = join(dir, c.file.replace(/\W/g, "_"));
      mkdirSync(cdir, { recursive: true });
      writeFileSync(join(cdir, c.file), c.code);
      if (c.deps) {
        writeFileSync(join(cdir, "package.json"), JSON.stringify({ name: "tty-check", dependencies: c.deps }));
        if (sh(["bun", "install", "--no-progress"], cdir).exitCode !== 0) throw new Error("bun install failed");
      }
      let out = "";
      const proc = Bun.spawn(["bun", c.file], { cwd: cdir, env: { ...process.env, TERM: "xterm-256color" }, terminal: { cols: 100, rows: 30, data: (_t: unknown, d: Uint8Array) => void (out += new TextDecoder().decode(d)) } });
      const count = (text: string, w: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(w).length - 1;
      const wait = async (w: string, n = 1) => {
        for (let i = 0; i < 100 && count(out, w) < n; i++) await Bun.sleep(100);
      };
      for (const step of c.steps) {
        await wait(step.wait, step.n);
        await Bun.sleep(150);
        for (const k of step.keys) {
          proc.terminal!.write(KEYS[k] ?? k);
          await Bun.sleep(60);
        }
      }
      await Promise.race([proc.exited, Bun.sleep(5000)]);
      proc.kill();
      await proc.exited;
      expected.set(c.name, lines(out, c.keep ?? /^(tty|raw|key|keypress|done|ready)\b/));
      if (!out.includes(c.end.trim())) (bad++, console.error(`✗ native bun ${c.name}: no ${JSON.stringify(c.end)} in ${JSON.stringify(out.slice(-120))}`));
    }
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

const files: Record<string, string> = { "package.json": JSON.stringify({ name: "tty-check", dependencies: { "@clack/prompts": "1.9.0" } }) };
for (const c of cases) files[c.file] = c.code;
const vite = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-tty") },
});
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=console&autorun=false"></iframe>
<script>
  window.out = ""; window.events = [];
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
    if (d.event === "console" && d.data.level !== "sys") window.out += d.data.text + (d.data.partial ? "" : "\\n");
  });
</script>`,
      { headers: { "content-type": "text/html" } },
    ),
});
const profile = mkdtempSync(join(tmpdir(), "tty-chrome-"));
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
    await page.waitForFunction(() => (window as any).events.includes("ready"), { timeout: 60_000 });
    const frame = () => page.frames().find((f) => f !== page.mainFrame())!;
    const out = () => page.evaluate(() => (window as any).out as string);
    /** The console's text, rows joined: what the reader sees. */
    const screen = () => frame().evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((r) => r.textContent ?? "").join("\n").replace(/ /g, " ").replace(/[ \t]+$/gm, ""));
    const press = async (k: string) => {
      const ctrl = /^Ctrl\+(\w)$/.exec(k);
      if (ctrl) {
        await page.keyboard.down("Control");
        await page.keyboard.press(`Key${ctrl[1]}` as "KeyA");
        await page.keyboard.up("Control");
      } else if (KEYS[k] && k.length > 1) await page.keyboard.press(k as "Enter");
      else await page.keyboard.type(k);
    };
    // The packages the programs import (@clack/prompts).
    await page.evaluate(() => (window as any).rpc("install"));
    for (const c of cases) {
      await page.evaluate(() => ((window as any).out = ""));
      await page.evaluate((entry: string) => (window as any).rpc("run", { entry }), c.file);
      let n = 0;
      for (const step of c.steps) {
        await page.waitForFunction((w: string, n: number) => ((window as any).out as string).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(w).length - 1 >= n, { timeout: 60_000 }, step.wait, step.n ?? 1).catch(() => {});
        await Bun.sleep(250);
        const problem = c.screen?.[n]?.(await screen());
        if (problem) (bad++, console.error(`✗ ${c.name}: ${problem}`));
        await frame().focus(".xterm-helper-textarea");
        for (const k of step.keys) {
          await press(k);
          await Bun.sleep(60);
        }
        n++;
      }
      await page.waitForFunction((e: string) => ((window as any).out as string).endsWith(e), { timeout: 20_000 }, c.end).catch(() => {});
      await Bun.sleep(200);
      const got = lines(await out(), c.keep ?? /^(tty|raw|key|keypress|done|ready)\b/);
      if (expected.has(c.name)) check(c.name, got, expected.get(c.name)!);
      else console.log(`(no native Bun) ${c.name}:\n${got}`);
      await page.evaluate(() => (window as any).rpc("stop"));
    }
    // After a raw-mode program the console is the shell again: its prompt is back, the cursor shown, input line by line.
    await page.evaluate(() => ((window as any).out = ""));
    await frame().focus(".xterm-helper-textarea");
    await page.keyboard.type("echo shell-still-works\n");
    await page.waitForFunction(() => ((window as any).out as string).includes("shell-still-works"), { timeout: 15_000 }).catch(() => {});
    check("shell after raw mode", (await out()).trim(), "shell-still-works");
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
void dirname;
process.exit(bad ? 1 : 0);
