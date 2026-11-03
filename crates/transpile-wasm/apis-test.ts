// `Bun.XML.parse` as the playground runs it (apps/playground/src/worker/xml.ts over this crate's `xml_parse_c`) vs
// native Bun on a corpus. `node apis-test.ts` (Memory64) runs the
// corpus with the wasm, then itself under `bun` (`--native`) for the reference; exits 1 on a mismatch.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeXML, type XmlWasm } from "../../apps/playground/src/worker/xml.ts";

const enc = new TextEncoder();
type Case = [name: string, run: (xml: Record<string, Function>) => unknown];
const cases: Case[] = [
  ["xml compact", (xml) => xml.parse('<?xml version="1.0"?><!-- c --><r a="1" b="&amp;"><c>t</c><c>u</c><d x="y"/>text<?pi data?><e/></r>')],
  ["xml nodes", (xml) => xml.parse('<?xml version="1.0"?><!-- c --><r a="1"><c>t</c><?pi data?>x<![CDATA[<y>]]></r>', { compact: false })],
  ["xml proto", (xml) => xml.parse('<a><__proto__>1</__proto__><b c="1">x<d/>y</b></a>')],
  ["xml charref", (xml) => xml.parse("<a>&#x1F600;&#233;é</a>")],
  ["xml bytes utf16", (xml) => xml.parse(new Uint8Array([0xff, 0xfe, 0x3c, 0, 0x61, 0, 0x3e, 0, 0x78, 0, 0x3c, 0, 0x2f, 0, 0x61, 0, 0x3e, 0]))],
  ["xml string decl", (xml) => xml.parse('<?xml version="1.0" encoding="UTF-16"?><a>é</a>')],
  ["xml bytes decl", (xml) => xml.parse(enc.encode('<?xml version="1.0" encoding="UTF-16"?><a>é</a>'))],
  ["xml arraybuffer", (xml) => xml.parse(enc.encode("<a>1</a>").buffer)],
  ["xml toString", (xml) => xml.parse({ toString: () => "<a>1</a>" })],
  ["xml errors", (xml) => ["", "<a></b>", "<a", 5, "<a>&bogus;</a>", "<a b='1' b='2'/>"].map((v) => attempt(() => xml.parse(v)))],
  ["xml options", (xml) => [5, () => {}, "s", { compact: 0 }, { compact: "no" }, { compact: null }, [], { compact: undefined }].map((o) => attempt(() => xml.parse("<a>1</a>", o)))],
  ["xml nullish", (xml) => [undefined, null].map((v) => attempt(() => xml.parse(v)))],
  ["xml deep", (xml) => xml.parse("<a>".repeat(200) + "x" + "</a>".repeat(200))],
];

function attempt(f: () => unknown): unknown {
  try {
    return f();
  } catch (e) {
    const err = e as Error & { code?: string };
    return { thrown: err.constructor.name, code: err.code, message: err.message };
  }
}

/** JSON for the results: symbols (React's `$$typeof`, fragment) and functions as text, errors as their fields. */
const serialize = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "symbol" ? String(x) : typeof x === "function" ? `fn ${x.name}` : x === undefined ? "undefined" : x));

function runAll(xml: object): string[] {
  return cases.map(([, run]) => serialize(attempt(() => run(xml as Record<string, Function>))));
}

if (process.argv.includes("--native")) {
  const B = (globalThis as unknown as { Bun: { XML: object } }).Bun;
  process.stdout.write(JSON.stringify(runAll(B.XML)));
} else {
  const wasm = readFileSync(new URL("../../target/wasm64-unknown-unknown/release/bun_transpile_wasm.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(wasm, { env: { resolve_specifier: () => 0n } });
  const w = instance.exports as Record<string, Function> & { memory: WebAssembly.Memory };
  const call = (fn: string, input: Uint8Array, ...args: number[]): string | { error: string } => {
    const len = BigInt(input.length);
    const ptr = w.alloc(len) as bigint;
    new Uint8Array(w.memory.buffer, Number(ptr), input.length).set(input);
    const out = w[fn](ptr, len, ...args) as bigint;
    const [status, p, n] = new BigUint64Array(w.memory.buffer, Number(out), 3);
    const text = new TextDecoder().decode(new Uint8Array(w.memory.buffer, Number(p), Number(n)));
    w.output_free(out);
    w.dealloc(ptr, len);
    return status === 0n ? text : { error: text };
  };
  const xmlWasm: XmlWasm = { parse: (i, f) => call("xml_parse_c", i, f) };
  const mine = runAll(makeXML(() => xmlWasm));
  const native = spawnSync("bun", [fileURLToPath(import.meta.url), "--native"], { encoding: "utf8" });
  if (native.status !== 0) throw new Error(`bun --native failed: ${native.stderr}`);
  const expected = JSON.parse(native.stdout) as string[];
  let fail = 0;
  cases.forEach(([name], i) => {
    if (mine[i] === expected[i]) return;
    fail++;
    console.log(`MISMATCH ${name}\n--- wasm\n${mine[i]}\n--- bun\n${expected[i]}`);
  });
  console.log(`Bun.XML.parse: ${cases.length - fail}/${cases.length} identical to native bun`);
  if (fail) process.exit(1);
}
