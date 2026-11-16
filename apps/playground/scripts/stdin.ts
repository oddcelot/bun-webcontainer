#!/usr/bin/env bun
// The console as the program's stdin (src/console.ts `reading`, src/runner.ts `stdin`, src/worker/stdin.ts, node/readline.ts),
// end to end: programs that read process.stdin, Bun.stdin, `console` and readline run in the embed in headless
// Chrome, a script types into the console as a reader would (each line once the program asks for it, then Ctrl+D or
// not), and what the program printed must be what native Bun prints when it is fed the same lines the same way. The
// console must also show what was typed, on the row of the prompt.
//   bun scripts/stdin.ts [--no-native] [--isolated]
// --isolated: the embedding page sends COOP and COEP, so the embed is cross-origin isolated and `prompt()` can block on
// the console's input; without it, `prompt()` must throw a NotIsolatedError.
// Chrome: CHROME=<path to the binary>, else the usual install on macOS or Linux.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const app = join(import.meta.dir, "..");
const ISOLATED = process.argv.includes("--isolated");
const PORT = 5300;
const HOST_PORT = 5301;
const EDITOR = `http://localhost:${PORT}`;

/** What a reader does: wait until the program printed `wait`, then type `send` and Enter (null: Ctrl+D). */
type Step = { wait: string; send: string | null };
type Case = { name: string; file: string; code: string; steps: Step[]; /** Printed once the program is done. */ end: string; /** Native Bun has no such behavior to compare with. */ playgroundOnly?: true };

const ask = (q: string, a: string | null): Step => ({ wait: q, send: a });

const cases: Case[] = [
  {
    name: "readline question",
    file: "question.ts",
    code: `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Name? ", (name) => {
  console.log("Hello " + name);
  rl.question("Age? ", (age) => {
    console.log("Age " + (Number(age) + 1));
    rl.close();
  });
});
rl.on("close", () => console.log("closed"));`,
    steps: [ask("Name? ", "Bob"), ask("Age? ", "41")],
    end: "closed\n",
  },
  {
    name: "readline/promises question",
    file: "promises.ts",
    code: `import { createInterface } from "node:readline/promises";
const rl = createInterface({ input: process.stdin, output: process.stdout });
const a = await rl.question("a? ");
const b = await rl.question("b? ");
console.log(Number(a) + Number(b));
rl.close();
console.log("done");`,
    steps: [ask("a? ", "2"), ask("b? ", "40")],
    end: "done\n",
  },
  {
    name: "readline line and close events, prompt()",
    file: "events.ts",
    code: `import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
rl.setPrompt("$ ");
console.log(rl.getPrompt() === "$ ");
rl.prompt();
rl.on("line", (line) => {
  if (line === "quit") return rl.close();
  console.log("line:" + line.toUpperCase());
  rl.prompt();
});
rl.on("close", () => console.log("bye"));`,
    steps: [ask("$ ", "one"), ask("line:ONE\n$ ", "two words"), ask("line:TWO WORDS\n$ ", "quit")],
    end: "bye\n",
  },
  {
    name: "readline ends at Ctrl+D",
    file: "eof.ts",
    code: `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const seen: string[] = [];
rl.on("line", (l) => seen.push(l));
rl.on("close", () => console.log("lines", JSON.stringify(seen)));`,
    steps: [ask("", "a"), ask("", "b c"), ask("", null)],
    end: 'lines ["a","b c"]\n',
  },
  {
    name: "readline async iterator",
    file: "iter.ts",
    code: `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let n = 0;
for await (const line of rl) {
  n++;
  console.log(n + ":" + line);
}
console.log("end", n);`,
    steps: [ask("", "x"), ask("1:x\n", "y z"), ask("2:y z\n", null)],
    end: "end 2\n",
  },
  {
    name: "for await of process.stdin",
    file: "chunks.ts",
    code: `let s = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  s += chunk;
  console.log("chunk " + JSON.stringify(chunk));
}
console.log("total " + JSON.stringify(s));`,
    steps: [ask("", "first"), ask('chunk "first\\n"\n', "second"), ask('chunk "second\\n"\n', null)],
    end: 'total "first\\nsecond\\n"\n',
  },
  {
    name: "process.stdin data and end events",
    file: "events-data.ts",
    code: `process.stdin.setEncoding("utf8");
let n = 0;
process.stdin.on("data", (d) => console.log("data", ++n, JSON.stringify(d)));
process.stdin.on("end", () => console.log("end", n));
process.stdin.on("close", () => console.log("close"));`,
    steps: [ask("", "hello"), ask('data 1 "hello\\n"\n', "there"), ask('data 2 "there\\n"\n', null)],
    end: "end 2\nclose\n",
  },
  {
    name: "process.stdin pause and resume",
    file: "pause.ts",
    code: `process.stdin.on("data", (d) => {
  console.log("got " + d.toString().trim());
  process.stdin.pause();
  console.log("paused");
});
process.stdin.once("pause", () => console.log("pause event"));`,
    steps: [ask("", "one")],
    end: "paused\n",
  },
  {
    name: "Bun.stdin.text()",
    file: "text.ts",
    code: `console.log("reading");
const text = await Bun.stdin.text();
console.log(JSON.stringify(text));
console.log(text.trim().split("\\n").length);`,
    steps: [ask("reading\n", "alpha"), ask("", "beta"), ask("", null)],
    end: '"alpha\\nbeta\\n"\n2\n',
  },
  {
    name: "Bun.stdin.json()",
    file: "json.ts",
    code: `const data = await Bun.stdin.json();
console.log(data.a + data.b, Object.keys(data));`,
    steps: [ask("", '{"a":40,"b":2}'), ask("", null)],
    end: "42 [ \"a\", \"b\" ]\n",
  },
  {
    name: "Bun.stdin.stream()",
    file: "stream.ts",
    code: `const reader = Bun.stdin.stream().getReader();
for (let r = await reader.read(); !r.done; r = await reader.read()) console.log("chunk", JSON.stringify(new TextDecoder().decode(r.value)));
console.log("done", (await Bun.stdin.bytes()).length);`,
    steps: [ask("", "abc"), ask('chunk "abc\\n"\n', "de"), ask('chunk "de\\n"\n', null)],
    end: "done 0\n",
  },
  {
    name: "for await of console",
    file: "console.ts",
    code: `let n = 0;
for await (const line of console) {
  n++;
  console.log("L" + n + " " + JSON.stringify(line));
}
console.log("eof after", n);`,
    steps: [ask("", "one"), ask('L1 "one"\n', ""), ask('L2 ""\n', "last"), ask('L3 "last"\n', null)],
    end: "eof after 4\n",
  },
  {
    name: "console iterator with a line without newline at EOF",
    file: "console-partial.ts",
    code: `for await (const line of console) console.log("got", JSON.stringify(line));
console.log("done");`,
    // Ctrl+D with text typed sends it without a newline, then Ctrl+D on the empty row ends it.
    steps: [ask("", "a"), { wait: "got \"a\"\n", send: "tail\u0004" }, ask("", null)],
    end: 'got "tail"\ndone\n',
  },
  {
    name: "readline helpers",
    file: "helpers.ts",
    code: `import readline from "node:readline";
import { PassThrough } from "node:stream";
const out = new PassThrough();
let s = "";
out.on("data", (d) => (s += d));
console.log(readline.clearLine(out, 0), readline.cursorTo(out, 0), readline.moveCursor(out, 1, -2), readline.clearScreenDown(out), readline.emitKeypressEvents(process.stdin));
console.log(JSON.stringify(s));
console.log(typeof readline.Interface, typeof readline.promises.createInterface, typeof readline.promises.Interface);`,
    steps: [],
    end: "function function function\n",
  },
  // prompt() blocks the program until the line comes: only on a cross-origin isolated page (--isolated), else it throws.
  ISOLATED
    ? {
        name: "prompt()",
        file: "prompt.ts",
        code: `console.log(JSON.stringify([prompt("A?"), prompt("B?", "30"), prompt("C?"), prompt()]));`,
        steps: [ask("A? ", "one"), ask("B? [30] ", ""), ask("C? ", ""), ask("Prompt ", null)],
        end: '["one","30",null,null]\n',
      }
    : {
        name: "prompt() on a page that isn't isolated",
        file: "prompt.ts",
        code: `try {\n  prompt("A?");\n} catch (e) {\n  console.log(e.name, e.code);\n}`,
        steps: [],
        end: "NotIsolatedError ERR_NOT_ISOLATED\n",
        playgroundOnly: true,
      },
];

const dec = new TextDecoder();

/** Native Bun running the case, fed by the same steps: a line goes in once the program has printed what the step waits for. */
async function native(c: Case, dir: string): Promise<string> {
  writeFileSync(join(dir, c.file), c.code);
  const proc = Bun.spawn(["bun", c.file], { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let out = "";
  const reading = (async () => {
    for await (const chunk of proc.stdout) out += dec.decode(chunk);
  })();
  const errors = new Response(proc.stderr).text();
  for (const step of c.steps) {
    for (let i = 0; !out.includes(step.wait) && i < 200; i++) await Bun.sleep(25);
    if (step.send === null) proc.stdin.end();
    else {
      proc.stdin.write(step.send.endsWith("\u0004") ? step.send.slice(0, -1) : step.send + "\n");
      if (step.send.endsWith("\u0004")) await proc.stdin.flush();
    }
    await proc.stdin.flush();
    await Bun.sleep(50);
  }
  // Bun exits by itself once nothing holds it (readline closed, stdin ended or paused).
  await Promise.race([proc.exited, Bun.sleep(5000)]);
  proc.kill();
  await reading;
  void errors;
  return out;
}

let bad = 0;
const check = (label: string, got: string, want: string) => {
  if (got === want) return console.log(`✓ ${label}`);
  bad++;
  console.error(`✗ ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

const expected = new Map<string, string>();
if (!process.argv.includes("--no-native")) {
  const dir = mkdtempSync(join(tmpdir(), "stdin-"));
  try {
    for (const c of cases.filter((c) => !c.playgroundOnly)) {
      const out = await native(c, dir);
      expected.set(c.name, out);
      // The expectation itself must hold what the case promises to end with.
      if (!out.endsWith(c.end)) (bad++, console.error(`✗ native bun ${c.name}: ends ${JSON.stringify(out.slice(-60))}, not ${JSON.stringify(c.end)}`));
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

const files = Object.fromEntries(cases.map((c) => [c.file, c.code]));
const vite = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: app,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-stdin") },
});
// The embedding page, on another origin as a real host is. `out` is what the programs printed, as the embed reports it.
const host = Bun.serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><body><iframe id="f" style="width:900px;height:600px" src="${EDITOR}/embed?init=1&mode=console&autorun=false" allow="cross-origin-isolated"></iframe>
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
      { headers: { "content-type": "text/html", ...(ISOLATED && { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" }) } },
    ),
});
const profile = mkdtempSync(join(tmpdir(), "stdin-chrome-"));
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
    const embed = page.frames().find((f) => f.url().includes("/embed"))!;
    const out = () => page.evaluate(() => (window as any).out as string);
    /** The console's text, rows joined: what the reader sees, typed input included. */
    const screen = () => embed.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((r) => r.textContent ?? "").join("\n").replace(/ /g, " "));
    for (const c of cases) {
      await page.evaluate(() => ((window as any).out = ""));
      await page.evaluate((entry: string) => (window as any).rpc("run", { entry }), c.file);
      let typed = "";
      for (const step of c.steps) {
        // Waits for the program to print what the step is after, then for it to read: Enter before that would be a command.
        await page.waitForFunction((w: string) => (window as any).out.includes(w), { timeout: 15_000 }, step.wait).catch(() => {});
        await Bun.sleep(150);
        await embed.focus(".xterm-helper-textarea");
        if (step.send === null) {
          await page.keyboard.down("Control");
          await page.keyboard.press("KeyD");
          await page.keyboard.up("Control");
        } else if (step.send.endsWith("\u0004")) {
          await page.keyboard.type(step.send.slice(0, -1));
          typed += step.send.slice(0, -1);
          await page.keyboard.down("Control");
          await page.keyboard.press("KeyD");
          await page.keyboard.up("Control");
        } else {
          await page.keyboard.type(step.send + "\n");
          typed += step.send;
        }
        await Bun.sleep(100);
      }
      await page.waitForFunction((e: string) => (window as any).out.endsWith(e), { timeout: 15_000 }, c.end).catch(() => {});
      await Bun.sleep(200);
      const got = await out();
      if (expected.has(c.name)) check(c.name, got, expected.get(c.name)!);
      else check(c.name, got.slice(-c.end.length), c.end);
      // What was typed shows in the console, as a terminal echoes it.
      const shown = await screen();
      const missing = c.steps.flatMap((s) => (s.send ? [s.send.replace(/\u0004$/, "")] : [])).filter((s) => s && !shown.includes(s));
      if (missing.length) (bad++, console.error(`✗ ${c.name}: typed text missing from the console: ${JSON.stringify(missing)}\n${shown}`));
      void typed;
      // Stop whatever still runs (a program that never ends its input), so the next case starts clean.
      await page.evaluate(() => (window as any).rpc("stop"));
    }
    // The prompt and the typed answer are one row, as in a terminal.
    await page.evaluate(() => ((window as any).out = ""));
    await page.evaluate((entry: string) => (window as any).rpc("run", { entry }), "question.ts");
    await page.waitForFunction(() => (window as any).out.includes("Name? "), { timeout: 15_000 });
    await Bun.sleep(150);
    await embed.focus(".xterm-helper-textarea");
    await page.keyboard.type("Zed");
    await Bun.sleep(200);
    const row = (await screen()).split("\n").find((r) => r.includes("Name? "));
    check("typing continues the prompt's row", row?.trimEnd() ?? "", "Name? Zed");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as any).out.includes("Hello Zed"), { timeout: 15_000 });
    // Ctrl+C stops the program, as in a terminal.
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyC");
    await page.keyboard.up("Control");
    await Bun.sleep(300);
    check("Ctrl+C while reading", (await screen()).includes("^C") ? "interrupted" : "not", "interrupted");
    // A program the shell started (the command is running, not just a Run): the same, and the shell is back when it ends.
    await page.evaluate(() => ((window as any).out = ""));
    await page.keyboard.type("bun promises.ts\n");
    await page.waitForFunction(() => (window as any).out.includes("a? "), { timeout: 15_000 });
    await Bun.sleep(150);
    await page.keyboard.type("5\n");
    await page.waitForFunction(() => (window as any).out.includes("b? "), { timeout: 15_000 });
    await Bun.sleep(150);
    await page.keyboard.type("6\n");
    await page.waitForFunction(() => (window as any).out.includes("done"), { timeout: 15_000 }).catch(() => {});
    check("a program started from the shell", await out(), "a? b? 11\ndone\n");
    // With no program reading, the console is the shell again.
    await page.evaluate(() => ((window as any).out = ""));
    await page.keyboard.type("echo shell-still-works\n");
    await page.waitForFunction(() => (window as any).out.includes("shell-still-works"), { timeout: 15_000 }).catch(() => {});
    check("shell without a reading program", (await out()).trim(), "shell-still-works");
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
