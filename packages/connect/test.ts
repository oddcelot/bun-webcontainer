// End-to-end check of the runner: the access checks, native-only Bun APIs, the sandbox, the preview proxy.
//   bun test.ts [secret-file]    secret-file: a file the sandbox must hide (default: this package.json)
import { existsSync, realpathSync } from "node:fs";
import type { ServerMessage } from "./src/protocol.ts";
import { startRunner } from "./src/server.ts";

const ORIGIN = "https://runbun.dev";
const secret = realpathSync(process.argv[2] ?? new URL("./package.json", import.meta.url).pathname);
const escape = `/tmp/runbun-escape-${process.pid}`;
process.env.RUNBUN_TEST_SECRET = "hunter2";
const r = startRunner({ port: 0 });
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

function run(ws: WebSocket, id: string, files: Record<string, string>, onStart?: (m: ServerMessage & { t: "started" }) => void | Promise<void>) {
  return new Promise<{ out: string; err: string; code: number | null }>((resolve) => {
    let out = "", err = "";
    const on = async (e: MessageEvent) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (!("id" in m) || m.id !== id) return;
      if (m.t === "started") await onStart?.(m);
      if (m.t === "out") m.fd === 1 ? (out += m.data) : (err += m.data);
      if (m.t === "error") (err += m.message), resolve({ out, err, code: -1 });
      if (m.t === "exit") ws.removeEventListener("message", on), resolve({ out, err, code: m.code });
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ t: "run", id, files, entry: "index.ts" }));
  });
}

try {
  console.log(`sandbox: ${r.sandbox}, Bun ${Bun.version}, ${process.platform}\n`);

  check("another site's origin is refused", (await connect(r.url, "https://evil.example")) === 0);
  check("a wrong token is refused", (await connect(r.url.replace(/token=\w+/, "token=nope"), ORIGIN)) === 0);
  const rebound = await fetch(`http://127.0.0.1:${port}/ws`, { headers: { host: "evil.example:80" } });
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

  ws.close();
} finally {
  r.stop();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
