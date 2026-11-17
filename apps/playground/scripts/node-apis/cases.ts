// Node modules native Bun implements and the playground emulates, as one program both run (scripts/node-apis.ts
// compares the two). Each line is `label: value`.
import { diagnosticsChannel } from "./diagnostics_channel.ts";
import { sqlite } from "./sqlite.ts";
import { v8Cases } from "./v8.ts";
import { misc } from "./misc.ts";
import module, { createRequire } from "node:module";

export type Case = (label: string, f: () => unknown) => void;

export async function run(log: (line: string) => void) {
  const t: Case = (label, f) => {
    try {
      const v = f();
      log(`${label}: ${typeof v === "string" ? v : typeof v === "bigint" ? `${v}n` : JSON.stringify(v)}`);
    } catch (e) {
      const err = e as Error & { code?: string };
      log(`${label}: threw ${err.name} ${err.message}${err.code ? " " + err.code : ""}`);
    }
  };
  log("start: node apis");
  t("node:test builtin", () => [module.isBuiltin("test"), module.isBuiltin("node:test"), module.builtinModules.includes("node:test"), module.builtinModules.includes("bun:test"), typeof createRequire(import.meta.url)("node:test").mock.fn].join());
  await diagnosticsChannel(t, log);
  await sqlite(t, log);
  v8Cases(t);
  await misc(t, log);
}
