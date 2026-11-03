// `Bun.markdown` and `Bun.XML.parse` as the playground runs them (apps/playground/src/worker/markdown.ts and xml.ts
// over this crate's `markdown_*_c` / `xml_parse_c`) vs native Bun on a corpus. `node apis-test.ts` (Memory64) runs the
// corpus with the wasm, then itself under `bun` (`--native`) for the reference; exits 1 on a mismatch.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeMarkdown, type MarkdownWasm } from "../../apps/playground/src/worker/markdown.ts";
import { makeXML, type XmlWasm } from "../../apps/playground/src/worker/xml.ts";

const enc = new TextEncoder();
const MD = `# Hi *there* & you

Some **bold**, _em_, \`code\`, ~~del~~, a [link](http://x.com "T") and ![alt *x*](i.png "t").
Line two\\
hard break &amp; &copy; &#x1F600; &bogus; \0 null.

1. one
2. [ ] two
3. [x] three

- a
  - nested [ref][r]
- b

> quote
> > deep

\`\`\`js extra info
const x = 1;
\`\`\`

    indented

| a | b | c |
|:-|-:|:-:|
| 1 | 2 | 3 |

---

<div>html block</div>

## Hi *there* & you

www.example.com and me@example.com and https://e.com/x [[wiki]] __under__ $m$ $$d$$

[r]: http://ref.example "Ref"
`;

type Case = [name: string, run: (md: Record<string, Function>, xml: Record<string, Function>) => unknown];
const allCallbacks = (wrap: (name: string) => Function) =>
  Object.fromEntries(
    "heading paragraph blockquote code list listItem hr table thead tbody tr th td html strong emphasis link image codespan strikethrough".split(" ").map((n) => [n, wrap(n)]),
  );

const cases: Case[] = [
  ["html", (md) => md.html(MD)],
  ["html bytes", (md) => md.html(enc.encode(MD))],
  ["html arraybuffer", (md) => md.html(enc.encode("*b*").buffer)],
  ["html dataview", (md) => md.html(new DataView(enc.encode("*b*").buffer))],
  ["html all on", (md) => md.html(MD, { autolinks: true, headings: true, hardSoftBreaks: true, wikiLinks: true, underline: true, latexMath: true, tagFilter: true })],
  ["html each", (md) => md.html(MD, { autolinks: { www: true }, headings: { ids: true } })],
  ["html off", (md) => md.html(MD, { tables: false, strikethrough: 0, tasklists: "" })],
  ["html snake", (md) => md.html(MD, { wiki_links: true, latex_math: 1, no_indented_code_blocks: true, no_html_blocks: true, no_html_spans: true, collapse_whitespace: true })],
  ["html both names", (md) => md.html(MD, { wikiLinks: false, wiki_links: true })],
  ["html bad shorthand", (md) => md.html(MD, { autolinks: "yes", headings: 1 })],
  ["html atx", (md) => md.html("#a\n##b", { permissiveAtxHeaders: true })],
  ["html options 5", (md) => md.html("x", 5)],
  ["html tag filter", (md) => md.html("<script>x</script>\n\n<title>t</title>", { tagFilter: true })],
  ["html empty", (md) => md.html("")],
  ["html unicode", (md) => md.html("# Ünïcödé 😀\n\n\ud800 lone")],
  ["ansi", (md) => md.ansi(MD)],
  ["ansi plain", (md) => md.ansi(MD, { colors: false })],
  ["ansi theme", (md) => md.ansi(MD, { hyperlinks: true, light: true, columns: 40 })],
  ["ansi columns", (md) => [5, 5.9, -5, NaN, 1e9, "5"].map((columns) => md.ansi("a b c d e f g h i j k l", { columns, colors: false }))],
  ["ansi theme 5", (md) => md.ansi("*a*", 5)],
  ["render none", (md) => md.render(MD)],
  ["render all", (md) => {
    const metas: unknown[] = [];
    const out = md.render(MD, allCallbacks((n) => (c: string, m?: unknown) => (metas.push([n, c, m === undefined ? "no meta" : m, m && Object.keys(m)]), `<${n}>${c}</${n}>`)), { headings: { ids: true }, wikiLinks: true, latexMath: true, underline: true });
    return [out, metas];
  }],
  ["render text", (md) => md.render(MD, { text: (t: string) => t.toUpperCase(), paragraph: () => null, heading: (c: string) => `[${c}]` })],
  ["render values", (md) => md.render("*a* **b**", { emphasis: () => 5, strong: () => ({ toString: () => "O" }) })],
  ["render non-fn", (md) => md.render("*a*", { emphasis: 5 })],
  ["render throws", (md) => md.render("*a* **b**", { strong: () => { throw new Error("boom"); } })],
  ["render symbol", (md) => md.render("*a*", { emphasis: () => Symbol() })],
  ["render proto", (md) => md.render("*a*", Object.create({ emphasis: (c: string) => `<${c}>` }))],
  ["render list meta", (md) => md.render("3. a\n4. b\n   - c\n   - [x] d", { listItem: (c: string, m: unknown) => `${JSON.stringify(m)}${c}`, list: (c: string, m: unknown) => `(${JSON.stringify(m)}${c})` })],
  ["react", (md) => md.react(MD)],
  ["react ids", (md) => md.react(MD, null, { headings: true, wikiLinks: true, latexMath: true, underline: true })],
  ["react v18", (md) => [NaN, 18, 18.9, 19, "18", -1].map((reactVersion) => md.react("x", null, { reactVersion }))],
  ["react components", (md) => md.react("# a\n\n*x* **y**  \nz\n\n---", { h1: "H", em: "", strong: false, br: "BR", hr: 5, p: () => null })],
  ["react img alt", (md) => md.react("![a *b* `c`](u) ![](v) ![*x*](w)")],
  ...["html", "ansi", "render", "react"].map((f): Case => [`${f} bad input`, (md) => [undefined, null, 5, {}, true].map((v) => attempt(() => md[f](v)))]),
  ["xml compact", (_, xml) => xml.parse('<?xml version="1.0"?><!-- c --><r a="1" b="&amp;"><c>t</c><c>u</c><d x="y"/>text<?pi data?><e/></r>')],
  ["xml nodes", (_, xml) => xml.parse('<?xml version="1.0"?><!-- c --><r a="1"><c>t</c><?pi data?>x<![CDATA[<y>]]></r>', { compact: false })],
  ["xml proto", (_, xml) => xml.parse('<a><__proto__>1</__proto__><b c="1">x<d/>y</b></a>')],
  ["xml charref", (_, xml) => xml.parse("<a>&#x1F600;&#233;é</a>")],
  ["xml bytes utf16", (_, xml) => xml.parse(new Uint8Array([0xff, 0xfe, 0x3c, 0, 0x61, 0, 0x3e, 0, 0x78, 0, 0x3c, 0, 0x2f, 0, 0x61, 0, 0x3e, 0]))],
  ["xml string decl", (_, xml) => xml.parse('<?xml version="1.0" encoding="UTF-16"?><a>é</a>')],
  ["xml bytes decl", (_, xml) => xml.parse(enc.encode('<?xml version="1.0" encoding="UTF-16"?><a>é</a>'))],
  ["xml arraybuffer", (_, xml) => xml.parse(enc.encode("<a>1</a>").buffer)],
  ["xml toString", (_, xml) => xml.parse({ toString: () => "<a>1</a>" })],
  ["xml errors", (_, xml) => ["", "<a></b>", "<a", 5, "<a>&bogus;</a>", "<a b='1' b='2'/>"].map((v) => attempt(() => xml.parse(v)))],
  ["xml options", (_, xml) => [5, () => {}, "s", { compact: 0 }, { compact: "no" }, { compact: null }, [], { compact: undefined }].map((o) => attempt(() => xml.parse("<a>1</a>", o)))],
  ["xml nullish", (_, xml) => [undefined, null].map((v) => attempt(() => xml.parse(v)))],
  ["xml deep", (_, xml) => xml.parse("<a>".repeat(200) + "x" + "</a>".repeat(200))],
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

function runAll(md: object, xml: object): string[] {
  return cases.map(([, run]) => serialize(attempt(() => run(md as Record<string, Function>, xml as Record<string, Function>))));
}

if (process.argv.includes("--native")) {
  const B = (globalThis as unknown as { Bun: { markdown: object; XML: object } }).Bun;
  process.stdout.write(JSON.stringify(runAll(B.markdown, B.XML)));
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
  const mdWasm: MarkdownWasm = {
    html: (i, o) => call("markdown_html_c", i, o),
    ansi: (i, t, c) => call("markdown_ansi_c", i, t, c),
    events: (i, o) => call("markdown_events_c", i, o),
  };
  const xmlWasm: XmlWasm = { parse: (i, f) => call("xml_parse_c", i, f) };
  const mine = runAll(makeMarkdown(() => mdWasm), makeXML(() => xmlWasm));
  const native = spawnSync("bun", [fileURLToPath(import.meta.url), "--native"], { encoding: "utf8", env: { ...process.env, COLORFGBG: "" } });
  if (native.status !== 0) throw new Error(`bun --native failed: ${native.stderr}`);
  const expected = JSON.parse(native.stdout) as string[];
  let fail = 0;
  cases.forEach(([name], i) => {
    if (mine[i] === expected[i]) return;
    fail++;
    console.log(`MISMATCH ${name}\n--- wasm\n${mine[i]}\n--- bun\n${expected[i]}`);
  });
  console.log(`Bun.markdown / Bun.XML.parse: ${cases.length - fail}/${cases.length} identical to native bun`);
  if (fail) process.exit(1);
}
