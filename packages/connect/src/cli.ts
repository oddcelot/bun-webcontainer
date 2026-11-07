#!/usr/bin/env bun
// bunx @runbun/connect [--open] [--port 7357] [--playground https://runbun.dev | ./dist] [--allow-origin <origin>]...
//                      [--no-sandbox]
//
// --open serves the playground from the runner (http://localhost:<port>/) and opens it. That's the way that
// works in every browser: Safari won't let an https page reach http://localhost, and Chrome asks for
// local-network permission; a page on localhost talking to its own origin needs neither.
import { parseArgs } from "node:util";
import { detectSandbox } from "./sandbox.ts";
import { DEFAULT_ORIGINS, startRunner } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "7357" },
    open: { type: "boolean", default: false },
    "no-playground": { type: "boolean", default: false },
    playground: { type: "string", default: "https://runbun.dev" },
    "allow-origin": { type: "string", multiple: true, default: [] },
    "no-sandbox": { type: "boolean", default: false },
  },
});

// Code from a web page runs here: without a sandbox it could read and change everything the user can, so that takes
// asking for it by name.
const sandbox = values["no-sandbox"] ? "none" : detectSandbox();
if (sandbox === "none" && !values["no-sandbox"]) {
  const how =
    process.platform === "linux"
      ? "Install bubblewrap (apt install bubblewrap, dnf install bubblewrap, pacman -S bubblewrap)"
      : process.platform === "darwin"
        ? "sandbox-exec is missing from this Mac"
        : `There is no sandbox for ${process.platform} yet`;
  console.error(`runbun connect: no sandbox to run code in. ${how}.
To run code from the playground with all your user's rights anyway, start with --no-sandbox.`);
  process.exit(1);
}

const r = startRunner({
  sandbox,
  port: Number(values.port),
  origins: [...DEFAULT_ORIGINS, ...values["allow-origin"]!],
  playground: values["no-playground"] ? undefined : values.playground,
});
console.log(`runbun connect: Bun ${Bun.version}, sandbox: ${r.sandbox}`);
if (r.sandbox === "none") console.warn("warning: no sandbox (--no-sandbox): code from the playground runs with all your user's rights");
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
