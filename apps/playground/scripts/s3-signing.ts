#!/usr/bin/env bun
// The playground's S3 client (src/worker/s3.ts) against native Bun's, no browser: the signing primitive against AWS's
// published SigV4 example, presigned URLs and the signed requests of every operation byte for byte (Bun signs with the
// clock, so each of ours is signed at the time of the request native Bun just made), and what the operations return and
// throw. The requests go to a local S3 (scripts/s3/mock.ts) that checks each signature independently.
//   bun scripts/s3-signing.ts
import { createS3, sign, type Deps } from "../src/worker/s3";
import { ACCESS_KEY, SECRET_KEY, startMock, type Recorded } from "./s3/mock";

let bad = 0;
let checks = 0;
const same = (label: string, got: unknown, want: unknown) => {
  checks++;
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g === w) return;
  bad++;
  // For lists of requests, the first one that differs.
  const at = Array.isArray(got) && Array.isArray(want) ? Math.max(0, got.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(want[i]))) : -1;
  const [gg, ww] = at >= 0 ? [JSON.stringify((got as unknown[])[at]) ?? "none", JSON.stringify((want as unknown[])[at]) ?? "none"] : [g, w];
  console.error(`✗ ${label}\n  got  ${gg.slice(0, 900)}\n  want ${ww.slice(0, 900)}`);
};

// ---- AWS's published example: "Authenticating Requests: Using Query Parameters", GET /test.txt, 86400 s, 2013-05-24 ----
{
  const url = sign(
    { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", endpoint: "examplebucket.s3.amazonaws.com", insecureHttp: false, bucket: "examplebucket", sessionToken: "", virtualHostedStyle: true },
    { path: "test.txt", method: "GET", expires: 86400 },
    new Date("2013-05-24T00:00:00Z"),
  ).url;
  same(
    "AWS presign example",
    url,
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404&X-Amz-SignedHeaders=host",
  );
}

// What an error or a value is, for comparing the two implementations.
const outcome = async (f: () => unknown) => {
  try {
    const v = await f();
    return { value: typeof v === "object" && v !== null ? JSON.parse(JSON.stringify(v)) : v, kind: Object.prototype.toString.call(v) };
  } catch (e) {
    const x = e as Error & { code?: string; path?: string };
    return { error: [x.constructor.name, x.name, x.code, x.message, x.path] };
  }
};

const mock = startMock(0);
const bucket = "b";
const base = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, bucket, endpoint: mock.url, region: "us-east-1" };
mock.put(`${bucket}/seed/a.txt`, "hello world");
mock.put(`${bucket}/seed/b.json`, '{"a":1}', "application/json");
mock.put(`${bucket}/dir/x`, "x");
mock.put(`${bucket}/dir/y`, "y");
mock.put(`${bucket}/dir/sub/z`, "z");

const parseDate = (d: string) => new Date(d.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"));
let clock: Date[] = [];
const deps: Deps = {
  env: () => process.env,
  fetch: () => globalThis.fetch,
  track: (p) => p,
  now: () => clock.shift() ?? clock[0] ?? new Date(),
};
const mine = createS3(deps);
const Native = Bun.S3Client;
type Client = typeof Bun.S3Client;
const Mine = mine.S3Client as unknown as Client;

// Headers whose values are the client's: everything else (accept, user-agent, connection...) is the HTTP library's.
const compared = (r: Recorded) => ({
  method: r.method,
  path: r.path,
  query: r.query.replace(/uploadId=[^&]+/, "uploadId=UP"),
  auth: r.auth,
  headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => k === "authorization" || k.startsWith("x-amz-") || ["content-type", "content-disposition", "content-encoding", "content-length", "range"].includes(k)).map(([k, v]) => [k, k === "x-amz-date" || k === "authorization" ? v.replace(/\d{8}T\d{6}Z/g, "DATE") : v])),
});

type Scenario = (S3: Client, mk: (o?: object) => InstanceType<Client>) => unknown;
const scenarios: Record<string, Scenario> = {
  "write string": (_, c) => c().write("seed/new.txt", "hello"),
  "write bytes": (_, c) => c().write("seed/new.bin", new Uint8Array([1, 2, 3])),
  "write bytes with type": (_, c) => c().write("seed/new.bin", new Uint8Array([1, 2, 3]), { type: "application/x-foo" }),
  "write typed blob, no extension": (_, c) => c().write("seed/tb", new Blob(["xyz"], { type: "text/x" })),
  "write typed response, no extension": (_, c) => c().write("seed/tr", new Response("r", { headers: { "content-type": "text/y" } })),
  "write blob, extension and type": (_, c) => c().write("seed/tb.txt", new Blob(["xyz"], { type: "text/x" })),
  "write json type": (_, c) => c().write("seed/j", "{}", { type: "application/json" }),
  "write explicit text type": (_, c) => c().write("seed/e.txt", "x", { type: "text/zzz" }),
  "write string, no extension": (_, c) => c().write("seed/noext", "string"),
  "write css": (_, c) => c().write("seed/a.css", "a{}"),
  "write blob": (_, c) => c().write("seed/new.blob", new Blob(["xyz"], { type: "text/x" }), { type: "text/x" }),
  "write response": (_, c) => c().write("seed/new.resp", new Response("resp")),
  "write number": (_, c) => c().write("seed/new.num", 123 as never),
  "write empty": (_, c) => c().write("seed/empty", ""),
  "write acl, class, disposition, encoding": (_, c) => c().write("seed/o.txt", "x", { acl: "public-read", storageClass: "STANDARD_IA", contentDisposition: "inline", contentEncoding: "identity", type: "text/zzz" }),
  "write with session token": (_, c) => c({ sessionToken: "tok/+=" }).write("seed/t.txt", "x"),
  "write requestPayer": (_, c) => c({ requestPayer: true }).write("seed/p.txt", "x"),
  "write odd key": (_, c) => c().write("sp ace/ü!*'()~ #?%.txt", "x"),
  "write leading slash": (_, c) => c().write("/lead/slash.txt", "x"),
  "write backslash": (_, c) => c().write("a\\b.txt", "x"),
  "multipart stream": async (_, c) => {
    const chunk = new Uint8Array(1024 * 1024).map((_, i) => (i * 7) & 255);
    const body = new ReadableStream({ start(k) { for (let i = 0; i < 12; i++) k.enqueue(chunk); k.close(); } });
    return [await c().write("seed/mp.bin", new Response(body)), (await c().stat("seed/mp.bin")).etag];
  },
  "multipart stream, uneven chunks": async (_, c) => {
    const body = new ReadableStream({ start(k) { for (let i = 0; i < 9; i++) k.enqueue(new Uint8Array(1300000).fill(i)); k.close(); } });
    return [await c().write("seed/mp2.bin", new Response(body)), (await c().stat("seed/mp2.bin")).etag];
  },
  "multipart writer": async (_, c) => {
    const w = c().file("seed/mp3.bin").writer();
    for (let i = 0; i < 6; i++) w.write(new Uint8Array(1024 * 1024).fill(i));
    return [await w.end(), (await c().stat("seed/mp3.bin")).etag];
  },
  "multipart, queueSize 1": async (_, c) => {
    const body = new ReadableStream({ start(k) { for (let i = 0; i < 6; i++) k.enqueue(new Uint8Array(1024 * 1024).fill(i)); k.close(); } });
    return [await c({ queueSize: 1 }).write("seed/mp4.bin", new Response(body)), (await c().stat("seed/mp4.bin")).etag];
  },
  "multipart, exactly one part": async (_, c) => {
    const body = new ReadableStream({ start(k) { k.enqueue(new Uint8Array(5 * 1024 * 1024).fill(3)); k.close(); } });
    return [await c().write("seed/mp5.bin", new Response(body)), (await c().stat("seed/mp5.bin")).etag];
  },
  "in-memory blob over a part": async (_, c) => [await c().write("seed/big.bin", new Uint8Array(6 * 1024 * 1024).fill(1)), (await c().stat("seed/big.bin")).etag],
  "write stream": (_, c) => c().write("seed/stream.txt", new Response(new ReadableStream({ start(k) { k.enqueue(new TextEncoder().encode("abc")), k.enqueue(new TextEncoder().encode("def")), k.close(); } }))),
  "write no data": (_, c) => (c() as never as { write(p: string): unknown }).write("seed/x"),
  "write no path": (_, c) => (c() as never as { write(): unknown }).write(),
  "exists": (_, c) => c().exists("seed/a.txt"),
  "exists missing": (_, c) => c().exists("seed/nope"),
  "exists requestPayer": (_, c) => c().exists("seed/a.txt", { requestPayer: true }),
  "exists bad path": (_, c) => c().exists(5 as never),
  "exists no path": (_, c) => (c() as never as { exists(): unknown }).exists(),
  "size": (_, c) => c().size("seed/a.txt"),
  "size missing": (_, c) => c().size("seed/nope"),
  "stat": async (_, c) => {
    const s = await c().stat("seed/b.json");
    return [s.size, s.etag, s.type, s.lastModified instanceof Date, Object.keys(s), Object.prototype.toString.call(s)];
  },
  "stat missing": (_, c) => c().stat("seed/nope"),
  "text": (_, c) => c().file("seed/a.txt").text(),
  "json": (_, c) => c().file("seed/b.json").json(),
  "bytes": async (_, c) => [...(await c().file("seed/a.txt").bytes())],
  "arrayBuffer": async (_, c) => (await c().file("seed/a.txt").arrayBuffer()).byteLength,
  "stream": async (_, c) => new Response(c().file("seed/a.txt").stream()).text(),
  "text missing": (_, c) => c().file("seed/nope").text(),
  "json missing": (_, c) => c().file("seed/nope").json(),
  "slice(1, 3)": (_, c) => c().file("seed/a.txt").slice(1, 3).text(),
  "slice(2)": (_, c) => c().file("seed/a.txt").slice(2).text(),
  "slice(0, 4)": (_, c) => c().file("seed/a.txt").slice(0, 4).text(),
  "slice of slice": (_, c) => c().file("seed/a.txt").slice(2, 8).slice(1, 3).text(),
  "slice props": (_, c) => {
    const s = c().file("seed/a.txt").slice(1, 3, "text/x");
    return [s.size, s.name, s.type, c().file("seed/a.txt").slice(1).size, c().file("seed/a.txt").size];
  },
  "file props": (_, c) => {
    const f = c().file("seed/a.txt");
    return [f.name, f.size, f.type, f.bucket, f instanceof Blob, Object.prototype.toString.call(f), c().file("k", { type: "TEXT/Q" }).type];
  },
  "file.write": async (_, c) => {
    const f = c().file("seed/fw.txt", { type: "text/fw" });
    return [await f.write("viafile"), await f.text(), (await f.stat()).type];
  },
  "file.write json": async (_, c) => [await c().file("seed/fj.json").write(JSON.stringify({ a: 1 }), { type: "application/json" }), await c().file("seed/fj.json").json()],
  "file.writer": async (_, c) => {
    const w = c().file("seed/w.txt").writer();
    return [w.write("ab"), w.write(new Uint8Array(2).fill(99)), await w.flush(), await w.end(), await c().file("seed/w.txt").text()];
  },
  "file.exists": (_, c) => c().file("seed/a.txt").exists(),
  "file.delete": async (_, c) => {
    await c().write("seed/del1", "x");
    return [await c().file("seed/del1").delete(), await c().file("seed/del1").exists()];
  },
  "file.stat": async (_, c) => (await c().file("seed/a.txt").stat()).size,
  "delete": async (_, c) => {
    await c().write("seed/del2", "x");
    return [await c().delete("seed/del2"), await c().unlink("seed/del2")];
  },
  "list": (_, c) => c().list(),
  "list prefix": (_, c) => c().list({ prefix: "dir/" }),
  "list delimiter": (_, c) => c().list({ delimiter: "/" }),
  "list prefix and delimiter": (_, c) => c().list({ prefix: "dir/", delimiter: "/" }),
  "list maxKeys": (_, c) => c().list({ maxKeys: 2 }),
  "list continuation": async (_, c) => {
    const first = await c().list({ prefix: "dir/", maxKeys: 1 });
    return [first, await c().list({ prefix: "dir/", maxKeys: 1, continuationToken: first.nextContinuationToken })];
  },
  "list all options": (_, c) => c().list({ fetchOwner: true, encodingType: "url", startAfter: "dir/x", prefix: "dir/", maxKeys: 5, delimiter: "/", continuationToken: "dir/x" }),
  "list fetchOwner false": (_, c) => c().list({ fetchOwner: false }),
  "list empty": (_, c) => c().list({ prefix: "zzz" }),
  "list special prefix": (_, c) => c().list({ prefix: "a b/ü&=+" }),
  "no credentials": (_, c) => c({ accessKeyId: undefined, secretAccessKey: "" }).file("seed/a.txt").text(),
  "wrong secret": (_, c) => c({ secretAccessKey: "nope" }).file("seed/a.txt").text(),
  "wrong secret write": (_, c) => c({ secretAccessKey: "nope" }).write("seed/a.txt", "x"),
  "wrong secret exists": (_, c) => c({ secretAccessKey: "nope" }).exists("seed/a.txt"),
  "wrong secret delete": (_, c) => c({ secretAccessKey: "nope" }).delete("seed/a.txt"),
  "wrong secret stat": (_, c) => c({ secretAccessKey: "nope" }).stat("seed/a.txt"),
  "wrong secret delete": (_, c) => c({ secretAccessKey: "nope" }).delete("seed/a.txt"),
  "wrong secret stat": (_, c) => c({ secretAccessKey: "nope" }).stat("seed/a.txt"),
  "wrong secret list": (_, c) => c({ secretAccessKey: "nope" }).list(),
  "bucket from the path": (_, c) => c({ bucket: undefined }).file("b/seed/a.txt").text(),
  "no bucket, no slash": (_, c) => c({ bucket: undefined }).file("seed").text(),
  "empty path": (_, c) => c().file("").text(),
  "endpoint with a slash": (_, c) => c({ endpoint: mock.url + "/" }).file("seed/a.txt").text(),
  "bad endpoint type": (_, c) => c({ endpoint: 5 }),
  "bad key type": (_, c) => c({ accessKeyId: 5 }),
  "bad acl": (_, c) => c({ acl: "nope" }),
  "bad partSize": (_, c) => c({ partSize: 1 }),
  "bad queueSize": (_, c) => c({ queueSize: 0 }),
  "bad retry": (_, c) => c({ retry: 300 }),
  "file no path": (_, c) => (c() as never as { file(): unknown }).file(),
  "file bad path": (_, c) => c().file({} as never),
  "static write+exists+size+list+unlink": async (S3, _) => {
    const o = { ...base };
    return [await S3.write("seed/st.txt", "static", o), await S3.exists("seed/st.txt", o), await S3.size("seed/st.txt", o), (await S3.list({ prefix: "seed/st" }, o)).contents?.length, await S3.file("seed/st.txt", o).text(), (await S3.stat("seed/st.txt", o)).size, await S3.unlink("seed/st.txt", o)];
  },
  "static no credentials": (S3) => S3.exists("seed/a.txt"),
  "static presign": (S3) => S3.presign("seed/a.txt", { ...base, expiresIn: 5 }).replace(/X-Amz-Date=\d+T\d+Z|X-Amz-Signature=[0-9a-f]+/g, "X"),
};

/** Presign options whose URL must match: the key, per-call options and the client's. */
const presigns: [string, object, object, string | undefined][] = [
  ["default", {}, {}, undefined],
  ["expiresIn", {}, { expiresIn: 900 }, undefined],
  ["PUT", {}, { method: "PUT", expiresIn: 60 }, undefined],
  ["DELETE", {}, { method: "DELETE" }, undefined],
  ["HEAD", {}, { method: "HEAD" }, undefined],
  ["acl", {}, { acl: "public-read" }, undefined],
  ["client acl, no options", { acl: "private" }, undefined as never, undefined],
  ["client acl, empty options", { acl: "private" }, {}, undefined],
  ["storage class", {}, { storageClass: "STANDARD_IA" }, undefined],
  ["disposition and type", {}, { contentDisposition: 'attachment; filename="x y.txt"', type: "text/plain; charset=utf-8" }, undefined],
  ["session token", { sessionToken: "tok/+=" }, {}, undefined],
  ["requestPayer", {}, { requestPayer: true }, undefined],
  ["all of it", { sessionToken: "t" }, { method: "PUT", expiresIn: 1, acl: "bucket-owner-full-control", storageClass: "GLACIER", contentDisposition: "a", type: "b", requestPayer: true }, undefined],
  ["region", { region: "eu-central-1" }, {}, undefined],
  ["no region, AWS endpoint", { region: undefined, endpoint: undefined }, {}, undefined],
  ["AWS endpoint in another region", { region: undefined, endpoint: "https://s3.eu-west-2.amazonaws.com" }, {}, undefined],
  ["R2", { region: undefined, endpoint: "https://acct.r2.cloudflarestorage.com" }, {}, undefined],
  ["R2 with a region", { endpoint: "https://acct.r2.cloudflarestorage.com" }, {}, undefined],
  ["MinIO, http", { endpoint: "http://localhost:9000" }, {}, undefined],
  ["endpoint without a scheme", { endpoint: "minio.example.com:9000" }, {}, undefined],
  ["endpoint with a path", { endpoint: "https://example.com/storage/s3/" }, {}, undefined],
  ["default https port", { endpoint: "https://example.com:443" }, {}, undefined],
  ["virtual hosted", { endpoint: undefined, virtualHostedStyle: true }, {}, undefined],
  ["virtual hosted, endpoint", { endpoint: "https://b.s3.us-east-1.amazonaws.com", virtualHostedStyle: true }, {}, undefined],
  ["virtual hosted, R2", { endpoint: "https://b.acct.r2.cloudflarestorage.com", virtualHostedStyle: true, region: undefined }, {}, undefined],
  ["virtual hosted, no bucket", { endpoint: undefined, virtualHostedStyle: true, bucket: undefined }, {}, undefined],
  ["bucket from the key", { bucket: undefined }, {}, "other/key.txt"],
  ["no bucket, no slash", { bucket: undefined }, {}, "key"],
  ["bad region", { endpoint: undefined, region: "us east" }, {}, undefined],
  ["unicode and reserved key", {}, {}, "dir/ü ö/!*'()~$&+,;=:@ #?.txt"],
  ["leading and trailing slashes", {}, {}, "//a/b//"],
  ["backslashes", {}, {}, "a\\b\\c"],
  ["empty key", {}, {}, ""],
  ["key of 900 bytes", {}, {}, "k".repeat(900)],
  ["POST", {}, { method: "POST" }, undefined],
  ["lower case method", {}, { method: "put" }, undefined],
  ["PATCH", {}, { method: "PATCH" }, undefined],
  ["unknown method", {}, { method: "FETCH" }, undefined],
  ["expiresIn 0", {}, { expiresIn: 0 }, undefined],
  ["expiresIn negative", {}, { expiresIn: -5 }, undefined],
  ["bad acl", {}, { acl: "x" }, undefined],
  ["no credentials", { accessKeyId: undefined }, {}, undefined],
  ["newline in a header value", {}, { contentDisposition: "a\nb" }, undefined],
  ["session token with newline", { sessionToken: "a\nb" }, {}, undefined],
];

try {
  // ---- presigned URLs: the same clock, the same URL ----
  const stamp = (url: string) => parseDate(/X-Amz-Date=(\d{8}T\d{6}Z)/.exec(url)?.[1] ?? "");
  for (const [label, client, options, key = "seed/a.txt"] of presigns) {
    const run = (S3: Client) => {
      const c = new S3({ ...base, ...client } as never);
      return options === undefined ? c.presign(key) : c.presign(key, options as never);
    };
    let a = await outcome(() => run(Native));
    const url = (a.value as string | undefined) ?? "";
    clock = [url ? stamp(url) : new Date()];
    const b = await outcome(() => run(Mine));
    same(`presign ${label}`, b, a);
    // The file's own presign, and the static one on the environment's credentials.
    const f = async (S3: Client) => (options === undefined ? new S3({ ...base, ...client } as never).file(key).presign() : new S3({ ...base, ...client } as never).file(key).presign(options as never));
    a = await outcome(() => f(Native));
    clock = [(a.value as string | undefined) ? stamp(a.value as string) : new Date()];
    same(`file.presign ${label}`, await outcome(() => f(Mine)), a);
  }

  // ---- operations: the same requests, the same results ----
  const order = (l: Recorded[]) => [...l].sort((x, y) => (x.method + x.path + x.query < y.method + y.path + y.query ? -1 : 1));
  for (const [label, run] of Object.entries(scenarios)) {
    const make = (S3: Client) => (o: object = {}) => new S3({ ...base, ...o } as never);
    for (let attempt = 0; ; attempt++) {
      mock.log.length = 0;
      const nativeResult = await outcome(() => run(Native, make(Native)));
      const native = mock.log.splice(0);
      // Ours are signed at the second of each request native Bun made (the static presign has none: its URL is masked).
      clock = native.map((r) => parseDate(r.headers["x-amz-date"] ?? ""));
      const mineResult = await outcome(() => run(Mine, make(Mine)));
      const mineLog = mock.log.splice(0);
      const [a, b] = [order(native).map(compared), order(mineLog).map(compared)];
      // Native Bun's own requests of one operation can fall in different seconds; a second's tick in between is retried.
      if (attempt < 2 && JSON.stringify(a) !== JSON.stringify(b) && new Set(clock.map(Number)).size > 1) continue;
      same(`${label}: result`, mineResult, nativeResult);
      same(`${label}: requests`, b, a);
      for (const r of [...native, ...mineLog]) if (r.auth !== "ok" && !/wrong secret|no credentials/.test(label)) same(`${label}: the mock accepts the signature`, r.auth, "ok");
      break;
    }
  }
  same("objects written", mock.objects.size > 10, true);
} finally {
  mock.stop();
}

console.log(bad ? `${bad} of ${checks} checks failed` : `✓ s3 signing and operations: ${checks} checks match native Bun`);
process.exit(bad ? 1 : 0);
