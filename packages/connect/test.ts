// End-to-end check of the runner: the access checks, native-only Bun APIs, the sandbox, the preview proxy.
//   bun test.ts [secret-file]    secret-file: a file the sandbox must hide (default: this package.json)
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { ServerMessage } from "./src/protocol.ts";
import { launch } from "./src/sandbox.ts";
import { startRunner } from "./src/server.ts";

const ORIGIN = "https://runbun.dev";
const secret = realpathSync(process.argv[2] ?? new URL("./package.json", import.meta.url).pathname);
const escape = `/tmp/runbun-escape-${process.pid}`;
process.env.RUNBUN_TEST_SECRET = "hunter2";
const site = (await import("node:fs")).mkdtempSync("/tmp/runbun-site-");
await Bun.write(`${site}/index.html`, "<!doctype html><title>app</title>");
await Bun.write(`${site}/assets/app.js`, "console.log(1)");
const r = startRunner({ port: 0, playground: site, limits: { memoryMB: 512, processes: 16 } });
const port = r.server.port;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? `\n     ${detail}` : ""}`);
  if (!ok) failed++;
};

function connect(url: string, origin: string): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    // @ts-expect-error Bun's WebSocket takes headers
    const ws = new WebSocket(url, { headers: { origin } });
    ws.onopen = () => resolve(ws);
    ws.onerror = () => resolve(0);
  });
}

function run(ws: WebSocket, id: string, files: Record<string, string>, onStart?: (m: ServerMessage & { t: "started" }) => void | Promise<void>, extra: object = {}) {
  return new Promise<{ out: string; err: string; code: number | null; seen: string[]; files: { path: string; text: string }[] }>((resolve) => {
    const seen: string[] = [];
    const got: { path: string; text: string }[] = [];
    let out = "", err = "";
    const on = async (e: MessageEvent) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (!("id" in m) || m.id !== id) return;
      seen.push(m.t);
      if (m.t === "started") await onStart?.(m);
      if (m.t === "out") m.fd === 1 ? (out += m.data) : (err += m.data);
      if (m.t === "files") got.push(...m.files);
      if (m.t === "error") (err += m.message), resolve({ out, err, code: -1, seen, files: got });
      if (m.t === "exit") ws.removeEventListener("message", on), resolve({ out, err, code: m.code, seen, files: got });
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ t: "run", id, files, entry: "index.ts", ...extra }));
  });
}

try {
  console.log(`sandbox: ${r.sandbox}, Bun ${Bun.version}, ${process.platform}\n`);

  check("another site's origin is refused", (await connect(r.url, "https://evil.example")) === 0);
  check("a wrong token is refused", (await connect(r.url.replace(/token=\w+/, "token=nope"), ORIGIN)) === 0);
  const rebound = await fetch(`http://127.0.0.1:${port}/__connect/ws`, { headers: { host: "evil.example:80" } });
  check("a non-loopback Host is refused (DNS rebinding)", rebound.status === 421);

  const ws = (await connect(r.url, ORIGIN)) as WebSocket;
  check("runbun.dev with the token connects", typeof ws === "object");
  const hello = await new Promise<ServerMessage>((res) => (ws.onmessage = (e) => res(JSON.parse(e.data))));
  check("hello reports the sandbox", hello.t === "hello" && hello.sandbox === r.sandbox);
  check("hello lists the snapshots feature", hello.t === "hello" && !!hello.features?.includes("snapshots"));

  // Native-only: processes, FFI, the real runtime.
  const native = await run(ws, "native", {
    "index.ts": `
      import { execSync } from "node:child_process";
      import { dlopen, FFIType, suffix } from "bun:ffi";
      const lib = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
      const { symbols } = dlopen(lib, { getpid: { returns: FFIType.i32 } });
      const spawned = await new Response(Bun.spawn(["echo", "spawned"]).stdout).text();
      console.log(JSON.stringify({
        bun: Bun.version, spawned: spawned.trim(), exec: execSync("echo exec").toString().trim(),
        ffiPid: symbols.getpid() === process.pid, env: Object.keys(process.env).sort(),
      }));
    `,
  });
  const n = JSON.parse(native.out || "{}");
  check("real Bun runs the code", n.bun === Bun.version, native.err);
  check("Bun.spawn works", n.spawned === "spawned", native.err);
  check("node:child_process works", n.exec === "exec", native.err);
  check("bun:ffi works", n.ffiPid === true, native.err);
  check("the user's env doesn't leak in", !n.env.includes("RUNBUN_TEST_SECRET") && n.env.every((k: string) => !/token|key|secret/i.test(k)), JSON.stringify(n.env));

  // The project's env (runbun.json): its own names reach the program, the runner's and the loader's don't.
  const envRun = await run(
    ws,
    "env",
    { "index.ts": `console.log(JSON.stringify({ greeting: process.env.GREETING, path: process.env.PATH, preload: process.env.LD_PRELOAD ?? process.env.DYLD_INSERT_LIBRARIES ?? null }))` },
    undefined,
    { env: { GREETING: "hi", PATH: "/nowhere", LD_PRELOAD: "/x.so", DYLD_INSERT_LIBRARIES: "/x.dylib", "BAD-NAME": "x" } },
  );
  const e = JSON.parse(envRun.out || "{}");
  check("runbun.json's env reaches the program", e.greeting === "hi", envRun.err);
  check("it can't replace the runner's or the loader's", e.path !== "/nowhere" && e.preload === null && /env left out: PATH, LD_PRELOAD, DYLD_INSERT_LIBRARIES, BAD-NAME/.test(envRun.err), envRun.err);

  // …set inside the sandbox: its launcher (bwrap, sandbox-exec) gets the runner's env alone.
  const runnerEnv = { PATH: "/usr/bin:/bin", HOME: "/p" };
  const proj = { GREETING: "hi" };
  const bw = launch("bwrap", "/p", ["run", "index.ts"], [], undefined, runnerEnv, proj);
  const sx = launch("sandbox-exec", "/p", ["run", "index.ts"], [], 1, runnerEnv, proj);
  const none = launch("none", "/p", ["run", "index.ts"], [], undefined, runnerEnv, { ...proj, HOME: "/elsewhere" });
  check("bwrap: the project's env is --setenv, not the launcher's", !("GREETING" in bw.env) && bw.argv.join(" ").includes("--setenv GREETING hi"), JSON.stringify(bw));
  check(
    "sandbox-exec: the project's env goes through env(1) under the profile, not to the launcher",
    !("GREETING" in sx.env) && sx.argv[3] === "/usr/bin/env" && sx.argv[4] === "GREETING=hi",
    JSON.stringify(sx.argv.slice(3)),
  );
  check("no sandbox: the project's env goes to Bun, the runner's names winning", none.env.GREETING === "hi" && none.env.HOME === "/p", JSON.stringify(none.env));

  // Snapshots: `updateSnapshots` adds --update-snapshots and the changed files come back in a `files` message.
  const snapTest = `import { expect, test } from "bun:test";
    test("snaps", () => {
      expect({ a: 1 }).toMatchSnapshot();
      expect(1 + 1).toMatchInlineSnapshot();
    });`;
  const snapRun = (id: string, files: Record<string, string>, extra: object) => run(ws, id, files, undefined, { entry: "", test: ["a.test.ts"], ...extra });
  const byPath = (r: { files: { path: string; text: string }[] }) => Object.fromEntries(r.files.map((f) => [f.path, f.text]));
  const snapFirst = await snapRun("snap1", { "a.test.ts": snapTest }, { updateSnapshots: true });
  const f1 = byPath(snapFirst);
  check("a snapshot test's new .snap comes back", /exports\[`snaps 1`\]/.test(f1["__snapshots__/a.test.ts.snap"] ?? ""), snapFirst.err + JSON.stringify(f1));
  check("an inline snapshot comes back in its test file", /toMatchInlineSnapshot\(`?2`?\)/.test(f1["a.test.ts"] ?? ""), JSON.stringify(f1));
  check("`files` comes before `exit`", snapFirst.seen.indexOf("files") >= 0 && snapFirst.seen.indexOf("files") < snapFirst.seen.indexOf("exit"), snapFirst.seen.join());
  const snapText = f1["__snapshots__/a.test.ts.snap"] ?? "";
  const stale = await snapRun("snap2", { "a.test.ts": f1["a.test.ts"] ?? snapTest, "__snapshots__/a.test.ts.snap": snapText.replace(`"a": 1`, `"a": 9`) }, { updateSnapshots: true });
  check("--update-snapshots rewrites a stale .snap", byPath(stale)["__snapshots__/a.test.ts.snap"] === snapText && stale.code === 0, stale.err + stale.out);
  const kept = await snapRun("snap3", { "a.test.ts": f1["a.test.ts"] ?? snapTest, "__snapshots__/a.test.ts.snap": snapText.replace(`"a": 1`, `"a": 9`) }, { updateSnapshots: false });
  check("without it a stale .snap fails and nothing comes back", kept.code !== 0 && !kept.seen.includes("files"), kept.err);
  const same = await snapRun("snap4", { "a.test.ts": f1["a.test.ts"] ?? snapTest, "__snapshots__/a.test.ts.snap": snapText }, { updateSnapshots: true });
  check("nothing changed, no `files`", same.code === 0 && !same.seen.includes("files"), same.err + same.seen.join());
  const created = await snapRun("snap5", { "a.test.ts": f1["a.test.ts"] ?? snapTest }, { updateSnapshots: false });
  check("a new snapshot is written without -u and comes back", !!byPath(created)["__snapshots__/a.test.ts.snap"], created.err + created.out);
  const old = await snapRun("snap6", { "a.test.ts": f1["a.test.ts"] ?? snapTest }, {});
  check("a page that doesn't ask (old pages) gets no `files`", old.code === 0 && !old.seen.includes("files"), old.seen.join());

  // Coverage: the flags go to `bun test`, the lcov.info comes back; bunfig.toml's options work as they come with the files.
  const covFiles = {
    "m.ts": "export const used = () => 1;\nexport function unused() {\n  return 2;\n}\n",
    "m.test.ts": `import { expect, test } from "bun:test";\nimport { used } from "./m";\ntest("c", () => expect(used()).toBe(1));\n`,
  };
  const covRun = (id: string, files: Record<string, string>, extra: object) => run(ws, id, files, undefined, { entry: "", test: ["m.test.ts"], updateSnapshots: false, ...extra });
  const cov = await covRun("cov1", covFiles, { coverage: ["--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", "--coverage-dir=out/cov"], lcov: "out/cov/lcov.info" });
  const lcovText = byPath(cov)["out/cov/lcov.info"] ?? "";
  check("hello lists the coverage feature", hello.t === "hello" && !!hello.features?.includes("coverage"));
  check("--coverage prints Bun's table", /File +\| % Funcs \| % Lines/.test(cov.out + cov.err) && /m\.ts +\| +50\.00/.test(cov.out + cov.err), cov.out + cov.err);
  check("the lcov.info comes back", cov.code === 0 && /^SF:m\.ts$/m.test(lcovText) && /^FNH:1$/m.test(lcovText), cov.err + JSON.stringify(byPath(cov)));
  const covBunfig = await covRun("cov2", { ...covFiles, "bunfig.toml": `[test]\ncoverage = true\ncoverageReporter = ["lcov"]\ncoverageThreshold = 0.9\n` }, { lcov: "coverage/lcov.info" });
  check("bunfig.toml's coverage options apply; its threshold fails the run", covBunfig.code === 1 && /^SF:m\.ts$/m.test(byPath(covBunfig)["coverage/lcov.info"] ?? ""), covBunfig.err + covBunfig.seen.join());
  const covBad = await covRun("cov3", covFiles, { coverage: ["--coverage-dir=../out"] });
  check("a coverage dir outside the project is refused", covBad.code === -1 && /bad coverage flag/.test(covBad.err), covBad.err);
  const covBadLcov = await covRun("cov4", covFiles, { coverage: ["--coverage"], lcov: "m.ts" });
  check("only an lcov.info is asked back", covBadLcov.code === -1 && /bad lcov path/.test(covBadLcov.err), covBadLcov.err);

  // The program under test is untrusted: what it writes outside the allowlist, over a link or past the caps stays here.
  const snapEvil = await snapRun(
    "snapevil",
    {
      "a.test.ts": `import { expect, test } from "bun:test";
        import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
        test("evil", () => {
          const t = (f: () => void) => { try { f(); } catch {} };
          mkdirSync("__snapshots__", { recursive: true });
          mkdirSync("linked", { recursive: true });
          t(() => writeFileSync("../x", "outside"));
          t(() => writeFileSync("notes.txt", "not allowlisted"));
          t(() => writeFileSync("src.ts", "not a test file"));
          t(() => writeFileSync("other.test.ts", "a test file the run didn't list"));
          t(() => writeFileSync("__snapshots__/ok.snap", "// good"));
          t(() => writeFileSync("__snapshots__/big.snap", "x".repeat(2 * 1024 * 1024)));
          t(() => writeFileSync("__snapshots__/binary.snap", Buffer.from([0xff, 0xfe, 0x00])));
          t(() => writeFileSync("__snapshots__/a.txt", "wrong extension"));
          t(() => writeFileSync("__snapshots__/sub.snap.d", "no"));
          t(() => symlinkSync(${JSON.stringify(secret)}, "__snapshots__/link.snap"));
          t(() => mkdirSync("deep/__snapshots__", { recursive: true }));
          t(() => symlinkSync(${JSON.stringify(secret)}, "deep/__snapshots__/link2.snap"));
          t(() => symlinkSync("..", "linked/__snapshots__"));
          t(() => writeFileSync("node_modules_x.snap", "no"));
          t(() => mkdirSync("node_modules/p/__snapshots__", { recursive: true }));
          t(() => writeFileSync("node_modules/p/__snapshots__/p.snap", "no"));
          expect(1).toBe(1);
        });`,
      "other.test.ts": "// the page's text",
      "src.ts": "// the page's text",
    },
    { updateSnapshots: true },
  );
  const ev = byPath(snapEvil);
  check("a test's own good .snap still comes back", ev["__snapshots__/ok.snap"] === "// good", snapEvil.err + JSON.stringify(Object.keys(ev)));
  check("../x, other files, an unlisted test file and node_modules don't", Object.keys(ev).every((p) => ["__snapshots__/ok.snap"].includes(p)), JSON.stringify(Object.keys(ev)));
  check("a symlinked .snap isn't read through", !("__snapshots__/link.snap" in ev) && !("deep/__snapshots__/link2.snap" in ev) && !JSON.stringify(ev).includes("hunter2"), snapEvil.err);
  check("an oversized or binary .snap stays behind, with a note", !("__snapshots__/big.snap" in ev) && !("__snapshots__/binary.snap" in ev) && /big\.snap \(over/.test(snapEvil.err) && /binary\.snap \(not text/.test(snapEvil.err), snapEvil.err);

  // The sandbox: the secret is unreadable, nothing outside the project lands on the host.
  const jail = await run(ws, "jail", {
    "index.ts": `
      import { readFileSync, writeFileSync } from "node:fs";
      const t = (f: () => unknown) => { try { f(); return "allowed"; } catch (e: any) { return e.code ?? String(e); } };
      console.log(JSON.stringify({
        readSecret: t(() => readFileSync(${JSON.stringify(secret)})),
        writeOutside: t(() => writeFileSync(${JSON.stringify(escape)}, "x")),
        writeProject: t(() => writeFileSync("out.txt", "x")),
      }));
    `,
  });
  const j = JSON.parse(jail.out || "{}");
  const confined = r.sandbox !== "none";
  check(`the secret is ${confined ? "hidden" : "readable (no sandbox)"}`, confined ? j.readSecret !== "allowed" : j.readSecret === "allowed", JSON.stringify(j) + jail.err);
  check(`writing outside the project ${confined ? "doesn't reach" : "reaches"} the host`, confined !== existsSync(escape), JSON.stringify(j));
  check("writing inside the project works", j.writeProject === "allowed", JSON.stringify(j) + jail.err);

  // The runner's own port (it serves the token at /__connect/info) is closed to the program where the sandbox can do that.
  const reach = await run(ws, "reach", {
    "index.ts": `const t = async (h: string) => fetch("http://" + h + ":${port}/__connect/info").then((r) => r.status, () => "blocked");
      console.log(JSON.stringify([await t("127.0.0.1"), await t("localhost"), await t("[::1]")]));`,
  });
  const reached = JSON.parse(reach.out.trim().split("\n").at(-1) || "[]") as unknown[];
  if (r.sandbox === "sandbox-exec") check("the program can't reach the runner's port", reached.length === 3 && reached.every((x) => x === "blocked"), reach.out + reach.err);
  // bwrap shares the network, so the port answers; the peer check (peer.ts) turns the program away instead.
  else if (r.sandbox === "bwrap") check("the program gets no token from the runner's port", reached.length === 3 && reached.every((x) => x === 403 || x === "blocked") && reached.includes(403), reach.out + reach.err);
  else console.log(`skip the runner's port is closed to the program (${r.sandbox}: no sandbox)`);

  // …while another process on this machine (the browser) still gets the token and connects with a run alive, which
  // is when the peer check runs.
  const probe = `
    const info = await fetch("http://127.0.0.1:${port}/__connect/info").then((r) => r.status, () => "error");
    const ws = await new Promise((res) => {
      const w = new WebSocket(${JSON.stringify(r.url)}, { headers: { origin: ${JSON.stringify(ORIGIN)} } });
      w.onopen = () => (w.close(), res("open"));
      w.onerror = () => res("error");
    });
    console.log(JSON.stringify({ info, ws }));`;
  let host: { info?: unknown; ws?: unknown } = {};
  await run(ws, "alive", { "index.ts": `console.log("up"); await Bun.sleep(60000);` }, async () => {
    const p = Bun.spawn([process.execPath, "-e", probe], { stdout: "pipe", stderr: "inherit" });
    host = JSON.parse((await new Response(p.stdout).text()).trim() || "{}");
    ws.send(JSON.stringify({ t: "kill", id: "alive" }));
  });
  check("another process gets the token and connects while a run is alive", host.info === 200 && host.ws === "open", JSON.stringify(host));

  // macOS: no launching apps outside the sandbox through LaunchServices (`open note.txt` would start TextEdit).
  if (r.sandbox === "sandbox-exec") {
    const opened = await run(ws, "open", {
      "index.ts": `try { const p = Bun.spawnSync(["/usr/bin/open", "note.txt"]); console.log(JSON.stringify({ code: p.exitCode })); } catch (e: any) { console.log(JSON.stringify({ threw: e.code })); }`,
      "note.txt": "hi",
    });
    const o = JSON.parse(opened.out.trim().split("\n").at(-1) || "{}");
    check("open can't launch an app from the sandbox", o.threw === "EPERM" || (typeof o.code === "number" && o.code !== 0), opened.out + opened.err);
  }

  // Bun.serve in the run, reached through the runner's preview proxy.
  let body = "";
  const served = await run(
    ws,
    "serve",
    { "index.ts": `const s = Bun.serve({ fetch: (req) => new Response("hi from " + Bun.version + " " + new URL(req.url).pathname) }); console.log("listening");` },
    async (m) => {
      for (let i = 0; i < 50 && !body; i++) {
        await Bun.sleep(100);
        body = await fetch(m.preview + "x?y=1").then((r) => (r.ok ? r.text() : ""), () => "");
      }
      ws.send(JSON.stringify({ t: "kill", id: "serve" }));
    },
  );
  check("Bun.serve answers through the preview proxy", body === `hi from ${Bun.version} /x`, body + served.err);

  // stdin
  const echo = run(ws, "stdin", { "index.ts": `for await (const line of console) { console.log("got " + line); break; }` });
  await Bun.sleep(300);
  ws.send(JSON.stringify({ t: "stdin", id: "stdin", data: "ping\n" }));
  check("stdin reaches the run", (await echo).out.trim() === "got ping", (await echo).err);

  // A project's runs share a directory: `bun install` before the run, node_modules kept, stale files removed.
  const dep = { "package.json": JSON.stringify({ dependencies: { ms: "2.1.3" } }) };
  const first = await run(ws, "dep1", { ...dep, "stale.txt": "x", "index.ts": `import ms from "ms"; console.log(ms(60000));` }, undefined, { project: "p1" });
  check("bun install runs before the run", first.out.trim().endsWith("1m"), first.out + first.err);
  const second = await run(
    ws,
    "dep2",
    { ...dep, "index.ts": `import { existsSync } from "node:fs"; console.log(JSON.stringify({ stale: existsSync("stale.txt"), nm: existsSync("node_modules/ms") }));` },
    undefined,
    { project: "p1" },
  );
  const s2 = JSON.parse(second.out.trim().split("\n").at(-1) || "{}");
  check("the project keeps node_modules and drops stale files", s2.nm === true && s2.stale === false, second.out + second.err);
  // The runner writes and deletes outside the sandbox: a symlink the program planted must not redirect that.
  const victim = `/tmp/runbun-victim-${process.pid}`;
  mkdirSync(victim, { recursive: true });
  writeFileSync(`${victim}/file`, "orig");
  writeFileSync(`${victim}/stale.txt`, "keep");
  await run(
    ws,
    "link1",
    {
      "index.ts": `import { rmSync, symlinkSync } from "node:fs";
        symlinkSync(${JSON.stringify(`${victim}/file`)}, "lnk");
        rmSync("d", { recursive: true }); symlinkSync(${JSON.stringify(victim)}, "d");`,
      "d/stale.txt": "x",
    },
    undefined,
    { project: "links" },
  );
  const viaFile = await run(ws, "link2", { "index.ts": `console.log("ran")`, "d/stale.txt": "x", lnk: "pwned" }, undefined, { project: "links" });
  check("a symlinked file isn't written through", readFileSync(`${victim}/file`, "utf8") === "orig" && /symlink/.test(viaFile.err) && !viaFile.out, JSON.stringify(viaFile));
  const viaDir = await run(ws, "link3", { "index.ts": `console.log("ran")`, lnk: "x" }, undefined, { project: "links" });
  check("a symlinked directory isn't deleted through", existsSync(`${victim}/stale.txt`) && /symlink/.test(viaDir.err) && !viaDir.out, JSON.stringify(viaDir));
  rmSync(victim, { recursive: true, force: true });
  // The install cache is per project: a run can write its own, not another project's.
  await run(ws, "cache-b", { "index.ts": `import { writeFileSync } from "node:fs"; writeFileSync(process.env.BUN_INSTALL_CACHE_DIR + "/marker", "b")` }, undefined, { project: "cache-b" });
  const cached = await run(
    ws,
    "cache-a",
    {
      "index.ts": `import { dirname, join } from "node:path"; import { existsSync, writeFileSync } from "node:fs";
        const mine = process.env.BUN_INSTALL_CACHE_DIR!;
        const t = (f: () => unknown) => { try { f(); return "allowed"; } catch (e: any) { return e.code ?? String(e); } };
        console.log(JSON.stringify({ sees: existsSync(join(mine, "marker")), own: t(() => writeFileSync(join(mine, "x"), "1")), other: t(() => writeFileSync(join(dirname(mine), "cache-b", "planted"), "1")) }));`,
    },
    undefined,
    { project: "cache-a" },
  );
  const c = JSON.parse(cached.out.trim().split("\n").at(-1) || "{}");
  check(
    `one project can't write another's install cache`,
    c.own === "allowed" && c.sees === false && (r.sandbox === "none" ? c.other === "allowed" : c.other !== "allowed"),
    cached.out + cached.err,
  );
  const bin = await run(ws, "bin", { "index.ts": `console.log([...new Uint8Array(await Bun.file("b.bin").arrayBuffer())].join())`, "b.bin": { b64: "AAEC/w==" } } as any);
  check("binary files arrive intact", bin.out.trim() === "0,1,2,255", bin.out + bin.err);
  const tests = await run(ws, "tests", { "a.test.ts": `import { test, expect } from "bun:test"; test("ok", () => expect(1).toBe(1)); test("no", () => expect(1).toBe(2));` }, undefined, { entry: "", test: ["a.test.ts"] });
  check("bun test runs the files", tests.code === 1 && /1 pass/.test(tests.err + tests.out) && /1 fail/.test(tests.err + tests.out), tests.out + tests.err);
  const only = await run(ws, "install-only", dep, undefined, { entry: "", project: "p1" });
  check("an empty entry only installs", only.code === 0 && !only.seen.includes("started"), JSON.stringify(only));
  const up = await run(ws, "up", { "index.ts": `await Bun.sleep(300); Bun.serve({ fetch: () => new Response("up") }); console.log("serving");` }, (m) => {
    setTimeout(() => ws.send(JSON.stringify({ t: "kill", id: "up" })), 1500);
  });
  check("listening comes once Bun.serve is up", up.seen.includes("listening"), JSON.stringify(up.seen));
  // A program that picks its own port (Elysia's `.listen(3000)`): the preview finds it.
  let ownPort = "";
  const pick = new Promise<void>((resolve) => {
    let preview = "";
    const on = async (e: MessageEvent) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (!("id" in m) || m.id !== "own-port") return;
      if (m.t === "started") preview = m.preview;
      if (m.t === "listening") {
        ownPort = await fetch(preview).then((r) => r.text());
        ws.send(JSON.stringify({ t: "kill", id: "own-port" }));
      }
      if (m.t === "exit") ws.removeEventListener("message", on), resolve();
    };
    ws.addEventListener("message", on);
  });
  ws.send(JSON.stringify({ t: "run", id: "own-port", files: { "index.ts": `Bun.serve({ port: 0, fetch: () => new Response("own port") });` }, entry: "index.ts" }));
  await pick;
  check("the preview finds a port the program chose itself", ownPort === "own port", ownPort);
  const script = await run(ws, "script", { "index.ts": `console.log("done")` });
  check("a program that doesn't serve never says listening", !script.seen.includes("listening") && script.code === 0, JSON.stringify(script.seen));

  // The limits (this runner: 512 MB, 16 processes), and Stop taking the program's children with it.
  const leftover = async (marker: string) => (await Bun.$`ps -A -o command=`.text()).split("\n").filter((l) => l.startsWith(`sleep ${marker}`)).length;
  const hog = await run(ws, "hog", { "index.ts": `const a = []; for (;;) { a.push(new Uint8Array(1 << 24).fill(1)); await Bun.sleep(5); }` });
  check("a program over the memory limit is stopped", /stopped: the program used more than 512 MB/.test(hog.err) && hog.code !== 0, hog.err.slice(-300));
  const forks = await run(ws, "forks", { "index.ts": `for (let i = 0; i < 40; i++) Bun.spawn(["sleep", "31.${process.pid}"]); await Bun.sleep(60000);` });
  check("a program over the process limit is stopped", /more than 16 processes/.test(forks.err), forks.err.slice(-300));
  await Bun.sleep(300);
  check("…with all its processes", (await leftover(`31.${process.pid}`)) === 0);
  const kids = await run(ws, "kids", { "index.ts": `for (let i = 0; i < 3; i++) Bun.spawn(["sleep", "32.${process.pid}"]); console.log("up"); await Bun.sleep(60000);` }, () => {
    setTimeout(() => ws.send(JSON.stringify({ t: "kill", id: "kids" })), 800);
  });
  await Bun.sleep(300);
  check("Stop ends the program's child processes too", kids.out.includes("up") && (await leftover(`32.${process.pid}`)) === 0, kids.out + kids.err);
  ws.close();

  // Approval: asked once per page (connection), before its first run; a refused page runs nothing.
  const asked: string[] = [];
  let allow = true;
  let hold: Promise<void> | undefined;
  const gated = startRunner({
    port: 0,
    approve: async (req) => {
      asked.push(req.entry);
      await hold;
      return allow;
    },
  });
  try {
    const page1 = (await connect(gated.url, ORIGIN)) as WebSocket;
    await new Promise((res) => (page1.onmessage = res));
    const a = await run(page1, "a1", { "index.ts": `console.log("one")` });
    const b = await run(page1, "a2", { "index.ts": `console.log("two")` });
    check("a page is asked about once, before its first run", asked.length === 1 && a.seen.includes("phase") && a.out.trim() === "one" && b.out.trim() === "two", JSON.stringify({ asked, a, b }));
    page1.close();

    allow = false;
    const page2 = (await connect(gated.url, ORIGIN)) as WebSocket;
    await new Promise((res) => (page2.onmessage = res));
    const refused = await run(page2, "r1", { "index.ts": `console.log("should not run")` });
    const again = await run(page2, "r2", { "index.ts": `console.log("should not run")` });
    check("a refused page runs nothing, and isn't asked again", !refused.out && /not allowed/.test(refused.err) && !again.out && asked.length === 2, JSON.stringify({ asked, refused, again }));
    page2.close();

    allow = true;
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    const page3 = (await connect(gated.url, ORIGIN)) as WebSocket;
    await new Promise((res) => (page3.onmessage = res));
    const waiting = run(page3, "w1", { "index.ts": `console.log("should not run")` });
    await Bun.sleep(100);
    page3.send(JSON.stringify({ t: "kill", id: "w1" }));
    // The kill crosses the socket before the answer (in one process, release() would win the race).
    await Bun.sleep(50);
    release();
    const stopped = await waiting;
    check("Stop while waiting for the answer: the run never starts", !stopped.out && !stopped.seen.includes("started"), JSON.stringify(stopped));
    page3.close();
  } finally {
    gated.stop();
  }

  // The playground, served from the runner.
  const page = await fetch(`http://127.0.0.1:${port}/`);
  check("the playground is served, cross-origin isolated", (await page.text()).includes("<title>app") && page.headers.get("cross-origin-embedder-policy") === "credentialless" && page.headers.get("cross-origin-opener-policy") === "same-origin");
  check("app routes fall back to index.html", (await (await fetch(`http://127.0.0.1:${port}/some/route?x=1`)).text()).includes("<title>app"));
  check("a missing asset is a 404", (await fetch(`http://127.0.0.1:${port}/assets/missing.js`)).status === 404);
  const info = await fetch(`http://localhost:${port}/__connect/info`, { headers: { "sec-fetch-site": "same-origin" } }).then((r) => r.json() as any);
  check("a same-origin page gets the token", info.token === r.token && info.ws.includes("/__connect/ws"));
  check("a cross-site page doesn't", (await fetch(`http://localhost:${port}/__connect/info`, { headers: { "sec-fetch-site": "cross-site" } })).status === 403);
  const own = await connect(info.ws, `http://localhost:${port}`);
  check("the runner's own origin connects", typeof own === "object");
  if (typeof own === "object") own.close();

  // Proxying a playground URL: `//host/x` must not replace the upstream's host (an off-host fetch from the runner).
  const evil = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("EVIL") });
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response("upstream " + new URL(req.url).pathname) });
  const proxied = startRunner({ port: 0, playground: `http://127.0.0.1:${upstream.port}` });
  try {
    const raw = async (path: string) => {
      let data = "";
      let done!: () => void;
      const closed = new Promise<void>((res) => (done = res));
      const sock = await Bun.connect({
        hostname: "127.0.0.1",
        port: proxied.server.port!,
        socket: {
          open: (s) => void s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${proxied.server.port}\r\nConnection: close\r\n\r\n`),
          data: (_s, d) => void (data += d.toString()),
          close: () => done(),
          error: () => done(),
        },
      });
      await Promise.race([closed, Bun.sleep(3000)]);
      sock.end();
      return data;
    };
    const ok = await raw("/x");
    check("a proxied playground serves the upstream", ok.includes("upstream /x"), ok);
    const off = await raw(`//127.0.0.1:${evil.port}/x`);
    check("a `//host/x` path doesn't reach another host", !off.includes("EVIL"), off);
  } finally {
    proxied.stop();
    upstream.stop(true);
    evil.stop(true);
  }
} finally {
  r.stop();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
