#!/usr/bin/env bun
// bunx @runbun/connect [--port 7357] [--allow-origin https://example.com]...
import { parseArgs } from "node:util";
import { DEFAULT_ORIGINS, startRunner } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "7357" },
    "allow-origin": { type: "string", multiple: true, default: [] },
  },
});

const r = startRunner({ port: Number(values.port), origins: [...DEFAULT_ORIGINS, ...values["allow-origin"]!] });
console.log(`runbun connect: Bun ${Bun.version}, sandbox: ${r.sandbox}`);
console.log(`connect from the playground with:\n  ${r.url}`);
process.on("SIGINT", () => {
  r.stop();
  process.exit(0);
});
