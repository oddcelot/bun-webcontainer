#!/usr/bin/env bun
// Runs the playground and docs dev servers together; Ctrl-C stops both. Usage: scripts/dev.ts
// In dev the docs frame the playground at localhost:5173 (apps/docs/site-urls.ts), so the playground has to get exactly
// that port: it fails instead of moving to another one when something else holds it.
import { $ } from "bun";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const pid = (await $`lsof -tiTCP:5173 -sTCP:LISTEN`.quiet().nothrow().text()).trim().split("\n")[0];
if (pid) {
  const comm = (await $`ps -o comm= -p ${pid}`.quiet().nothrow().text()).trim();
  console.error(`dev.ts: port 5173 is taken (pid ${pid}: ${comm}); stop it first`);
  process.exit(1);
}

const run = (app: string, cmd: string[]) =>
  Bun.spawn(cmd, { cwd: join(root, "apps", app), stdin: "ignore", stdout: "inherit", stderr: "inherit" });
const servers = [run("playground", ["bun", "run", "dev", "--strictPort"]), run("docs", ["bun", "run", "dev"])];
console.log("playground: http://localhost:5173/   configurator: http://localhost:5173/configure");
console.log("docs:       http://localhost:4321/   configurator: http://localhost:4321/guides/configurator/");

// Without a terminal `astro dev` detaches into a background server of its own, which only `astro dev stop` ends.
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await $`bunx astro dev stop`.cwd(join(root, "apps/docs")).quiet().nothrow();
  for (const s of servers) if (s.exitCode === null) s.kill("SIGTERM");
  await Promise.all(servers.map((s) => s.exited));
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await stop();
    process.exit(0);
  });
}
// A server that exits on its own takes the other one down with it.
await Promise.all(servers.map((s) => s.exited));
await stop();
process.exit(0);
