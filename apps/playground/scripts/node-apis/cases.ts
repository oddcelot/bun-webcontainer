// Node modules native Bun implements and the playground emulates, as one program both run (scripts/node-apis.ts
// compares the two). Each line is `label: value`.
import { diagnosticsChannel } from "./diagnostics_channel.ts";
import { sqlite } from "./sqlite.ts";
import { v8Cases } from "./v8.ts";
import { misc } from "./misc.ts";
import { wasiCases } from "./wasi.ts";
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
  // node:module's SourceMap: the segment at or before a position on its generated line, or {}.
  const payload = { version: 3, sources: ["a.ts", "b.ts"], names: ["x", "y"], mappings: "IAAA,IAAIA,GCAC;;EDCF,A,KAAKC", sourceRoot: "root/" };
  const map = new module.SourceMap(payload, { lineLengths: [3, 4] });
  t("SourceMap shape", () => [map.payload === payload, map.lineLengths, Object.keys(map), Object.getOwnPropertyNames(module.SourceMap.prototype).sort()]);
  for (const [line, column] of [[0, 0], [0, 3], [0, 4], [0, 7], [0, 8], [0, 11], [0, 99], [1, 0], [2, 0], [2, 2], [2, 3], [2, 7], [2, 50], [3, 0], [-1, 0], [0, -1], [0.5, 4.7]])
    t(`SourceMap findEntry ${line},${column}`, () => map.findEntry(line, column));
  t("SourceMap empty", () => [new module.SourceMap({ version: 3, sources: [], names: [], mappings: "" } as never).findEntry(0, 0), new module.SourceMap({ version: 3, sources: ["a"], mappings: "AAAA" } as never).lineLengths]);
  for (const bad of [undefined, null, "x", {}, { version: 3 }]) t(`SourceMap of ${JSON.stringify(bad)}`, () => new module.SourceMap(bad as never));
  await diagnosticsChannel(t, log);
  await sqlite(t, log);
  v8Cases(t);
  await misc(t, log);
  await wasiCases(t, log);}
