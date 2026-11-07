#!/usr/bin/env bun
// bunx @runbun/connect [--open] [--port 7357] [--playground https://runbun.dev | ./dist] [--allow-origin <origin>]...
//
// --open serves the playground from the runner (http://localhost:<port>/) and opens it. That's the way that
// works in every browser: Safari won't let an https page reach http://localhost, and Chrome asks for
// local-network permission; a page on localhost talking to its own origin needs neither.
import { parseArgs } from "node:util";
import { DEFAULT_ORIGINS, startRunner } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "7357" },
    open: { type: "boolean", default: false },
    "no-playground": { type: "boolean", default: false },
    playground: { type: "string", default: "https://runbun.dev" },
    "allow-origin": { type: "string", multiple: true, default: [] },
  },
});

const r = startRunner({
  port: Number(values.port),
  origins: [...DEFAULT_ORIGINS, ...values["allow-origin"]!],
  playground: values["no-playground"] ? undefined : values.playground,
});
console.log(`runbun connect: Bun ${Bun.version}, sandbox: ${r.sandbox}`);
if (!values["no-playground"]) console.log(`playground (${values.playground}) at:\n  ${r.open}`);
console.log(`from runbun.dev in Chrome or Firefox:\n  https://runbun.dev/?connect=${encodeURIComponent(r.url)}`);
if (values.open) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  Bun.spawn([opener, r.open]);
}
process.on("SIGINT", () => {
  r.stop();
  process.exit(0);
});
