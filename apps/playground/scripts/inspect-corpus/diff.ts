#!/usr/bin/env bun
// Compares the playground's console/inspect formatting with native Bun on the values in cases.ts.
//
//   bun scripts/inspect-corpus/diff.ts            # native bun vs src/worker/inspect.ts (+ node/util.ts); exits 1 on a mismatch
//   bun scripts/inspect-corpus/diff.ts --native   # what native bun prints (the reference)
//   bun scripts/inspect-corpus/diff.ts --link URL # a #code= link that prints the corpus in the playground at URL
//   bun scripts/inspect-corpus/diff.ts --compare FILE  # FILE: the playground console pane's text, against native bun
//
// Each case prints console.log(...args), and Bun.inspect (plain, colors as JSON, compact) and util.inspect of args[0].
// The console methods (group, dir, table…) are compared in the playground only (--link, then --compare).
// KNOWN lists the sections that differ on purpose (see the reasons); they're reported but don't fail.
import { readFileSync } from "node:fs";
import { inspect as nativeUtilInspect } from "node:util";
import { cases } from "./cases";

const KINDS = ["log", "inspect", "colors", "compact", "util", "console"] as const;
type Kind = (typeof KINDS)[number];
type Inspect = (v: unknown, o?: object) => string;

const KNOWN: Record<string, string> = {
  "promise resolved :: log": "a promise's state can't be read synchronously in the browser",
  "promise resolved :: inspect": "a promise's state can't be read synchronously in the browser",
  "promise resolved :: colors": "a promise's state can't be read synchronously in the browser",
  "promise resolved :: compact": "a promise's state can't be read synchronously in the browser",
  "symbol keys :: log": "Bun lists keys in insertion order across strings and symbols; JS only exposes strings first",
  "symbol keys :: inspect": "Bun lists keys in insertion order across strings and symbols; JS only exposes strings first",
  "symbol keys :: colors": "Bun lists keys in insertion order across strings and symbols; JS only exposes strings first",
  "symbol keys :: compact": "Bun lists keys in insertion order across strings and symbols; JS only exposes strings first",
  "promise resolved :: util": "a promise's state can't be read synchronously in the browser",
  "map iterator :: util": "the Map behind an iterator isn't reachable from JS",
  "set iterator :: util": "the Set behind an iterator isn't reachable from JS",
};

/**
 * The corpus printed by the runtime it runs in: native Bun, or the playground (via --link, where this function's
 * source is the program). `console` adds the console methods (group, dir, assert, table, count, warn, error).
 */
function printAll(all: typeof cases, write: (s: string) => void, log: (...a: unknown[]) => void, bunInspect: Inspect, utilInspect: (v: unknown) => string, withConsole: boolean) {
  const mark = (name: string, kind: string) => write(`@@ ${name} :: ${kind}`);
  for (const [name, args] of all) {
    mark(name, "log");
    log(...args());
    mark(name, "inspect");
    write(bunInspect(args()[0]));
    mark(name, "colors");
    write(JSON.stringify(bunInspect(args()[0], { colors: true })));
    mark(name, "compact");
    write(bunInspect(args()[0], { compact: true }));
    mark(name, "util");
    write(utilInspect(args()[0]));
  }
  if (withConsole) {
    const err = new Error("warned");
    err.stack = "Error: warned\n    at fn (file.js:1:2)";
    mark("methods", "console");
    console.group("G");
    console.log({ a: 1 });
    console.log("x\ny");
    console.group();
    console.info([1, { b: 2 }], "s");
    console.groupEnd();
    console.groupEnd();
    console.dir({ a: { b: { c: 1 } } }, { depth: 0 });
    console.dir("s");
    console.assert(false);
    console.assert(false, "%s!", "fmt", { a: 1 });
    console.assert(true, "no");
    console.table([{ a: 1, b: { c: [1, 2] } }, { a: "s" }]);
    write(Bun.inspect.table([{ a: 1, b: { c: [1, 2] } }, { a: "s" }]));
    console.count();
    console.count();
    console.warn(err);
    console.error("e %d", 1, { x: 1 });
    console.debug(new Map([[{ k: 1 }, new Set([1])]]));
  }
  write("@@ end");
}

function parse(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = text.split(/^(@@ .*)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i].slice(3);
    if (key === "end") break;
    out.set(key, parts[i + 1].replace(/^\n/, "").replace(/\n$/, ""));
  }
  return out;
}

async function native(): Promise<Map<string, string>> {
  // stderr into the same pipe, in order: console.warn and console.error write there.
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.path)} --native 2>&1`;
  const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  return parse(await new Response(proc.stdout).text());
}

async function ours(): Promise<Map<string, string>> {
  const { formatLog, bunInspect } = await import("../../src/worker/inspect");
  const { inspect } = await import("../../src/worker/node/util");
  let text = "";
  const write = (s: string) => void (text += s + "\n");
  printAll(cases, write, (...a) => write(formatLog(a)), (v, o) => bunInspect(v, o), (v) => inspect(v), false);
  return parse(text);
}

/** Prints each mismatch and a summary; returns the number of unexpected ones. `partial`: skip what `actual` lacks. */
function report(expected: Map<string, string>, actual: Map<string, string>, partial = false): number {
  const count = Object.fromEntries(KINDS.map((k) => [k, [0, 0]])) as Record<Kind, [number, number]>;
  let failed = 0;
  for (const [key, want] of expected) {
    const kind = key.split(" :: ")[1] as Kind;
    const got = actual.get(key);
    if (partial && got === undefined) continue;
    count[kind][1]++;
    if (got === want) {
      count[kind][0]++;
      continue;
    }
    const known = KNOWN[key];
    if (!known) failed++;
    console.log(`\n${known ? "known" : "DIFF"}: ${key}${known ? ` (${known})` : ""}`);
    console.log("--- bun\n" + want + "\n+++ playground\n" + (got ?? "<missing>"));
  }
  console.log("\n" + KINDS.filter((k) => count[k][1]).map((k) => `${k}: ${count[k][0]}/${count[k][1]} match`).join(", "));
  return failed;
}

async function link(base: string) {
  const runner = `import { cases } from "./cases.ts";
import util from "node:util";
${printAll.toString()}
printAll(cases, (s) => console.log(s), console.log, (v, o) => Bun.inspect(v, o), (v) => util.inspect(v), true);
`;
  const files = { "index.ts": runner, "cases.ts": readFileSync(new URL("./cases.ts", import.meta.url), "utf8"), "package.json": JSON.stringify({ name: "inspect-corpus", module: "index.ts", type: "module" }, null, 2) };
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, files }));
  const packed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const b64 = Buffer.from(packed).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  console.log(new URL("#code=" + b64, base).href);
}

const [mode, arg] = process.argv.slice(2);
if (mode === "--native") {
  printAll(cases, (s) => process.stdout.write(s + "\n"), console.log, (v, o) => Bun.inspect(v, o), (v) => nativeUtilInspect(v), true);
} else if (mode === "--link") {
  await link(arg ?? "http://localhost:5173/");
} else if (mode === "--compare") {
  process.exit(report(await native(), parse(readFileSync(arg, "utf8"))) ? 1 : 0);
} else {
  process.exit(report(await native(), await ours(), true) ? 1 : 0);
}
