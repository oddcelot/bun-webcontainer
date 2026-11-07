// End-to-end check of the runner: the access checks, native-only Bun APIs, the sandbox, the preview proxy.
//   bun test.ts [secret-file]    secret-file: a file the sandbox must hide (default: this package.json)
import { existsSync, realpathSync } from "node:fs";
import type { ServerMessage } from "./src/protocol.ts";
import { startRunner } from "./src/server.ts";

const ORIGIN = "https://runbun.dev";
const secret = realpathSync(process.argv[2] ?? new URL("./package.json", import.meta.url).pathname);
const escape = `/tmp/runbun-escape-${process.pid}`;
process.env.RUNBUN_TEST_SECRET = "hunter2";
const site = (await import("node:fs")).mkdtempSync("/tmp/runbun-site-");
await Bun.write(`${site}/index.html`, "<!doctype html><title>app</title>");
await Bun.write(`${site}/assets/app.js`, "console.log(1)");
const r = startRunner({ port: 0, playground: site });
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
  return new Promise<{ out: string; err: string; code: number | null; seen: string[] }>((resolve) => {
    const seen: string[] = [];
    let out = "", err = "";
    const on = async (e: MessageEvent) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (!("id" in m) || m.id !== id) return;
      seen.push(m.t);
      if (m.t === "started") await onStart?.(m);
      if (m.t === "out") m.fd === 1 ? (out += m.data) : (err += m.data);
      if (m.t === "error") (err += m.message), resolve({ out, err, code: -1, seen });
      if (m.t === "exit") ws.removeEventListener("message", on), resolve({ out, err, code: m.code, seen });
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
  ws.close();

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
} finally {
  r.stop();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
