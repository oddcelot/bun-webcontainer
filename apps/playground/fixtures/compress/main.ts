// zstd and brotli: Bun.zstd*, node:zlib's brotli and zstd, CompressionStream. Every line printed is the same in native
// Bun, except `BLOB` lines (this side's compressed bytes: encoders differ, so the harness decodes them with native Bun).
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { corpus, LEVELS, QUALITIES } from "./corpus.ts";

const log = (...a: unknown[]) => console.log(...a);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0;
const native: { zstd: Record<string, Record<string, string>>; brotli: Record<string, Record<string, string>> } = JSON.parse(readFileSync("native.json", "utf8"));
const data = corpus();
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const blob = (kind: string, name: string, arg: number, bytes: Uint8Array) => log("BLOB", kind, name, arg, b64(bytes));
const attempt = (label: string, f: () => unknown) => {
  try {
    const r = f() as { length?: number };
    log(label, "ok", r?.length);
  } catch (e) {
    const err = e as Error & { code?: string; errno?: number };
    log(label, err.name, err.code, err.errno, err.message);
  }
};
const settle = async (label: string, f: () => Promise<unknown>) => {
  try {
    const r = (await f()) as { length?: number };
    log(label, "ok", r?.length);
  } catch (e) {
    const err = e as Error & { code?: string; errno?: number };
    log(label, err.name, err.code, err.errno, err.message);
  }
};
const collect = async (readable: ReadableStream<Uint8Array>) => Buffer.concat(await Array.fromAsync(readable));

// What native Bun compressed decompresses here.
for (const [name, bytes] of Object.entries(data)) {
  for (const [level, b] of Object.entries(native.zstd[name])) {
    const packed = Buffer.from(b, "base64");
    log("zstd native->here", name, level, same(Bun.zstdDecompressSync(packed), bytes), same(zlib.zstdDecompressSync(packed), bytes));
  }
  for (const [q, b] of Object.entries(native.brotli[name])) {
    const packed = Buffer.from(b, "base64");
    log("brotli native->here", name, q, same(zlib.brotliDecompressSync(packed), bytes));
  }
}

// What is compressed here decompresses here (and natively: the harness checks the BLOB lines).
for (const [name, bytes] of Object.entries(data)) {
  for (const level of LEVELS) {
    if (level > 9 && bytes.length > 100_000) continue;
    const packed = Bun.zstdCompressSync(bytes, { level });
    log("zstd round trip", name, level, same(Bun.zstdDecompressSync(packed), bytes), same(zlib.zstdDecompressSync(packed), bytes));
    blob("zstd", name, level, packed);
  }
  const viaNode = zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 5 } });
  log("zstd node round trip", name, same(Bun.zstdDecompressSync(viaNode), bytes));
  for (const q of QUALITIES) {
    const packed = zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q } });
    log("brotli round trip", name, q, same(zlib.brotliDecompressSync(packed), bytes));
    blob("brotli", name, q, packed);
  }
}
log("types", Buffer.isBuffer(Bun.zstdCompressSync("a")), Buffer.isBuffer(Bun.zstdDecompressSync(Bun.zstdCompressSync("a"))), Buffer.isBuffer(zlib.brotliCompressSync("a")));
log("strings", Bun.zstdDecompressSync(Bun.zstdCompressSync("héllo wörld")).toString(), zlib.brotliDecompressSync(zlib.brotliCompressSync("héllo wörld")).toString());
log("inputs", Bun.zstdDecompressSync(Bun.zstdCompressSync(new Uint16Array([1, 2, 3]))).length, Bun.zstdDecompressSync(Bun.zstdCompressSync(new Uint8Array([1, 2, 3]).buffer)).length);
log("default level is 3", same(Bun.zstdCompressSync("abc".repeat(1000)), Bun.zstdCompressSync("abc".repeat(1000), { level: 3 })));
log("concatenated frames", Bun.zstdDecompressSync(Buffer.concat([Bun.zstdCompressSync("abc"), Bun.zstdCompressSync("def")])).toString());
log("empty", Bun.zstdDecompressSync(new Uint8Array(0)).length, zlib.zstdDecompressSync(Buffer.alloc(0)).length);

// Arguments and errors.
for (const level of [0, -1, 23, 1.5, "3"]) attempt(`zstd level ${JSON.stringify(level)}`, () => Bun.zstdCompressSync("x", { level: level as number }));
for (const level of [1, 22]) attempt(`zstd level ${level}`, () => Bun.zstdCompressSync("x", { level }));
for (const v of [undefined, null, 5, {}, new Blob(["a"])]) attempt(`zstd data ${String(v)}`, () => Bun.zstdCompressSync(v as never));
const good = Bun.zstdCompressSync(data.text);
const flipped = Buffer.from(good);
flipped[flipped.length - 1] ^= 0xff;
attempt("zstd garbage", () => Bun.zstdDecompressSync(Buffer.from("this is not zstd data at all!!!!")));
attempt("zstd truncated", () => Bun.zstdDecompressSync(good.subarray(0, good.length - 3)));
attempt("zstd corrupt tail", () => Bun.zstdDecompressSync(flipped));
attempt("zstd node garbage", () => zlib.zstdDecompressSync(Buffer.from("this is not zstd data at all!!!!")));
attempt("zstd node truncated", () => zlib.zstdDecompressSync(good.subarray(0, good.length - 3)));
attempt("zstd node bad param", () => zlib.zstdCompressSync("a", { params: { 99999: 1 } }));
const bgood = zlib.brotliCompressSync(data.text);
attempt("brotli garbage", () => zlib.brotliDecompressSync(Buffer.from("this is not brotli data at all!!!!")));
attempt("brotli reserved", () => zlib.brotliDecompressSync(Buffer.from("zzzzzz")));
attempt("brotli truncated", () => zlib.brotliDecompressSync(bgood.subarray(0, bgood.length - 3)));
attempt("brotli empty", () => zlib.brotliDecompressSync(Buffer.alloc(0)));
attempt("brotli trailing bytes", () => zlib.brotliDecompressSync(Buffer.concat([bgood, Buffer.from("xx")])));
attempt("brotli bad param", () => zlib.brotliCompressSync("a", { params: { 9999: 1 } }));
attempt("brotli mode text", () => same(zlib.brotliDecompressSync(zlib.brotliCompressSync(data.text, { params: { [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } })), data.text));
attempt("brotli lgwin 10", () => same(zlib.brotliDecompressSync(zlib.brotliCompressSync(data.text, { params: { [zlib.constants.BROTLI_PARAM_LGWIN]: 10 } })), data.text));
attempt("brotli bad data type", () => zlib.brotliCompressSync(5 as never));

// Promises, callbacks and streams.
log("async zstd", same(await Bun.zstdDecompress(await Bun.zstdCompress(data.text, { level: 7 })), data.text));
await settle("async zstd garbage", () => Bun.zstdDecompress(Buffer.from("this is not zstd data at all!!!!")));
await settle("async zstd bad data", () => Bun.zstdCompress(5 as never));
await settle("async zstd bad level", () => Bun.zstdCompress("a", { level: 99 }));
await settle("async zstd decompress bad data", () => Bun.zstdDecompress(5 as never));
await new Promise<void>((resolve) =>
  zlib.brotliCompress(data.short, (err, out) => {
    log("brotliCompress callback", err, same(zlib.brotliDecompressSync(out), data.short));
    zlib.brotliDecompress(Buffer.from("zzzzzz"), (e) => (log("brotliDecompress callback error", (e as { code?: string })?.code, (e as { errno?: number })?.errno, e?.message), resolve()));
  }),
);
await new Promise<void>((resolve) => zlib.zstdCompress(data.short, (err, out) => (log("zstdCompress callback", err, same(Bun.zstdDecompressSync(out), data.short)), resolve())));
for (const [kind, enc, dec] of [
  ["brotli", zlib.createBrotliCompress, zlib.createBrotliDecompress],
  ["zstd", zlib.createZstdCompress, zlib.createZstdDecompress],
] as const) {
  const chunks: Buffer[] = [];
  await pipeline(Readable.from([data.text.subarray(0, 10_000), data.text.subarray(10_000)]), enc(), dec(), async function (source: AsyncIterable<Buffer>) {
    for await (const c of source) chunks.push(c);
  });
  log(`${kind} stream pipeline`, same(Buffer.concat(chunks), data.text));
}
await new Promise<void>((resolve) => {
  const s = zlib.createBrotliDecompress();
  s.on("error", (e: Error & { code?: string; errno?: number }) => (log("brotli stream error", e.code, e.errno, e.message), resolve()));
  s.on("end", resolve);
  s.resume();
  s.end(Buffer.from("zzzzzz"));
});
for (const format of ["brotli", "zstd"] as const) {
  const input = new Blob([data.mixed as BlobPart]).stream();
  const packed = await collect(input.pipeThrough(new CompressionStream(format as never)) as ReadableStream<Uint8Array>);
  const back = await collect(new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream(format as never)) as ReadableStream<Uint8Array>);
  log(`${format} CompressionStream`, same(back, data.mixed), same(format === "zstd" ? Bun.zstdDecompressSync(packed) : zlib.brotliDecompressSync(packed), data.mixed));
  blob(`stream-${format}`, "mixed", 0, packed);
}
for (const format of ["brotli", "zstd"] as const) {
  const packed = format === "zstd" ? Bun.zstdCompressSync(data.text) : zlib.brotliCompressSync(data.text);
  const back = await collect(new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream(format as never)) as ReadableStream<Uint8Array>);
  log(`${format} DecompressionStream of a`, same(back, data.text));
}

// Constants and the classes.
const c = zlib.constants;
log("constants", c.BROTLI_PARAM_QUALITY, c.BROTLI_MAX_QUALITY, c.BROTLI_MODE_TEXT, c.BROTLI_DECODER_ERROR_FORMAT_PADDING_1, c.ZSTD_c_compressionLevel, c.ZSTD_e_end, c.ZSTD_error_prefix_unknown, c.ZSTD_CLEVEL_DEFAULT);
log("classes", typeof zlib.BrotliCompress, typeof zlib.BrotliDecompress, typeof zlib.ZstdCompress, typeof zlib.ZstdDecompress, typeof zlib.createBrotliCompress, typeof zlib.zstdCompressSync);
log("__end__");
