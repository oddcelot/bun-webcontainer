// Diff `xmlStringify` (apps/playground/src/worker/xml.ts) against native `Bun.XML.stringify`.
// Run with bun: `bun diff.ts`. Exits non-zero on any mismatch.
import { xmlStringify } from "../../src/worker/xml.ts";

type Args = [value: unknown, replacer?: unknown, space?: unknown];

const deep = (n: number) => {
  let o: unknown = { x: 1 };
  for (let i = 0; i < n; i++) o = { a: o };
  return { r: o };
};
const deepNode = (n: number) => {
  let o: unknown = { name: "x", children: [] };
  for (let i = 0; i < n; i++) o = { name: "a", children: [o] };
  return o;
};
const cyclic = () => {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  return { r: o };
};
const cyclicDoc = () => {
  const d: Record<string, unknown> = {};
  d.r = { back: d };
  return d;
};
const cyclicNode = () => {
  const n: Record<string, unknown> = { name: "a", children: [] };
  (n.children as unknown[]).push(n);
  return n;
};
const sharedNotCyclic = () => {
  const s = { v: 1 };
  return { r: { a: s, b: s, c: [s, s] } };
};
const SAMPLE = `<?xml version="1.0"?>
<catalog xmlns:x="urn:x">
  <!-- a comment -->
  <?pi some data?>
  <book id="b1" lang="en"><title>XML &amp; you</title><price>29.99</price><tags><tag>a</tag><tag>b</tag></tags></book>
  <book id="b2"><title>Second</title><note>mixed <b>bold</b> text</note><empty/></book>
  <x:ns attr="1">ns</x:ns>
</catalog>`;
const parse = (src: string, opts?: unknown) => (Bun.XML.parse as (s: string, o?: unknown) => unknown)(src, opts);

export const corpus: [string, () => Args][] = [
  // compact documents
  ["text root", () => [{ root: "text" }]],
  ["empty string root", () => [{ root: "" }]],
  ["null root", () => [{ root: null }]],
  ["number root", () => [{ n: 42 }]],
  ["neg zero", () => [{ n: -0 }]],
  ["float/exp", () => [{ r: { a: 1.5, b: 1e21, c: 1e-7, d: NaN, e: Infinity } }]],
  ["boolean", () => [{ r: { t: true, f: false } }]],
  ["bigint", () => [{ r: { b: 12345678901234567890n } }]],
  ["date", () => [{ r: { d: new Date(Date.UTC(2020, 1, 3, 4, 5, 6, 7)) } }]],
  ["date extreme", () => [{ r: { a: new Date(8.64e15), b: new Date(-8.64e15), c: new Date(Date.UTC(-1, 0, 1)) } }]],
  ["invalid date", () => [{ r: { d: new Date(NaN) } }]],
  ["undefined/function/symbol values", () => [{ r: { u: undefined, f() {}, s: Symbol("x"), k: 1 } }]],
  ["only skipped children", () => [{ r: { u: undefined, f: () => 1 } }]],
  ["empty object", () => [{ r: {} }]],
  ["empty array child", () => [{ r: { list: [] } }]],
  ["array of skipped", () => [{ r: { list: [undefined, () => 1] } }]],
  ["attributes", () => [{ r: { "@id": "1", "@n": 2, "@b": true, "@nul": null, "@u": undefined, "#text": "hi" } }]],
  ["attr escaping", () => [{ r: { "@a": `<&>"' \t\n\r x` } }]],
  ["text escaping", () => [{ r: `<&>"' \t\n\r ]]> x` } ]],
  ["cdata end in text", () => [{ r: "a]]>b" }]],
  ["#text only", () => [{ r: { "#text": "only" } }]],
  ["#text empty", () => [{ r: { "#text": "" } }]],
  ["#text null", () => [{ r: { "#text": null } }]],
  ["#text with elements", () => [{ r: { a: 1, "#text": "t", b: 2 } }, null, 2]],
  ["#text object", () => [{ r: { "#text": {} } }]],
  ["unknown # key", () => [{ r: { "#cdata": "x" } }]],
  ["repeated children", () => [{ r: { item: [1, "two", { "@k": "v", "#text": "three" }, null, ""] } }]],
  ["repeated children pretty", () => [{ r: { item: [1, { a: 1 }, null] } }, null, 2]],
  ["nested arrays", () => [{ r: { item: [[1]] } }]],
  ["root array", () => [{ r: [1, 2] }]],
  ["nested", () => [{ a: { b: { c: { d: "deep" } } } }]],
  ["nested pretty 2", () => [{ a: { b: { c: { d: "deep" }, e: [1, 2] }, f: "x" } }, null, 2]],
  ["multiple root keys", () => [{ a: 1, b: 2 }]],
  ["multiple root keys one skipped", () => [{ a: 1, b: undefined }]],
  ["no root keys", () => [{}]],
  ["top-level @", () => [{ "@a": 1 }]],
  ["top-level #", () => [{ "#text": 1 }]],
  ["invalid element name", () => [{ "1abc": 1 }]],
  ["invalid name space", () => [{ r: { "a b": 1 } }]],
  ["empty attr name", () => [{ r: { "@": 1 } }]],
  ["invalid attr name", () => [{ r: { "@1x": 1 } }]],
  ["unicode names", () => [{ "ünï·cödé": { "@ñ": "ö", "日本": "語", "\u{10000}x": 1 } }]],
  ["lone surrogate name", () => [{ ["a\uD800"]: 1 }]],
  ["lone surrogate text", () => [{ a: "x\uDC00y" }]],
  ["astral text", () => [{ a: "😀 \u{10FFFF}" }]],
  ["control char", () => [{ a: "x\u0001" }]],
  ["fffe", () => [{ a: "￾" }]],
  ["nul in attr", () => [{ a: { "@x": "\0" } }]],
  ["object value in attr", () => [{ a: { "@x": {} } }]],
  ["array value in attr", () => [{ a: { "@x": [1] } }]],
  ["map/regexp values", () => [{ r: { m: new Map([[1, 2]]), re: /x/ } }]],
  ["boxed values", () => [{ r: { s: new String("str"), n: new Number(3), b: new Boolean(false), big: Object(5n) } }]],
  ["boxed symbol", () => [{ a: Object(Symbol("x")) }]],
  ["boxed top string", () => [new String("x")]],
  ["boxed root value", () => [{ r: new String("") }]],
  ["class instance", () => [{ r: new (class { x = 1; y = "z"; })() }]],
  ["prototype keys ignored", () => [{ r: Object.create({ x: 1 }) }]],
  ["non-enumerable ignored", () => {
    const o: Record<string, unknown> = { b: 2 };
    Object.defineProperty(o, "a", { value: 1, enumerable: false });
    return [{ r: o }];
  }],
  ["getter", () => [{ r: { get a() { return "g"; } } }]],
  ["getter deletes later key", () => {
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, "a", { enumerable: true, get() { delete o.b; return 1; } });
    o.b = 2;
    o.c = 3;
    return [{ r: o }];
  }],
  ["shared not cyclic", () => [sharedNotCyclic()]],
  ["cycle", () => [cyclic()]],
  ["cycle via doc", () => [cyclicDoc()]],
  ["cycle via array", () => {
    const a: unknown[] = [];
    a.push({ x: a });
    return [{ r: { a } }];
  }],
  ["deep 1000", () => [deep(1000)]],
  ["deep 100000", () => [deep(100000)]],
  ["deep node 1000", () => [deepNode(1000)]],
  ["deep node 100000", () => [deepNode(100000)]],
  ["integer-like keys order", () => [{ r: { b: 1, a2: 2, _1: 3 } }]],

  // top-level non-objects and arguments
  ["string top", () => ["x"]],
  ["number top", () => [1]],
  ["array top", () => [[{ a: 1 }]]],
  ["null top", () => [null]],
  ["undefined top", () => [undefined]],
  ["function top", () => [() => 1]],
  ["symbol top", () => [Symbol("x")]],
  ["date top", () => [new Date(0)]],
  ["replacer fn", () => [{ a: 1 }, () => 1]],
  ["replacer array", () => [{ a: 1 }, ["a"]]],
  ["replacer null", () => [{ a: 1 }, null]],
  ["replacer with undefined value", () => [undefined, () => 1]],
  ["replacer with bad root", () => ["x", () => 1]],

  // space
  ...([0, 1, 2, 4, 10, 11, 1.9, NaN, -1, Infinity, "", "\t", "--", "abcdefghijklmnop", "😀abcdefghijk", new Number(3), new String("  "), true, {}] as unknown[]).map(
    (sp): [string, () => Args] => [`space ${typeof sp === "object" ? `boxed ${String(sp)}` : JSON.stringify(sp) ?? String(sp)}`, () => [{ r: { a: { b: 1, c: [1, 2] }, d: "x" } }, null, sp]],
  ),

  // node trees
  ["node basic", () => [{ name: "root", attributes: { id: "1" }, children: ["text", { name: "child", children: [] }] }]],
  ["node no children", () => [{ name: "root", attributes: {} }]],
  ["node children null", () => [{ name: "root", children: null }]],
  ["node children undefined own", () => [{ name: "root", children: undefined }]],
  ["node attributes undefined own", () => [{ name: "root", attributes: undefined }]],
  ["node children only skipped", () => [{ name: "root", children: [null, undefined, () => 1] }]],
  ["node children not array", () => [{ name: "root", children: "x" }]],
  ["node attributes array", () => [{ name: "root", attributes: [] }]],
  ["node attributes string", () => [{ name: "root", attributes: "x" }]],
  ["node attributes values", () => [{ name: "r", attributes: { a: 1, b: null, c: undefined, d: true, e: 2n, f: new Date(0), g: "<\"\n>" } }]],
  ["node attr object", () => [{ name: "r", attributes: { a: {} } }]],
  ["node element-only pretty", () => [{ name: "r", children: [{ name: "a", children: [{ name: "b", children: [] }] }, { name: "c" , attributes: null }] }, null, 2]],
  ["node mixed pretty", () => [{ name: "r", children: ["t", { name: "a", children: [{ name: "b", children: ["x"] }] }] }, null, 2]],
  ["node text kinds", () => [{ name: "r", children: [1, true, 3n, new Date(0), new String("s"), "&<>\r\n\t"] }]],
  ["node comment", () => [{ name: "r", children: [{ comment: " hi " }, { comment: "" }] }]],
  ["node comment pretty", () => [{ name: "r", children: [{ comment: "c" }, { target: "pi", data: "d" }, { name: "e", children: [] }] }, null, "\t"]],
  ["comment double dash", () => [{ name: "r", children: [{ comment: "a--b" }] }]],
  ["comment trailing dash", () => [{ name: "r", children: [{ comment: "a-" }] }]],
  ["comment single dash", () => [{ name: "r", children: [{ comment: "-" }] }]],
  ["comment non-string", () => [{ name: "r", children: [{ comment: 1 }] }]],
  ["comment null", () => [{ name: "r", children: [{ comment: null }] }]],
  ["comment bad char", () => [{ name: "r", children: [{ comment: "\u0002" }] }]],
  ["comment and target", () => [{ name: "r", children: [{ comment: "c", target: "t" }] }]],
  ["pi no data", () => [{ name: "r", children: [{ target: "t" }, { target: "u", data: null }, { target: "v", data: "" }] }]],
  ["pi data ?>", () => [{ name: "r", children: [{ target: "t", data: "a?>b" }] }]],
  ["pi data ? and >", () => [{ name: "r", children: [{ target: "t", data: "a? >b" }] }]],
  ["pi xml reserved", () => [{ name: "r", children: [{ target: "XmL" }] }]],
  ["pi xml-ish ok", () => [{ name: "r", children: [{ target: "xml-stylesheet", data: "href='a'" }] }]],
  ["pi bad target", () => [{ name: "r", children: [{ target: "1t" }] }]],
  ["pi target number", () => [{ name: "r", children: [{ target: 1 }] }]],
  ["pi data number", () => [{ name: "r", children: [{ target: "t", data: 1 }] }]],
  ["pi data bad char", () => [{ name: "r", children: [{ target: "t", data: "\uD800" }] }]],
  ["child without name", () => [{ name: "r", children: [{ foo: 1 }] }]],
  ["child name number", () => [{ name: "r", children: [{ name: 1 }] }]],
  ["child array", () => [{ name: "r", children: [[1]] }]],
  ["child object text", () => [{ name: "r", children: [{ name: "a", children: [{}] }] }]],
  ["node invalid name", () => [{ name: "a b", children: [] }]],
  ["node empty name", () => [{ name: "", children: [] }]],
  ["node name non-string top", () => [{ name: 1, children: [] }]],
  ["node name only", () => [{ name: "x" }]],
  ["node cycle", () => [cyclicNode()]],
  ["node children getter", () => [{ name: "r", get children() { return ["g"]; } }]],
  ["node with holes", () => [{ name: "r", children: [, "a", , { name: "b" , children: []}] }]],

  // round trips
  ["roundtrip compact", () => [parse(SAMPLE)]],
  ["roundtrip compact pretty", () => [parse(SAMPLE), null, 2]],
  ["roundtrip node", () => [parse(SAMPLE, { compact: false })]],
  ["roundtrip node pretty", () => [parse(SAMPLE, { compact: false }), null, 2]],
  ["roundtrip simple", () => [parse("<a x='1'><b>t</b><b>u</b></a>")]],
  ["roundtrip simple node", () => [parse("<a x='1'><b>t</b><b>u</b></a>", { compact: false }), null, "  "]],
];

type Outcome = { ok: true; value: unknown } | { ok: false; err: string };
function run(f: () => unknown): Outcome {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    const err = e as { constructor?: { name?: string }; code?: unknown; message?: unknown };
    return { ok: false, err: `${err?.constructor?.name} ${String(err?.code)} ${JSON.stringify(err?.message)}` };
  }
}
const show = (o: Outcome) => (o.ok ? `=> ${JSON.stringify(o.value)}` : `THROW ${o.err}`);

let pass = 0;
let failCount = 0;
for (const [name, mk] of corpus) {
  const native = run(() => (Bun.XML.stringify as (...a: unknown[]) => unknown)(...mk()));
  const ported = run(() => xmlStringify(...mk()));
  if (show(native) === show(ported)) pass++;
  else {
    failCount++;
    console.log(`MISMATCH ${name}\n  native: ${show(native)}\n  ported: ${show(ported)}`);
  }
}
console.log(`${pass}/${corpus.length} match`);
if (import.meta.main && failCount > 0) process.exit(1);
