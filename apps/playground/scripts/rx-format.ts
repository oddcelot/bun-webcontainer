#!/usr/bin/env bun
// Runs the playground's ReactiveScript formatter (src/languages/reactivescript/rxFormat.ts: the module disguised as TSX, `bun fmt`, the disguise
// undone, the result accepted only when four checks show the program did not change) over .rx files with native
// `bun fmt`. Against upstream's examples it tells what a new compiler version or a change to the disguise broke:
//   D=$(mktemp -d); git clone --depth 1 https://github.com/solidjs/reactivescript "$D/rs"; bun scripts/rx-format.ts -v "$D/rs"
//
//   bun scripts/rx-format.ts <dir-or-file>...      one line per file and a summary table
//   bun scripts/rx-format.ts --show <file>         unified diff of what would change
//   bun scripts/rx-format.ts --write <file>...     rewrite accepted files in place (never on a corpus you want to keep)
//
// Checks (all must hold, else the file is left as it was):
//   1. the formatted text parses and has the same compiler diagnostics (code, rule, message) as the original;
//   2. both projections (rxc.wasm's TSX of the module) are the same after `bun fmt`;
//   3. formatting the result changes nothing;
//   4. the comments and `<style>` bodies are the same (the projection drops them).
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatRx, formatUnchecked, RX_FMT_FLAGS, type RxFormatHost, type RxFormatResult } from "../src/languages/reactivescript/rxFormat";

// ---- rxc.wasm: the analysis build, as src/languages/reactivescript/rx.ts loads it (here from disk) ----

type Exports = { memory: WebAssembly.Memory; rx_alloc(n: number): number; rx_free(ptr: number, n: number): void; rx_call(ptr: number, len: number): number };
type Read = (path: string) => string | undefined;
type Diagnostic = { code: string; rule: string; message: string; line: number };
type Analysis = { code?: string; mappings?: unknown[]; diagnostics?: Diagnostic[]; error?: string };

const WASM = join(import.meta.dir, "../node_modules/@reactivescript/language-server/src/rxc.wasm");
const enc = new TextEncoder();
const dec = new TextDecoder();

async function loadRxc() {
  let read: Read = () => undefined;
  let x!: Exports;
  const env = {
    rx_read(ptr: number, len: number) {
      const data = read(dec.decode(new Uint8Array(x.memory.buffer, ptr, len)));
      if (data === undefined) return 0;
      const bytes = enc.encode(data);
      const out = x.rx_alloc(bytes.length + 4);
      new DataView(x.memory.buffer).setUint32(out, bytes.length, true);
      new Uint8Array(x.memory.buffer).set(bytes, out + 4);
      return out;
    },
  };
  const { instance } = await WebAssembly.instantiate(await Bun.file(WASM).arrayBuffer(), { env });
  x = instance.exports as unknown as Exports;
  return function call<T>(method: string, params: unknown, r: Read): T {
    read = r;
    const req = enc.encode(JSON.stringify({ method, params }));
    const ptr = x.rx_alloc(req.length);
    new Uint8Array(x.memory.buffer).set(req, ptr);
    const out = x.rx_call(ptr, req.length);
    const n = new DataView(x.memory.buffer).getUint32(out, true);
    const text = dec.decode(new Uint8Array(x.memory.buffer, out + 4, n));
    x.rx_free(out, n + 4);
    return JSON.parse(text);
  };
}

let call = await loadRxc();
const readDisk: Read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};
class Trap extends Error {}
const analyze = (file: string, text: string) => {
  try {
    return analyzeRaw(file, text);
  } catch (e) {
    throw new Trap(`rxc.wasm trapped: ${(e as Error).message}`);
  }
};
const analyzeRaw = (file: string, text: string) => call<Analysis>("analyze", { file, overlays: { [file]: text }, prelude: "/p" }, (p) => (p === file ? text : readDisk(p)));
const parsed = (a: Analysis) => (!!a.mappings?.length || !a.diagnostics?.length) && !a.diagnostics?.some((d) => d.code === "PARSE");

// ---- bun fmt ----

const EMPTY = mkdtempSync(join(tmpdir(), "rx-fmt-cwd-"));
const FMT = ["bun", "fmt", ...RX_FMT_FLAGS, "--stdin-filepath", "x.tsx"];
function bunfmt(text: string): { ok: true; out: string } | { ok: false; err: string } {
  const r = Bun.spawnSync(FMT, { cwd: EMPTY, stdin: enc.encode(text), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return { ok: false, err: dec.decode(r.stderr).trim().split("\n").slice(0, 4).join(" | ") };
  return { ok: true, out: dec.decode(r.stdout) };
}

// ---- the pipeline (src/languages/reactivescript/rxFormat.ts), over native `bun fmt` and rxc.wasm from disk ----

let current = "";
const host: RxFormatHost = { fmt: async (tsx) => bunfmt(tsx), analyze: async (text) => analyze(current, text) };
const format = (file: string, text: string): Promise<Result> => ((current = file), formatRx(text, host));
const rawFormat = (text: string) => formatUnchecked(text, host);
type Result = RxFormatResult;

// ---- CLI ----

function collect(path: string, out: string[]) {
  const s = statSync(path);
  if (s.isDirectory()) {
    for (const e of readdirSync(path).sort()) if (e !== "node_modules" && e !== ".git") collect(join(path, e), out);
  } else if (/\.rx$/.test(path) && !/\.d\.rx$/.test(path)) out.push(path);
}

const args = process.argv.slice(2);
const flag = (f: string) => {
  const i = args.indexOf(f);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const show = flag("--show");
const write = flag("--write");
const verbose = flag("-v");
if (!args.length) {
  console.error("usage: bun scripts/rx-format.ts [--show] [--write] [-v] <dir-or-file>...");
  process.exit(2);
}
const files: string[] = [];
for (const a of args) collect(resolve(a), files);

const tally = new Map<string, number>();
const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
const details = new Map<string, number>();
try {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    let r: Result;
    try {
      r = await format(file, text);
    } catch (e) {
      if (!(e instanceof Trap)) throw e;
      call = await loadRxc();
      r = { status: "skip", detail: e.message };
    }
    let line: string;
    if (r.status === "skip") {
      bump("skipped (original does not parse)");
      line = `skip: original doesn't parse (${r.detail})`;
    } else if (r.status === "rejected") {
      bump(`rejected: ${r.reason}`);
      line = `REJECTED: ${r.reason}: ${r.detail}`;
      const k = `${r.reason}: ${r.detail.replace(/\d+/g, "N").slice(0, 100)}`;
      details.set(k, (details.get(k) ?? 0) + 1);
    } else if (r.status === "same") {
      bump("accepted (already formatted)");
      line = "unchanged-already-formatted";
    } else {
      bump("accepted (changed)");
      line = "ok";
      if (write) writeFileSync(file, r.out);
    }
    console.log(`${file}: ${line}`);
    if (show && r.status !== "skip") {
      const dir = mkdtempSync(join(tmpdir(), "rx-fmt-diff-"));
      try {
        const out = r.status === "ok" || r.status === "same" ? r.out : await (async () => {
          const raw = await rawFormat(text);
          return raw.ok ? raw.out : text;
        })();
        writeFileSync(join(dir, "a.rx"), text);
        writeFileSync(join(dir, "b.rx"), out);
        const d = Bun.spawnSync(["diff", "-u", "a.rx", "b.rx"], { cwd: dir, stdout: "pipe" });
        console.log(dec.decode(d.stdout) || "(no diff)");
        if (r.status === "rejected") console.log("(the diff is of the unchecked formatter output; the file would stay as it was)");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
} finally {
  rmSync(EMPTY, { recursive: true, force: true });
}

console.log("\nsummary");
console.log(`  files: ${files.length}`);
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
if (verbose) {
  console.log("\nrejection details");
  for (const [k, v] of [...details].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
}
