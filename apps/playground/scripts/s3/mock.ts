// A small in-memory S3 for the tests (scripts/s3.ts, scripts/s3-signing.ts): path-style buckets, PUT/GET (Range)/HEAD/
// DELETE of objects, ListObjectsV2, multipart upload, CORS, and a SigV4 check written independently of the playground's
// signer (node:crypto, the canonical request rebuilt from what arrived). Every request is recorded with the result of
// the check, so a test can tell "the server accepted the signature" from "the program saw the right data".
// Run by bun (Bun.serve).
import { createHash, createHmac } from "node:crypto";

export const ACCESS_KEY = "AKIDEXAMPLE";
export const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

export type Recorded = { method: string; path: string; query: string; headers: Record<string, string>; auth: "ok" | string; body?: string };
type Obj = { body: Uint8Array; type: string; etag: string; modified: Date };

const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const hmac = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();
const awsEncode = (s: string, slash = true) => [...new TextEncoder().encode(s)].map((c) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(c)) || (!slash && c === 47) ? String.fromCharCode(c) : "%" + c.toString(16).toUpperCase().padStart(2, "0"))).join("");
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const md5 = (b: Uint8Array) => `"${createHash("md5").update(b).digest("hex")}"`;

/** Rebuilds the canonical request from the request as it arrived and compares the signature. "ok" or why not. */
function verify(req: Request, url: URL, secret: string): string {
  const q = url.searchParams;
  const presigned = q.has("X-Amz-Signature");
  let credential: string, signedHeaders: string, signature: string, date: string;
  if (presigned) {
    credential = q.get("X-Amz-Credential")!;
    signedHeaders = q.get("X-Amz-SignedHeaders")!;
    signature = q.get("X-Amz-Signature")!;
    date = q.get("X-Amz-Date")!;
    const t = Date.parse(date.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"));
    if (Date.now() > t + Number(q.get("X-Amz-Expires")) * 1000) return "expired";
  } else {
    const a = req.headers.get("authorization");
    const m = a?.match(/^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
    if (!m) return `no usable Authorization header: ${a}`;
    [, credential, signedHeaders, signature] = m;
    date = req.headers.get("x-amz-date") ?? "";
  }
  const [akid, day, region, service, term] = credential.split("/");
  if (akid !== ACCESS_KEY) return "InvalidAccessKeyId";
  if (service !== "s3" || term !== "aws4_request" || date.slice(0, 8) !== day) return `bad scope ${credential} / ${date}`;
  // Each path segment as S3 decodes and canonicalizes it.
  const rawPath = url.pathname;
  const path = rawPath.split("/").map((s) => awsEncode(decodeURIComponent(s))).join("/");
  const query = [...q.entries()]
    .filter(([k]) => k !== "X-Amz-Signature")
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const headers = signedHeaders
    .split(";")
    .map((h) => `${h}:${(h === "host" ? req.headers.get("host") : req.headers.get(h))?.trim() ?? ""}\n`)
    .join("");
  const payload = presigned ? "UNSIGNED-PAYLOAD" : (req.headers.get("x-amz-content-sha256") ?? "");
  const canonical = [req.method, path, query, headers, signedHeaders, payload].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, `${day}/${region}/s3/aws4_request`, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + secret, day), region), "s3"), "aws4_request");
  const want = createHmac("sha256", key).update(toSign).digest("hex");
  return want === signature ? "ok" : `SignatureDoesNotMatch\n${canonical}`;
}

export function startMock(port: number, opts: { region?: string; secret?: string } = {}) {
  const objects = new Map<string, Obj>();
  const uploads = new Map<string, { key: string; type: string; parts: Map<number, Uint8Array> }>();
  const log: Recorded[] = [];
  let nextUpload = 1;
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, content-disposition, content-encoding, range, x-amz-acl, x-amz-content-sha256, x-amz-date, x-amz-request-payer, x-amz-security-token, x-amz-storage-class",
    "access-control-allow-methods": "GET, PUT, POST, DELETE, HEAD",
    "access-control-expose-headers": "ETag, Content-Range, x-amz-request-id",
    "access-control-max-age": "600",
  };
  const err = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
    new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`, { status, headers: { ...cors, "content-type": "application/xml", ...extra } });

  const server = Bun.serve({
    port,
    async fetch(req) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const url = new URL(req.url);
      const headers = Object.fromEntries(req.headers);
      const auth = verify(req, url, opts.secret ?? SECRET_KEY);
      log.push({ method: req.method, path: url.pathname, query: url.search, headers, auth });
      if (auth !== "ok") return err(403, "SignatureDoesNotMatch", auth.split("\n")[0], { "content-type": "application/xml" });
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = rest.map(decodeURIComponent).join("/");
      const q = url.searchParams;
      const id = `${bucket}/${key}`;
      const ok = (body: BodyInit | null, h: Record<string, string> = {}, status = 200) => new Response(body, { status, headers: { ...cors, ...h } });

      if (!key) {
        if (req.method !== "GET" || q.get("list-type") !== "2") return err(400, "InvalidRequest", "bad bucket request");
        const prefix = q.get("prefix") ?? "";
        const delimiter = q.get("delimiter") ?? "";
        const max = Number(q.get("max-keys") ?? 1000);
        const after = q.get("continuation-token") ?? q.get("start-after") ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(bucket + "/")).map((k) => k.slice(bucket.length + 1)).filter((k) => k.startsWith(prefix) && k > after).sort();
        const contents: string[] = [];
        const prefixes = new Set<string>();
        let last = "";
        let truncated = false;
        let count = 0;
        for (const k of keys) {
          const rel = k.slice(prefix.length);
          const cut = delimiter && rel.includes(delimiter) ? prefix + rel.slice(0, rel.indexOf(delimiter) + delimiter.length) : "";
          if (cut && prefixes.has(cut)) continue;
          if (count >= max) {
            truncated = true;
            break;
          }
          count++;
          last = k;
          if (cut) prefixes.add(cut);
          else {
            const o = objects.get(`${bucket}/${k}`)!;
            contents.push(`<Contents><Key>${xml(k)}</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>${xml(o.etag)}</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`);
          }
        }
        return ok(
          `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${count}</KeyCount><MaxKeys>${max}</MaxKeys>${delimiter ? `<Delimiter>${xml(delimiter)}</Delimiter>` : ""}<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xml(last)}</NextContinuationToken>` : ""}${contents.join("")}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${xml(p)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`,
          { "content-type": "application/xml" },
        );
      }

      if (req.method === "POST" && q.has("uploads")) {
        const uid = `upload-${id.replace(/\W/g, "_")}`;
        uploads.set(uid, { key: id, type: req.headers.get("content-type") ?? "", parts: new Map() });
        return ok(`<?xml version="1.0" encoding="UTF-8"?>\n<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xml(key)}</Key><UploadId>${uid}</UploadId></InitiateMultipartUploadResult>`, { "content-type": "application/xml" });
      }
      if (q.has("uploadId")) {
        const up = uploads.get(q.get("uploadId")!);
        if (!up) return err(404, "NoSuchUpload", "The specified upload does not exist.");
        if (req.method === "PUT") {
          const body = new Uint8Array(await req.arrayBuffer());
          up.parts.set(Number(q.get("partNumber")), body);
          return ok(null, { etag: md5(body) });
        }
        if (req.method === "DELETE") {
          uploads.delete(q.get("uploadId")!);
          return ok(null, {}, 204);
        }
        if (req.method === "POST") {
          const text = await req.text();
          log.at(-1)!.body = text;
          const listed = [...text.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
          const parts = listed.map((n) => up.parts.get(n));
          if (parts.some((p) => !p)) return err(400, "InvalidPart", "One or more of the specified parts could not be found.");
          const body = new Uint8Array(parts.reduce((n, p) => n + p!.length, 0));
          let o = 0;
          for (const p of parts) body.set(p!, (o += p!.length) - p!.length);
          objects.set(up.key, { body, type: up.type, etag: md5(body) + "-" + parts.length, modified: new Date() });
          uploads.delete(q.get("uploadId")!);
          return ok(`<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xml(key)}</Key><ETag>${xml(objects.get(up.key)!.etag)}</ETag></CompleteMultipartUploadResult>`, { "content-type": "application/xml" });
        }
      }
      if (req.method === "PUT") {
        const body = new Uint8Array(await req.arrayBuffer());
        objects.set(id, { body, type: req.headers.get("content-type") ?? "binary/octet-stream", etag: md5(body), modified: new Date() });
        return ok(null, { etag: md5(body) });
      }
      if (req.method === "DELETE") {
        objects.delete(id);
        return ok(null, {}, 204);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const o = objects.get(id);
        if (!o) return err(404, "NoSuchKey", "The specified key does not exist.");
        const h: Record<string, string> = { "content-type": o.type, etag: o.etag, "last-modified": o.modified.toUTCString(), "accept-ranges": "bytes" };
        const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
        let body = o.body;
        let status = 200;
        if (range) {
          const from = Number(range[1]);
          const to = Math.min(range[2] ? Number(range[2]) : o.body.length - 1, o.body.length - 1);
          body = o.body.slice(from, to + 1);
          status = 206;
          h["content-range"] = `bytes ${from}-${to}/${o.body.length}`;
        }
        if (req.method === "HEAD") return new Response(null, { status, headers: { ...cors, ...h, "content-length": String(body.length) } });
        return ok(body, h, status);
      }
      return err(405, "MethodNotAllowed", "nope");
    },
  });
  return {
    server,
    objects,
    log,
    uploads,
    port: server.port,
    url: `http://localhost:${server.port}`,
    put: (id: string, text: string | Uint8Array, type = "text/plain") => {
      const body = typeof text === "string" ? new TextEncoder().encode(text) : text;
      objects.set(id, { body, type, etag: md5(body), modified: new Date("2026-01-02T03:04:05Z") });
    },
    stop: () => server.stop(true),
  };
}
