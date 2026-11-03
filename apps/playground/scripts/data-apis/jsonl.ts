// Diffs `Bun.JSONL` (src/worker/jsonl.ts) against native Bun on a corpus of lines, chunks, offsets and inputs.
// Run with bun: `bun scripts/data-apis/jsonl.ts`. Exits 1 on a mismatch.
import { makeJSONL } from "../../src/worker/jsonl.ts";
const mine = makeJSONL() as typeof Bun.JSONL;
const cases = ['1 \n2', '1\n\n2 ', '1  ', '1\n', '1\n{"b":', '1\ntru', '1\ntrue', '1\nnul', '1\n"ab', '1\n"a\\', '1\n[1,', '1\n[1,]', '1\n-', '1\n1.', '1\n1e', '1\n{"a" 1}', '1\n}', '1 2', '1,2', '1\t\r\n2', ' 1', '1\n2\n3\n', ' 1', '"é"\n2', '{"a":1}\n{"b":', '[1]\n[', '1\n{', '1\n  ', '1\r2', '[1][2]', '"a""b"', '1\n// c\n2', '1\n﻿2', '﻿1\n2', '1\n0x1', '1\n01', 'nul', '{', 'x', 'true false', '1\n2\nx\n3', '1\n2\n[1,', 'x\n', 'xy', '}\n', 'trux', 'tru\n', '1.x', '-x', '1e+', '1e5', '1E-2\n3', '"\\x"', '"\\u12"', '"\\u12g4"', '"a\tb"', '{"a":1,}', '{"a":1,', '{"a":', '{"a"', '{"a', '{1:2}', '[1 2]', '[1,,2]', '{"__proto__":1}', '"😀"\n"x', '[[[[1]]]]\n{"a":[{"b":null}]}', '', '\n\n', '-0', '1.5e', '1.5E+3', 'falsey', 'nulll', '"a"x', '{"a":1}}'];
let bad = 0;
const show = (f: () => unknown) => { try { const r: any = f(); return JSON.stringify(r, (k, v) => v instanceof Error ? `E:${v.message}` : v); } catch (e: any) { return `THROW ${e.constructor.name} ${e.message}`; } };
const check = (label: string, a: () => unknown, b: () => unknown) => { const x = show(a), y = show(b); if (x !== y) { bad++; console.log("DIFF", label, "\n native", x, "\n mine  ", y); } };
for (const c of cases) {
  check(JSON.stringify(c) + " chunk", () => Bun.JSONL.parseChunk(c), () => mine.parseChunk(c));
  check(JSON.stringify(c) + " parse", () => Bun.JSONL.parse(c), () => mine.parse(c));
  const u = new TextEncoder().encode(c);
  check(JSON.stringify(c) + " bytes", () => Bun.JSONL.parseChunk(u), () => mine.parseChunk(u));
  for (const [s, e] of [[1, 5], [2, undefined], [-1, 100], [3, 1], [NaN, NaN], [1.7, 4.2]]) {
    check(JSON.stringify(c) + ` ${s},${e}`, () => Bun.JSONL.parseChunk(c, s, e), () => mine.parseChunk(c, s, e));
    check(JSON.stringify(c) + ` b ${s},${e}`, () => Bun.JSONL.parseChunk(u, s, e), () => mine.parseChunk(u, s, e));
  }
}
for (const v of [undefined, null, 5, true, {toString(){return '7'}}, new ArrayBuffer(2), new DataView(new ArrayBuffer(1)), new Uint16Array([0x0a31, 0x32]), new TextEncoder().encode('﻿1\n2'), new TextEncoder().encode('"é"\n"ü"\n{')]) {
  check(String(v) + " parse", () => Bun.JSONL.parse(v as any), () => mine.parse(v));
  check(String(v) + " chunk", () => Bun.JSONL.parseChunk(v as any), () => mine.parseChunk(v));
  check(String(v) + " chunk4", () => Bun.JSONL.parseChunk(v as any, 4), () => mine.parseChunk(v, 4));
}
check("tag", () => [String(Bun.JSONL), Object.keys(Bun.JSONL), Bun.JSONL.parse.length, Bun.JSONL.parseChunk.length, Bun.JSONL.parse.name, Object.keys(Bun.JSONL.parseChunk("1"))], () => [String(mine), Object.keys(mine), mine.parse.length, mine.parseChunk.length, mine.parse.name, Object.keys(mine.parseChunk("1"))]);
console.log(bad ? `JSONL: ${bad} differences` : "JSONL: all match");
if (bad) process.exit(1);
