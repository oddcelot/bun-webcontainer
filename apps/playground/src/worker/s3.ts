// `Bun.S3Client`, `Bun.s3` and S3 files over fetch: a port of what Bun does (bun/src/s3_signing, runtime/webcore/S3*.rs,
// webcore/s3/*.rs). Requests are signed with SigV4 (UNSIGNED-PAYLOAD, as Bun does, so signing is a few synchronous HMACs
// and `presign` is synchronous too) and sent with the worker's fetch. A browser needs the bucket's CORS rules to allow
// the page's origin, every method used, the headers it signs, and to expose ETag.
//
// Pure of the worker's globals: runtime.ts passes `env`, `fetch` and the promise tracker in (createS3), so
// scripts/s3-signing.ts can run this file in Bun against Bun's own signatures.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { mimeByName, mimeOf } from "./mime";

// ---------------------------------------------------------------------------------------------------------------------
// Signing (credentials.rs)
// ---------------------------------------------------------------------------------------------------------------------

export type Creds = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** The endpoint's host (with the port) and path, as Bun keeps it: `localhost:9000`, `acct.r2.cloudflarestorage.com`. */
  endpoint: string;
  insecureHttp: boolean;
  bucket: string;
  sessionToken: string;
  virtualHostedStyle: boolean;
};
export type Multipart = { partSize: number; queueSize: number; retry: number };
/** What a client or file carries besides credentials. */
export type Conf = { creds: Creds; multipart: Multipart; acl?: string; storageClass?: string; requestPayer: boolean };

export type SignOptions = {
  path: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD" | "POST";
  /** `?a=b&c=d`, already encoded and sorted by name. */
  search?: string;
  contentDisposition?: string;
  contentType?: string;
  contentEncoding?: string;
  acl?: string;
  storageClass?: string;
  requestPayer?: boolean;
  /** Seconds: a presigned URL (the query string carries the signature) instead of headers. */
  expires?: number;
  /** An empty path is allowed (listing a bucket). */
  allowEmptyPath?: boolean;
};
export type Signed = { url: string; headers: Record<string, string> };

export class SignError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const SIGN_ERRORS = {
  MissingCredentials: ["ERR_S3_MISSING_CREDENTIALS", "Missing S3 credentials. 'accessKeyId', 'secretAccessKey', 'bucket', and 'endpoint' are required"],
  InvalidMethod: ["ERR_S3_INVALID_METHOD", "Method must be GET, PUT, DELETE or HEAD when using s3:// protocol"],
  InvalidPath: ["ERR_S3_INVALID_PATH", "Invalid S3 bucket, key combination"],
  InvalidEndpoint: ["ERR_S3_INVALID_ENDPOINT", "Invalid S3 endpoint"],
  InvalidSessionToken: ["ERR_S3_INVALID_SESSION_TOKEN", "Invalid session token"],
  Signature: ["ERR_S3_INVALID_SIGNATURE", "Failed to retrieve S3 content. Are the credentials correct?"],
} as const;
const fail = (e: keyof typeof SIGN_ERRORS): never => {
  throw new SignError(SIGN_ERRORS[e][0], SIGN_ERRORS[e][1]);
};

const enc = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const hex = (b: Uint8Array) => Array.from(b, (x) => HEX[x]).join("");
const mac = (key: Uint8Array | string, data: string) => hmac(sha256, typeof key === "string" ? enc.encode(key) : key, enc.encode(data));

/** Everything but RFC 3986's unreserved characters, percent-encoded as UTF-8; `/` stays unless `slash`, `\` becomes `/`. */
export function awsEncode(s: string, slash = true): string {
  let out = "";
  for (const b of enc.encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else if (!slash && (c === "/" || c === "\\")) out += "/";
    else out += "%" + HEX[b].toUpperCase();
  }
  return out;
}

export function guessRegion(endpoint: string): string {
  if (!endpoint) return "us-east-1";
  if (endpoint.endsWith(".r2.cloudflarestorage.com")) return "auto";
  const end = endpoint.indexOf(".amazonaws.com");
  if (end >= 0) {
    const start = endpoint.indexOf("s3.");
    if (start >= 0) return endpoint.slice(start + 3, end) || "us-east-1";
  }
  return "auto";
}

/** The bucket a virtual-hosted endpoint names, for display. */
export function guessBucket(endpoint: string): string | undefined {
  if (endpoint.includes(".amazonaws.com")) {
    const end = endpoint.indexOf(".s3.");
    if (end >= 0) {
      const start = endpoint.indexOf("/");
      return start < 0 ? endpoint.slice(0, end) : endpoint.slice(start + 1, end) || endpoint.slice(0, end);
    }
  } else {
    const r2 = endpoint.indexOf(".r2.cloudflarestorage.com");
    if (r2 >= 0) {
      const end = endpoint.indexOf(".");
      if (end > 0 && r2 === end) return undefined;
      const start = endpoint.indexOf("/");
      return start < 0 ? endpoint.slice(0, end) : endpoint.slice(start + 1, end) || endpoint.slice(0, end);
    }
  }
  return undefined;
}

const trimSlashes = (s: string) => s.replace(/^[/\\]+|[/\\]+$/g, "");
const noLineBreaks = (s: string) => !/[\r\n]/.test(s);

/**
 * Signs one request for `now`: the URL to call and the headers to send, or (with `expires`) the presigned URL.
 * Byte for byte what Bun's `S3Credentials::sign_request` gives.
 */
export function sign(c: Creds, o: SignOptions, now = new Date()): Signed {
  const empty = (s: string | undefined) => (s ? s : undefined);
  const contentDisposition = empty(o.contentDisposition);
  const contentType = empty(o.contentType);
  const contentEncoding = empty(o.contentEncoding);
  const sessionToken = empty(c.sessionToken);
  const { acl, storageClass } = o;
  if (!c.accessKeyId || !c.secretAccessKey) fail("MissingCredentials");
  if (!["GET", "POST", "PUT", "DELETE", "HEAD"].includes(o.method)) fail("InvalidMethod");
  const query = o.expires !== undefined;
  const region = c.region || guessRegion(c.endpoint);

  let full = o.path;
  if (full.startsWith("/") || full.startsWith("\\")) full = full.slice(1);
  let path = full;
  let bucket = c.bucket;
  if (!c.virtualHostedStyle && !bucket) {
    const i = full.indexOf("/");
    const j = full.indexOf("\\");
    if (i >= 0) [bucket, path] = [full.slice(0, i), full.slice(i + 1)];
    else if (j >= 0) [bucket, path] = [full.slice(0, j), full.slice(j + 1)];
    else return fail("InvalidPath");
  }
  path = trimSlashes(path);
  bucket = trimSlashes(bucket);
  if (!o.allowEmptyPath && !path) fail("InvalidPath");
  const bucketEnc = awsEncode(bucket, false);
  const pathEnc = awsEncode(path, false);
  // Bun's fixed buffers: a key of 1024 bytes and a bucket of 63 at most, once encoded.
  if (enc.encode(bucketEnc).length > 63 || enc.encode(pathEnc).length > 1024) fail("InvalidPath");
  const protocol = c.insecureHttp ? "http" : "https";

  let host: string;
  let extra = "";
  if (c.endpoint) {
    if (c.endpoint.length >= 2048) fail("InvalidEndpoint");
    const i = c.endpoint.indexOf("/");
    host = i >= 0 ? c.endpoint.slice(0, i) : c.endpoint;
    if (i >= 0) extra = c.endpoint.slice(i);
  } else {
    if (!/^[A-Za-z0-9._-]+$/.test(region)) fail("InvalidEndpoint");
    if (c.virtualHostedStyle) {
      if (!bucketEnc || bucketEnc.includes("/")) fail("InvalidEndpoint");
      host = `${bucketEnc}.s3.${region}.amazonaws.com`;
    } else host = `s3.${region}.amazonaws.com`;
  }
  const normalizedPath = c.virtualHostedStyle ? `${extra}/${pathEnc}` : `${extra}/${bucketEnc}/${pathEnc}`;

  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const hash = "UNSIGNED-PAYLOAD";
  const keySigning = mac(mac(mac(mac("AWS4" + c.secretAccessKey, day), region), "s3"), "aws4_request");
  const signature = (canonical: string) => hex(mac(keySigning, `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(sha256(enc.encode(canonical)))}`));

  if (query) {
    // Query parameters in the order Bun writes them (which is alphabetical), the signature between the token and SignedHeaders.
    const parts: [string, string][] = [];
    if (acl) parts.push(["X-Amz-Acl", acl]);
    parts.push(["X-Amz-Algorithm", "AWS4-HMAC-SHA256"], ["X-Amz-Credential", `${c.accessKeyId}%2F${day}%2F${region}%2Fs3%2Faws4_request`], ["X-Amz-Date", amzDate], ["X-Amz-Expires", String(o.expires)]);
    if (sessionToken) parts.push(["X-Amz-Security-Token", awsEncode(sessionToken)]);
    parts.push(["X-Amz-SignedHeaders", "host"]);
    if (contentDisposition) parts.push(["response-content-disposition", awsEncode(contentDisposition)]);
    if (contentType) parts.push(["response-content-type", awsEncode(contentType)]);
    if (o.requestPayer) parts.push(["x-amz-request-payer", "requester"]);
    if (storageClass) parts.push(["x-amz-storage-class", storageClass]);
    const join = (p: [string, string][]) => p.map(([k, v]) => `${k}=${v}`).join("&");
    const sig = signature(`${o.method}\n${normalizedPath}\n${join(parts)}\nhost:${host}\n\nhost\n${hash}`);
    const at = parts.findIndex(([k]) => k === "X-Amz-SignedHeaders");
    parts.splice(at, 0, ["X-Amz-Signature", sig]);
    return { url: `${protocol}://${host}${normalizedPath}?${join(parts)}`, headers: {} };
  }

  // Signed headers, alphabetically.
  const h: [string, string][] = [];
  if (contentDisposition) h.push(["content-disposition", contentDisposition]);
  if (contentEncoding) h.push(["content-encoding", contentEncoding]);
  h.push(["host", host]);
  if (acl) h.push(["x-amz-acl", acl]);
  h.push(["x-amz-content-sha256", hash], ["x-amz-date", amzDate]);
  if (o.requestPayer) h.push(["x-amz-request-payer", "requester"]);
  if (sessionToken) h.push(["x-amz-security-token", sessionToken]);
  if (storageClass) h.push(["x-amz-storage-class", storageClass]);
  const signed = h.map(([k]) => k).join(";");
  const search = o.search ?? "";
  const canonical = `${o.method}\n${normalizedPath}\n${search.slice(1)}\n${h.map(([k, v]) => `${k}:${v}\n`).join("")}\n${signed}\n${hash}`;
  const sig = signature(canonical);
  const values = [hash, search, acl, storageClass, contentDisposition, contentEncoding, sessionToken, region, c.accessKeyId, host];
  if (!values.every((v) => v === undefined || noLineBreaks(v))) fail("Signature");
  const headers: Record<string, string> = {};
  for (const [k, v] of h) if (k !== "host") headers[k] = v;
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  return { url: `${protocol}://${host}${normalizedPath}${search}`, headers };
}

// ---------------------------------------------------------------------------------------------------------------------
// Options (credentials_jsc.rs)
// ---------------------------------------------------------------------------------------------------------------------

const ACLS = ["private", "public-read", "public-read-write", "aws-exec-read", "authenticated-read", "bucket-owner-read", "bucket-owner-full-control", "log-delivery-write"];
const STORAGE_CLASSES = ["STANDARD", "STANDARD_IA", "INTELLIGENT_TIERING", "EXPRESS_ONEZONE", "ONEZONE_IA", "GLACIER", "GLACIER_IR", "REDUCED_REDUNDANCY", "OUTPOSTS", "DEEP_ARCHIVE", "SNOW"];
const MIB = 1024 * 1024;
const MIN_PART = 5 * MIB;
const MAX_PART = 5120 * MIB;

const codeError = (Ctor: ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor, code: string, message: string) => Object.assign(new Ctor(message), { code });
/** Node's "Received …" suffix. */
const received = (v: unknown) => (typeof v === "function" ? `function ${v.name}` : v !== null && typeof v === "object" ? `an instance of ${(v as object).constructor?.name ?? "Object"}` : `type ${typeof v} (${typeof v === "string" ? `'${v}'` : String(v)})`);
const argType = (name: string, v: unknown) => codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type string. Received ${received(v)}`);
const range = (name: string, v: number, min: number, max?: number) =>
  codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be >= ${min}${max !== undefined ? ` and <= ${max}` : ""}. Received ${v}`);

/** `endpoint` as Bun parses it: the host and path, and whether it says `http://`; `undefined` if it isn't a URL. */
export function parseEndpoint(input: string): { host: string; http: boolean } | undefined {
  if (!input) return undefined;
  const url = URL.parse(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : "https://" + input);
  if (!url || !url.host) return undefined;
  return { host: url.host + url.pathname.replace(/\/$/, ""), http: url.protocol === "http:" };
}

/** A string option as Bun reads it: absent when falsy or empty; a truthy non-string is an error. */
function str(o: Record<string, unknown>, key: string, strict = true): string | undefined {
  const v = o[key];
  if (!v) return undefined;
  if (typeof v !== "string") {
    if (strict) throw argType(key, v);
    return undefined;
  }
  return v;
}
function oneOf(o: Record<string, unknown>, key: string, list: string[]): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !list.includes(v)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `${key} must be one of ${list.map((s) => `"${s}"`).join(", ")}`);
  return v;
}

export type FileOptions = { contentDisposition?: string; contentEncoding?: string; contentType?: string };
export type Parsed = Conf & FileOptions & { changed: boolean };

/** `getCredentialsWithOptions`: `base` with the options object applied. */
export function withOptions(base: Conf, options: unknown): Parsed {
  const out: Parsed = { creds: { ...base.creds }, multipart: { ...base.multipart }, acl: base.acl, storageClass: base.storageClass, requestPayer: base.requestPayer, changed: false };
  if (!options || typeof options !== "object") return out;
  const o = options as Record<string, unknown>;
  const c = out.creds;
  for (const k of ["accessKeyId", "secretAccessKey", "region"] as const) {
    const v = str(o, k);
    if (v !== undefined) (c[k] = v), (out.changed = true);
  }
  if (o.endpoint) {
    if (typeof o.endpoint !== "string") throw argType("endpoint", o.endpoint);
    const e = parseEndpoint(o.endpoint);
    if (e) {
      c.endpoint = e.host;
      c.insecureHttp = e.http;
      out.changed = true;
    } else throw argType("endpoint", o.endpoint);
  }
  const bucket = str(o, "bucket");
  if (bucket !== undefined) (c.bucket = bucket), (out.changed = true);
  if (typeof o.virtualHostedStyle === "boolean") (c.virtualHostedStyle = o.virtualHostedStyle), (out.changed = true);
  const token = str(o, "sessionToken");
  if (token !== undefined) (c.sessionToken = token), (out.changed = true);
  for (const k of ["pageSize", "partSize"] as const) {
    if (o[k] === undefined || o[k] === null) continue;
    const n = Math.trunc(Number(o[k]));
    if (n < MIN_PART || n > MAX_PART) throw range(k, n, MIN_PART, MAX_PART);
    out.multipart.partSize = n;
  }
  if (o.queueSize !== undefined && o.queueSize !== null) {
    const n = Math.trunc(Number(o.queueSize));
    if (!(n >= 1)) throw range("queueSize", n, 1);
    out.multipart.queueSize = Math.min(n, 255);
  }
  if (o.retry !== undefined && o.retry !== null) {
    const n = Math.trunc(Number(o.retry));
    if (!(n >= 0 && n <= 255)) throw range("retry", n, 0, 255);
    out.multipart.retry = n;
  }
  out.acl = oneOf(o, "acl", ACLS) ?? out.acl;
  out.storageClass = oneOf(o, "storageClass", STORAGE_CLASSES) ?? out.storageClass;
  for (const [k, field] of [["contentDisposition", "contentDisposition"], ["type", "contentType"], ["contentEncoding", "contentEncoding"]] as const) {
    const v = str(o, k);
    if (v === undefined) continue;
    if (!noLineBreaks(v)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `${k} must not contain newline characters (CR/LF)`);
    out[field] = v;
  }
  if (typeof o.requestPayer === "boolean") out.requestPayer = o.requestPayer;
  return out;
}

export const emptyConf = (): Conf => ({
  creds: { accessKeyId: "", secretAccessKey: "", region: "", endpoint: "", insecureHttp: false, bucket: "", sessionToken: "", virtualHostedStyle: false },
  multipart: { partSize: MIN_PART, queueSize: 5, retry: 3 },
  requestPayer: false,
});

/** The credentials Bun reads from the environment: S3_* first, then AWS_*. */
export function envConf(env: Record<string, string | undefined>): Conf {
  const conf = emptyConf();
  const get = (a: string, b: string) => env[a] ?? env[b];
  const c = conf.creds;
  c.accessKeyId = get("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID") ?? "";
  c.secretAccessKey = get("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY") ?? "";
  c.region = get("S3_REGION", "AWS_REGION") ?? "";
  const endpoint = parseEndpoint(get("S3_ENDPOINT", "AWS_ENDPOINT") ?? "");
  if (endpoint) (c.endpoint = endpoint.host), (c.insecureHttp = endpoint.http);
  c.bucket = get("S3_BUCKET", "AWS_BUCKET") ?? "";
  c.sessionToken = get("S3_SESSION_TOKEN", "AWS_SESSION_TOKEN") ?? "";
  return conf;
}

// ---------------------------------------------------------------------------------------------------------------------
// Responses (xml_response.rs, list_objects.rs)
// ---------------------------------------------------------------------------------------------------------------------

const unescapeXml = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => t.replace(/&/g, "&amp;")).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()]!;
  });
/** The text of the first `<name>` in `xml`. */
const tag = (xml: string, name: string): string | undefined => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)) ?? (xml.match(new RegExp(`<${name}\\s*/>`)) ? ["", ""] : null);
  return m ? unescapeXml(m[1]) : undefined;
};
const tags = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
const int = (v: string | undefined) => (v !== undefined && /^\s*\d+\s*$/.test(v) ? Number(v) : undefined);
const bool = (v: string | undefined) => (v?.trim() === "true" ? true : v?.trim() === "false" ? false : undefined);

export type ListResult = {
  name?: string;
  prefix?: string;
  delimiter?: string;
  startAfter?: string;
  encodingType?: string;
  continuationToken?: string;
  nextContinuationToken?: string;
  isTruncated?: boolean;
  keyCount?: number;
  maxKeys?: number;
  contents?: Record<string, unknown>[];
  commonPrefixes?: { prefix: string }[];
};

/** A `ListObjectsV2` response, as Bun's `parse_s3_list_objects_result` reads it; `undefined` if it isn't one. */
export function parseList(body: string): ListResult | undefined {
  body = body.trimStart();
  const root = body.match(/<ListBucketResult(?:\s[^>]*)?>([\s\S]*)<\/ListBucketResult>\s*$/);
  if (!root) return undefined;
  const inner = root[1];
  // Elements of the listing itself, not of its Contents.
  const top = inner.replace(/<Contents(?:\s[^>]*)?>[\s\S]*?<\/Contents>/g, "").replace(/<CommonPrefixes(?:\s[^>]*)?>[\s\S]*?<\/CommonPrefixes>/g, "");
  const nonEmpty = (v: string | undefined) => (v ? v : undefined);
  const out: ListResult = {};
  const put = <K extends keyof ListResult>(k: K, v: ListResult[K]) => {
    if (v !== undefined) out[k] = v;
  };
  put("name", tag(top, "Name"));
  put("prefix", nonEmpty(tag(top, "Prefix")));
  put("delimiter", tag(top, "Delimiter"));
  put("startAfter", tag(top, "StartAfter"));
  put("encodingType", tag(top, "EncodingType"));
  put("continuationToken", tag(top, "ContinuationToken"));
  put("nextContinuationToken", tag(top, "NextContinuationToken"));
  put("isTruncated", bool(tag(top, "IsTruncated")));
  put("keyCount", int(tag(top, "KeyCount")));
  put("maxKeys", int(tag(top, "MaxKeys")));
  const contents = tags(inner, "Contents").map((c) => {
    const key = tag(c, "Key");
    if (key === undefined) return undefined;
    const o: Record<string, unknown> = { key };
    const set = (k: string, v: unknown) => v !== undefined && (o[k] = v);
    set("eTag", tag(c, "ETag"));
    const algorithm = tag(c, "ChecksumAlgorithm");
    if (algorithm !== undefined) {
      o.checksumAlgorithm = algorithm;
      // Bun keeps the original misspelling as a hidden alias.
      Object.defineProperty(o, "checksumAlgorithme", { value: algorithm, enumerable: false, writable: true, configurable: true });
    }
    set("checksumType", tag(c, "ChecksumType"));
    set("lastModified", tag(c, "LastModified"));
    set("size", int(tag(c, "Size")));
    set("storageClass", tag(c, "StorageClass"));
    const owner = tags(c, "Owner")[0];
    if (owner !== undefined) {
      const id = nonEmpty(tag(owner, "ID"));
      const displayName = nonEmpty(tag(owner, "DisplayName"));
      if (id !== undefined || displayName !== undefined) o.owner = { ...(id !== undefined && { id }), ...(displayName !== undefined && { displayName }) };
    }
    return o;
  });
  // Every <Contents> names a key, or the listing is not one.
  if (contents.includes(undefined)) return undefined;
  if (contents.length) out.contents = contents as Record<string, unknown>[];
  const prefixes = tags(inner, "CommonPrefixes").flatMap((p) => tags(p, "Prefix").map(unescapeXml)).filter(Boolean);
  if (prefixes.length) out.commonPrefixes = prefixes.map((prefix) => ({ prefix }));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Client and files
// ---------------------------------------------------------------------------------------------------------------------

/** The methods Bun's HTTP layer knows: any other is an argument error, and these but the five S3 takes fail to sign. */
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"];
const MAX_SIZE = 4503599627370495; // 2^52 - 1: the size Bun gives a range that has no end
const CUSTOM = Symbol.for("nodejs.util.inspect.custom");
type Inspect = (v: unknown, o?: unknown) => string;

/** An S3 error as Bun makes it: `name` and `code` are hidden, `path` shows. */
function s3Error(code: string, message: string, path?: string): Error {
  const e = new Error(message);
  Object.defineProperty(e, "name", { value: "S3Error", enumerable: false, configurable: true, writable: true });
  Object.defineProperty(e, "code", { value: code, enumerable: false, configurable: false, writable: true });
  if (path !== undefined) e.path = path;
  return e;
}
declare global {
  interface Error {
    path?: string;
  }
}

export type Deps = {
  /** The environment Bun's default credentials come from (read on each use of `Bun.s3` and the static methods). */
  env: () => Record<string, string | undefined>;
  fetch: () => typeof fetch;
  /** Wraps a promise the way the worker tracks the ones Bun's APIs return (promises.ts). */
  track: <T>(p: Promise<T>) => Promise<T>;
  now?: () => Date;
};

const pathOf = (p: unknown): string | undefined => (typeof p === "string" ? p : p instanceof URL ? p.href : p instanceof Uint8Array ? new TextDecoder().decode(p) : undefined);

export function createS3(deps: Deps) {
  const now = () => deps.now?.() ?? new Date();
  const track = deps.track;

  /** The path Bun gives an `s3://` URL: what follows the scheme. */
  const unscheme = (p: string) => (p.startsWith("s3://") ? p.slice(5) : p);

  async function http(conf: Conf & FileOptions, o: SignOptions, extra: { body?: BodyInit; range?: string; contentType?: string } = {}, path?: string): Promise<Response> {
    let signed: Signed;
    try {
      signed = sign(conf.creds, { acl: conf.acl, storageClass: conf.storageClass, requestPayer: conf.requestPayer, contentDisposition: conf.contentDisposition, contentEncoding: conf.contentEncoding, ...o }, now());
    } catch (e) {
      if (e instanceof SignError) throw s3Error(e.code, e.message, path);
      throw e;
    }
    const headers = new Headers(signed.headers);
    if (extra.range) headers.set("range", extra.range);
    if (extra.contentType) headers.set("content-type", extra.contentType);
    try {
      return await deps.fetch()(signed.url, { method: o.method, headers, body: extra.body, redirect: "follow" });
    } catch (e) {
      throw s3Error("NetworkError", `${e instanceof Error ? e.message : String(e)}. A browser also reports a bucket whose CORS rules don't allow this page's origin, method or headers (and expose ETag) this way.`, path);
    }
  }

  /** What a response that wasn't a success becomes: S3's `<Error>` document's code and message. */
  async function failure(res: Response, path: string | undefined, notFound: boolean): Promise<Error> {
    let code = "UnknownError";
    let message = "an unexpected error has occurred";
    let hasCode = false;
    const body = await res.text().catch(() => "");
    if (body) {
      message = body;
      if (/^\s*(<\?xml[^>]*\?>\s*)?<Error[\s>]/.test(body)) {
        const c = tag(body, "Code");
        const m = tag(body, "Message");
        if (c) (code = c), (hasCode = true);
        if (m) message = m;
      }
    }
    if (notFound && !hasCode) (code = "NoSuchKey"), (message = "The specified key does not exist.");
    return s3Error(code, message, path);
  }

  const bytesOf = (d: string | ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> =>
    (typeof d === "string" ? enc.encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))) as Uint8Array<ArrayBuffer>;

  /** Data to upload: its bytes, or a stream. */
  async function source(data: unknown): Promise<{ bytes: Uint8Array<ArrayBuffer> } | { stream: ReadableStream<Uint8Array> }> {
    if (typeof data === "string") return { bytes: enc.encode(data) as Uint8Array<ArrayBuffer> };
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return { bytes: bytesOf(data) };
    if (data instanceof ReadableStream) return { stream: data };
    if (data instanceof Response || data instanceof Request) {
      if (!data.body) return { bytes: new Uint8Array(0) };
      return { stream: data.body };
    }
    if (data instanceof S3File) return { stream: data.stream() };
    if (data instanceof Blob) return { stream: data.stream() };
    return { bytes: enc.encode(String(data)) as Uint8Array<ArrayBuffer> };
  }
  // What Bun sends as Content-Type: the one asked for, else the key's extension's, else bytes (a Blob's or Response's own type is not used).
  const contentType = (conf: FileOptions, path: string) => (conf.contentType ? mimeByName(conf.contentType) : mimeOf(path) || "application/octet-stream");

  class S3Stat {
    #size: number;
    #etag: string;
    #type: string;
    #lastModified: Date;
    constructor(size: number, etag: string, type: string, lastModified: Date) {
      [this.#size, this.#etag, this.#type, this.#lastModified] = [size, etag, type, lastModified];
    }
    get size() {
      return this.#size;
    }
    get etag() {
      return this.#etag;
    }
    get type() {
      return this.#type;
    }
    get lastModified() {
      return this.#lastModified;
    }
    get [Symbol.toStringTag]() {
      return "S3Stat";
    }
    [CUSTOM](_depth: number, opts: unknown, inspect: Inspect) {
      return "S3Stat " + inspect({ etag: this.#etag, lastModified: this.#lastModified, size: this.#size, type: this.#type }, opts);
    }
  }

  /** `exists`, `size`, `stat`: a HEAD. */
  async function head(conf: Conf, path: string): Promise<Response> {
    const res = await http(conf, { method: "HEAD", path }, {}, path);
    if (res.status !== 200 && res.status !== 404) throw await failure(res, path, false);
    return res;
  }
  async function stat(conf: Conf, path: string) {
    const res = await head(conf, path);
    if (res.status === 404) throw await failure(res, path, true);
    const length = res.headers.get("content-length");
    return new S3Stat(length === null ? 0 : Number(length), res.headers.get("etag") ?? "", res.headers.get("content-type") ?? "", new Date(res.headers.get("last-modified") ?? NaN));
  }

  async function download(conf: Conf & FileOptions, path: string, start: number, end: number | undefined): Promise<Response> {
    let range: string | undefined;
    if (start < 0) range = end === undefined ? `bytes=${start}` : undefined;
    else if (end !== undefined) range = `bytes=${start}-${end > start ? end - 1 : start}`;
    else if (start > 0) range = `bytes=${start}-${MAX_SIZE - 1}`;
    if (start < 0 && end !== undefined) throw s3Error("ERR_S3_INVALID_PATH", "A negative offset needs no end", path);
    const res = await http(conf, { method: "GET", path }, { range }, path);
    if (![200, 204, 206].includes(res.status)) throw await failure(res, path, res.status === 404);
    return res;
  }

  async function remove(conf: Conf, path: string): Promise<true> {
    const res = await http(conf, { method: "DELETE", path }, {}, path);
    if (res.status !== 200 && res.status !== 204) throw await failure(res, path, res.status === 404);
    return true;
  }

  async function putBytes(conf: Conf & FileOptions, path: string, body: Uint8Array<ArrayBuffer>, type: string): Promise<number> {
    const res = await http(conf, { method: "PUT", path }, { body, contentType: type });
    if (res.status !== 200) throw await failure(res, undefined, false);
    return body.byteLength;
  }

  /** Uploads a stream: one PUT if it ends within a part, else a multipart upload (parts of `partSize`, `queueSize` at a time). */
  async function putStream(conf: Conf & FileOptions, path: string, stream: ReadableStream<Uint8Array>, type: string): Promise<number> {
    const { partSize, queueSize, retry } = conf.multipart;
    const reader = stream.getReader();
    let chunks: Uint8Array[] = [];
    let buffered = 0;
    let total = 0;
    let uploadId: string | undefined;
    const etags: string[] = [];
    let parts = 0;
    const inflight = new Set<Promise<void>>();
    let failed: unknown;
    const take = (n: number): Uint8Array<ArrayBuffer> => {
      const out = new Uint8Array(n);
      let o = 0;
      const rest: Uint8Array[] = [];
      for (const c of chunks) {
        if (o >= n) rest.push(c);
        else if (o + c.length <= n) (out.set(c, o), (o += c.length));
        else (out.set(c.subarray(0, n - o), o), rest.push(c.subarray(n - o)), (o = n));
      }
      chunks = rest;
      buffered -= n;
      return out;
    };
    const search = (q: [string, string][]) => "?" + q.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${awsEncode(k)}=${awsEncode(v)}`).join("&");
    const start = async () => {
      const res = await http(conf, { method: "POST", path, search: "?uploads=" }, { contentType: type });
      const body = await res.text();
      const id = res.status === 200 ? tag(body, "UploadId") : undefined;
      if (!id) throw await failure(new Response(body, { status: res.status }), undefined, false);
      uploadId = id;
    };
    const abort = async () => {
      if (!uploadId) return;
      await http(conf, { method: "DELETE", path, search: search([["uploadId", uploadId]]) }, {}).then((r) => r.arrayBuffer(), () => {});
    };
    const sendPart = async (n: number, body: Uint8Array<ArrayBuffer>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await http(conf, { method: "PUT", path, search: search([["partNumber", String(n)], ["uploadId", uploadId!], ["x-id", "UploadPart"]]) }, { body });
          const etag = res.headers.get("etag");
          if (res.status !== 200 || !etag) throw await failure(res, undefined, false);
          etags[n - 1] = etag;
          return;
        } catch (e) {
          if (attempt >= retry) throw e;
        }
      }
    };
    const launch = async (body: Uint8Array<ArrayBuffer>) => {
      if (!uploadId) await start();
      const n = ++parts;
      const p: Promise<void> = sendPart(n, body).catch((e) => void (failed ??= e)).finally(() => inflight.delete(p));
      inflight.add(p);
      if (inflight.size >= queueSize) await Promise.race(inflight);
      if (failed) throw failed;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        buffered += value.length;
        total += value.length;
        while (buffered >= partSize) await launch(take(partSize));
        if (failed) throw failed;
      }
      if (!uploadId) {
        await putBytes(conf, path, take(buffered), type);
        return total;
      }
      if (buffered > 0) await launch(take(buffered));
      await Promise.all(inflight);
      if (failed) throw failed;
      const complete = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const res = await http(conf, { method: "POST", path, search: search([["uploadId", uploadId]]) }, { body: enc.encode(complete) as Uint8Array<ArrayBuffer> });
      const text = await res.text();
      // A commit can answer 200 and still carry an <Error> document.
      if (res.status !== 200 || /^\s*(<\?xml[^>]*\?>\s*)?<Error[\s>]/.test(text)) throw await failure(new Response(text, { status: res.status === 200 ? 500 : res.status }), undefined, false);
      return total;
    } catch (e) {
      await Promise.allSettled(inflight);
      await abort();
      reader.cancel().catch(() => {});
      throw e;
    }
  }

  async function upload(conf: Conf & FileOptions, path: string, data: unknown): Promise<number> {
    const src = await source(data);
    const type = contentType(conf, path);
    if ("bytes" in src) return putBytes(conf, path, src.bytes, type);
    return putStream(conf, path, src.stream, type);
  }

  /** The `FileSink` of `file.writer()`: chunks go to the multipart upload as they come. */
  function writer(conf: Conf & FileOptions, path: string) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    let result: Promise<number> | undefined;
    let written = 0;
    const run = () => (result ??= putStream(conf, path, stream, contentType(conf, path)));
    run().catch(() => {});
    const sink = {
      write(chunk: string | ArrayBuffer | ArrayBufferView) {
        const b = bytesOf(chunk);
        controller.enqueue(b);
        written += b.byteLength;
        return b.byteLength;
      },
      flush: () => 0,
      end: () => {
        try {
          controller.close();
        } catch {}
        return track(run().then(() => written));
      },
      ref() {},
      unref() {},
      start() {},
      get written() {
        return written;
      },
    };
    return sink;
  }

  async function list(conf: Conf, input: unknown): Promise<ListResult> {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const q: [string, string][] = [];
    const s = (k: string) => str(o, k, false);
    if (s("continuationToken")) q.push(["continuation-token", s("continuationToken")!]);
    if (s("delimiter")) q.push(["delimiter", s("delimiter")!]);
    if (s("encodingType")) q.push(["encoding-type", "url"]);
    if (o.fetchOwner) q.push(["fetch-owner", "true"]);
    else if (o.fetchOwner !== undefined && o.fetchOwner !== null && o.fetchOwner !== 0 && o.fetchOwner !== "") q.push(["fetch-owner", "false"]);
    q.push(["list-type", "2"]);
    if (o.maxKeys && typeof o.maxKeys === "number") q.push(["max-keys", String(o.maxKeys | 0)]);
    if (s("prefix")) q.push(["prefix", s("prefix")!]);
    if (s("startAfter")) q.push(["start-after", s("startAfter")!]);
    const search = "?" + q.map(([k, v]) => `${k}=${awsEncode(v)}`).join("&");
    const res = await http(conf, { method: "GET", path: "", search, allowEmptyPath: true }, {});
    if (res.status !== 200) throw await failure(res, "", res.status === 404);
    const parsed = parseList(await res.text());
    if (!parsed) throw s3Error("InvalidResponse", 'ListObjectsV2 response is not a well-formed <ListBucketResult> document (if keys can contain control characters, pass encodingType: "url")');
    return parsed;
  }

  const display = (conf: Conf) => {
    const c = conf.creds;
    const bucket = (c.virtualHostedStyle && c.endpoint ? guessBucket(c.endpoint) : undefined) ?? c.bucket;
    const endpoint = c.endpoint || (c.virtualHostedStyle ? "https://<bucket>.s3.<region>.amazonaws.com" : "https://s3.<region>.amazonaws.com");
    const lines = [`endpoint: "${endpoint}"`, `region: "${c.region || guessRegion(c.endpoint)}"`];
    if (c.accessKeyId) lines.push('accessKeyId: "[REDACTED]"');
    if (c.secretAccessKey) lines.push('secretAccessKey: "[REDACTED]"');
    if (c.sessionToken) lines.push('sessionToken: "[REDACTED]"');
    if (conf.acl) lines.push(`acl: "${conf.acl}"`);
    lines.push(`partSize: ${conf.multipart.partSize}`, `queueSize: ${conf.multipart.queueSize}`, `retry: ${conf.multipart.retry}`);
    return { bucket, lines };
  };

  /** Builds a file's config: `base` with the options a call passes. */
  const fileConf = (base: Conf, options: unknown): Parsed => withOptions(base, options);

  function requirePath(p: unknown, verb: string, always = false): string {
    const s = pathOf(p);
    if (s === undefined) {
      if (p === undefined || always) throw codeError(TypeError, "ERR_MISSING_ARGS", `Expected a path to ${verb}`);
      throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `Expected a path to ${verb}`);
    }
    return unscheme(s);
  }

  class S3File extends Blob {
    readonly name: string;
    readonly #conf: Parsed;
    readonly #start: number;
    readonly #end: number | undefined;
    #type: string;
    constructor(conf: Parsed, path: string, type = "", start = 0, end?: number) {
      super([]);
      this.#conf = conf;
      this.name = path;
      this.#start = start;
      this.#end = end;
      this.#type = type;
    }
    get size() {
      return this.#end !== undefined ? Math.max(0, Math.min(this.#end, MAX_SIZE) - this.#start) : this.#start > 0 ? MAX_SIZE - this.#start : NaN;
    }
    get type() {
      return this.#type;
    }
    get lastModified() {
      return NaN;
    }
    get bucket() {
      const c = this.#conf.creds.bucket;
      if (c) return c;
      const i = this.name.replace(/^\//, "").indexOf("/");
      return i > 0 ? this.name.replace(/^\//, "").slice(0, i) : undefined;
    }
    get [Symbol.toStringTag]() {
      return "S3File";
    }
    #get() {
      return download(this.#conf, this.name, this.#start, this.#end);
    }
    exists() {
      return track(head(this.#conf, this.name).then((r) => r.status === 200));
    }
    stat() {
      return track(stat(this.#conf, this.name));
    }
    bytes() {
      return track(this.#get().then(async (r) => new Uint8Array(await r.arrayBuffer())));
    }
    arrayBuffer() {
      return track(this.#get().then((r) => r.arrayBuffer()));
    }
    text() {
      return track(this.#get().then((r) => r.text()));
    }
    json() {
      return track(this.#get().then((r) => r.json()));
    }
    formData() {
      return track(this.#get().then(async (r) => new Response(await r.arrayBuffer(), { headers: { "content-type": this.#type || r.headers.get("content-type") || "" } }).formData()));
    }
    stream() {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull: async (c) => {
          try {
            reader ??= (await this.#get()).body?.getReader();
            const r = await reader?.read();
            if (!r || r.done) c.close();
            else c.enqueue(r.value as Uint8Array<ArrayBuffer>);
          } catch (e) {
            c.error(e);
          }
        },
        cancel: (reason) => reader?.cancel(reason),
      });
    }
    slice(start?: number | string, end?: number | string, type?: string): S3File {
      if (typeof start === "string") [start, type] = [undefined, start];
      if (typeof end === "string") [end, type] = [undefined, end];
      const from = start === undefined ? 0 : Math.trunc(start);
      const to = end === undefined ? undefined : Math.trunc(end);
      const abs = (n: number) => (n < 0 ? n : this.#start + n);
      const newEnd = to === undefined ? this.#end : this.#end === undefined ? abs(to) : Math.min(abs(to), this.#end);
      return new S3File(this.#conf, this.name, type ?? "", abs(from), newEnd);
    }
    write(data: unknown, options?: unknown) {
      if (data === undefined) return track(Promise.reject(codeError(TypeError, "ERR_MISSING_ARGS", "Expected a Blob-y thing to write")));
      return track((async () => upload({ ...this.#conf, ...fileConf(this.#conf, options) }, this.name, data))());
    }
    delete() {
      return track(remove(this.#conf, this.name));
    }
    unlink() {
      return this.delete();
    }
    writer(options?: unknown) {
      return writer({ ...this.#conf, ...fileConf(this.#conf, options) }, this.name);
    }
    presign(options?: unknown) {
      return presign(this.#conf, this.name, arguments.length > 0, options);
    }
    [CUSTOM](_depth: number, _opts: unknown, _inspect: Inspect) {
      const d = display(this.#conf);
      const head = `S3Ref ("${d.bucket ? d.bucket + "/" : ""}${this.name}") {`;
      const lines = [...(this.#type ? [`type: "${this.#type}"`] : []), ...(this.#start > 0 ? [`offset: ${this.#start}`] : []), ...d.lines];
      return `${head}\n${lines.map((l) => "  " + l).join(",\n")}\n}`;
    }
  }

  function presign(conf: Conf, path: string, withOptions_: boolean, options: unknown): string {
    let method: SignOptions["method"] = "GET";
    let expires = 86400;
    let c: Parsed = { ...conf, acl: undefined, storageClass: undefined, changed: false };
    if (withOptions_) {
      if (options && typeof options === "object") {
        const o = options as { method?: unknown; expiresIn?: unknown };
        if (o.method) {
          const m = String(o.method).toUpperCase();
          if (!HTTP_METHODS.includes(m)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "method must be GET, PUT, DELETE or HEAD when using s3 protocol");
          method = m as SignOptions["method"];
        }
        if (o.expiresIn !== undefined && o.expiresIn !== null) {
          const n = Math.trunc(Number(o.expiresIn));
          if (!(n > 0)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "expiresIn must be greather than 0");
          expires = n;
        }
      }
      c = withOptions(conf, options);
    }
    try {
      return sign(c.creds, { path, method, expires, acl: c.acl, storageClass: c.storageClass, requestPayer: c.requestPayer, contentDisposition: c.contentDisposition, contentType: c.contentType }, now()).url;
    } catch (e) {
      if (e instanceof SignError) throw codeError(Error, e.code, e.message);
      throw e;
    }
  }

  const file = (conf: Conf, path: unknown, options: unknown) => {
    if (pathOf(path) === undefined) throw path === undefined ? codeError(TypeError, "ERR_MISSING_ARGS", "Expected a path ") : codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Expected a path");
    const parsed = fileConf(conf, options);
    const type = options && typeof options === "object" && typeof (options as { type?: unknown }).type === "string" && /^[\x20-\x7e]*$/.test((options as { type: string }).type) ? (options as { type: string }).type.toLowerCase() : "";
    return new S3File(parsed, unscheme(pathOf(path)!), type);
  };

  class S3Client {
    readonly #conf: Conf | undefined;
    readonly #env: boolean;
    constructor(options?: unknown, lazyEnv = false) {
      this.#env = lazyEnv;
      this.#conf = lazyEnv ? undefined : withOptions(envConf(deps.env()), options);
    }
    #c(): Conf {
      return this.#conf ?? envConf(deps.env());
    }
    file(path: unknown, options?: unknown) {
      return file(this.#c(), path, options);
    }
    presign(path: unknown, options?: unknown) {
      return presign(this.#c(), requirePath(path, "presign"), arguments.length > 1, options);
    }
    exists(path: unknown, options?: unknown) {
      const p = requirePath(path, "check if it exists");
      return track(head(withOptions(this.#c(), options), p).then((r) => r.status === 200));
    }
    size(path: unknown, options?: unknown) {
      const p = requirePath(path, "check the size of");
      return track(stat(withOptions(this.#c(), options), p).then((s) => s.size));
    }
    stat(path: unknown, options?: unknown) {
      const p = requirePath(path, "check the stat of");
      return track(stat(withOptions(this.#c(), options), p));
    }
    write(path: unknown, data: unknown, options?: unknown) {
      const p = requirePath(path, "write to", true);
      if (data === undefined) throw codeError(TypeError, "ERR_MISSING_ARGS", "Expected a Blob-y thing to write");
      const conf = withOptions(this.#c(), options);
      return track(upload(conf, p, data));
    }
    list(input?: unknown, options?: unknown) {
      return track(list(withOptions(this.#c(), options), input));
    }
    delete(path: unknown, options?: unknown) {
      const p = requirePath(path, "unlink", true);
      return track(remove(withOptions(this.#c(), options), p));
    }
    unlink(path: unknown, options?: unknown) {
      return this.delete(path, options);
    }
    [CUSTOM](_depth: number, _opts: unknown, _inspect: Inspect) {
      const c = this.#c();
      const d = display(c);
      return `S3Client${d.bucket ? ` ("${d.bucket}")` : ""} {\n${d.lines.map((l) => "  " + l).join(",\n")}\n}`;
    }
    // Statics: the same on the credentials of the environment.
    static file(path: unknown, options?: unknown) {
      if (pathOf(path) === undefined) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Expected file path string");
      return file(envConf(deps.env()), path, options);
    }
    static presign(path: unknown, options?: unknown) {
      return presign(envConf(deps.env()), requirePathOrFile(path, "Expected a S3 or path to presign"), arguments.length > 1, options);
    }
    static exists(path: unknown, options?: unknown) {
      return track(head(withOptions(envConf(deps.env()), options), requirePathOrFile(path, "Expected a S3 or path to check if it exists")).then((r) => r.status === 200));
    }
    static size(path: unknown, options?: unknown) {
      return track(stat(withOptions(envConf(deps.env()), options), requirePathOrFile(path, "Expected a S3 or path to get size")).then((s) => s.size));
    }
    static stat(path: unknown, options?: unknown) {
      return track(stat(withOptions(envConf(deps.env()), options), requirePathOrFile(path, "Expected a S3 or path to get size")));
    }
    static write(path: unknown, data: unknown, options?: unknown) {
      if (path instanceof S3File) return path.write(data, options);
      const p = requirePathOrFile(path, "Expected a S3 or path to upload");
      if (data === undefined) throw codeError(TypeError, "ERR_MISSING_ARGS", "Expected a Blob-y thing to upload");
      return track(upload(withOptions(envConf(deps.env()), options), p, data));
    }
    static delete(path: unknown, options?: unknown) {
      if (path instanceof S3File) return path.delete();
      return track(remove(withOptions(envConf(deps.env()), options), requirePathOrFile(path, "Expected a S3 or path to delete")));
    }
    static unlink(path: unknown, options?: unknown) {
      return S3Client.delete(path, options);
    }
    static list(input?: unknown, options?: unknown) {
      return track(list(withOptions(envConf(deps.env()), options), input));
    }
  }

  function requirePathOrFile(p: unknown, message: string): string {
    const s = pathOf(p);
    if (s === undefined) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", message);
    return unscheme(s);
  }
  // Static methods are named and sized as Bun's.
  for (const k of ["write", "presign", "exists", "size", "stat", "list", "file", "unlink"] as const) Object.defineProperty(S3Client[k], "length", { value: 2 });

  /** `Bun.s3`: a client on the environment's credentials, read when it is used. */
  const s3 = new S3Client(undefined, true);

  /** `Bun.file("s3://…")`, `Bun.write("s3://…")`: a file on the environment's credentials. */
  const fromUrl = (url: string, options?: unknown) => file(envConf(deps.env()), url, options);

  /** `fetch("s3://bucket/key", { s3: {…} })`: the object's own response (GET, PUT, DELETE, HEAD). */
  async function fetchUrl(url: string, init?: RequestInit & { s3?: unknown }): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    if (!["GET", "PUT", "DELETE", "HEAD"].includes(method)) throw codeError(TypeError, "ERR_S3_INVALID_METHOD", SIGN_ERRORS.InvalidMethod[1]);
    const conf = withOptions(envConf(deps.env()), init?.s3);
    const path = unscheme(url);
    let body: Uint8Array<ArrayBuffer> | undefined;
    let type: string | undefined;
    if (method === "PUT" && init?.body != null) {
      const req = new Request("http://x/", { method: "POST", body: init.body });
      type = req.headers.get("content-type") ?? undefined;
      body = new Uint8Array(await req.arrayBuffer());
    }
    const headers = new Headers(init?.headers);
    return http(conf, { method: method as SignOptions["method"], path }, { body, contentType: headers.get("content-type") ?? type ?? (method === "PUT" ? "application/octet-stream" : undefined) }, path);
  }

  return { S3Client, S3File, s3, fromUrl, fetchUrl, upload, isS3File: (v: unknown): v is InstanceType<typeof S3File> => v instanceof S3File };
}
