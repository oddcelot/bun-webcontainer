// Run by test.ts under native Bun: reads stdin, applies one codec operation, writes the result to stdout.
//   bun native.ts zc <level> | zd | bc <quality> | bd
import zlib from "node:zlib";

const [op, arg] = process.argv.slice(2);
const input = Buffer.from(await Bun.stdin.arrayBuffer());
let out: Uint8Array;
if (op === "zc") out = Bun.zstdCompressSync(input, { level: Number(arg) });
else if (op === "zd") out = Bun.zstdDecompressSync(input);
else if (op === "bc") out = zlib.brotliCompressSync(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: Number(arg) } });
else if (op === "bd") out = zlib.brotliDecompressSync(input);
else throw new Error(`unknown op ${op}`);
process.stdout.write(out);
