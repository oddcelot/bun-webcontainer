// `crypto.KeyObject` and everything that takes a key: createPrivateKey / createPublicKey / createSecretKey (PEM, DER and
// JWK in, and out through `export`), generateKeyPair, sign / verify and createSign / createVerify, publicEncrypt and
// privateDecrypt. RSA, ECDSA over P-256 and P-384, and Ed25519 run in crypto-wasm (keys.rs); a key is kept as its
// canonical DER (PKCS#8 for a private key, SPKI for a public one) and the module is given it with each call.
import { Buffer } from "buffer";
import { b64u, bytes, encode, unb64u, type Data } from "./cryptoBytes";
import { wcall } from "./cryptoWasm";
import { codeError } from "./errors";
import Stream from "./stream";

type Asymmetric = { type: "public" | "private"; kty: "rsa" | "ec" | "ed25519"; der: Uint8Array; curve: string; bits: number; e: Uint8Array };
type Secret = { type: "secret"; bytes: Uint8Array };

const DATA = new WeakMap<object, Asymmetric | Secret>();

const received = (v: unknown) => (v === null ? " Received null" : v === undefined ? " Received undefined" : typeof v === "object" ? ` Received an instance of ${v.constructor?.name ?? "Object"}` : ` Received type ${typeof v} (${String(v)})`);

export class KeyObject {
  constructor(type?: unknown, handle?: unknown) {
    if (type !== "secret" && type !== "public" && type !== "private") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'type' is invalid. Received ${type === undefined ? "undefined" : typeof type === "string" ? `'${type}'` : String(type)}`);
    throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "handle" argument must be of type object.${received(handle)}`);
  }

  get type(): "secret" | "public" | "private" {
    return DATA.get(this)!.type;
  }

  get symmetricKeySize(): number | undefined {
    const d = DATA.get(this)!;
    return d.type === "secret" ? d.bytes.length : undefined;
  }

  get asymmetricKeyType(): "rsa" | "ec" | "ed25519" | undefined {
    const d = DATA.get(this)!;
    return d.type === "secret" ? undefined : d.kty;
  }

  get asymmetricKeyDetails(): { modulusLength?: number; publicExponent?: bigint; namedCurve?: string } | undefined {
    const d = DATA.get(this)!;
    if (d.type === "secret") return undefined;
    if (d.kty === "rsa") return { modulusLength: d.bits, publicExponent: BigInt("0x" + Buffer.from(d.e).toString("hex")) };
    if (d.kty === "ec") return { namedCurve: d.curve };
    return {};
  }

  equals(other: KeyObject): boolean {
    const [a, b] = [DATA.get(this), DATA.get(other as object)];
    if (!(other instanceof KeyObject) || !a || !b) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "otherKeyObject" argument must be an instance of KeyObject.${received(other)}`);
    if (a.type !== b.type) return false;
    const [x, y] = a.type === "secret" ? [a.bytes, (b as Secret).bytes] : [a.der, (b as Asymmetric).der];
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }

  export(options?: { type?: string; format?: string; cipher?: string; passphrase?: Data }): string | Buffer | object {
    const d = DATA.get(this)!;
    if (d.type === "secret") {
      if (options?.format === "jwk") return { kty: "oct", k: b64u(d.bytes) };
      return Buffer.from(d.bytes);
    }
    if (options?.cipher || options?.passphrase !== undefined) throw unsupported("encrypted (passphrase-protected) key export");
    const format = options?.format ?? "pem";
    if (format === "jwk") return exportJwk(d);
    const type = options?.type ?? (d.type === "public" ? "spki" : "pkcs8");
    if (format !== "pem" && format !== "der") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.format' must be one of: 'der', 'pem', 'jwk'. Received '${format}'`);
    if (d.type === "public" ? type !== "spki" && type !== "pkcs1" : type !== "pkcs8" && type !== "pkcs1" && type !== "sec1") {
      throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.type' must be one of: ${d.type === "public" ? "'pkcs1', 'spki'" : "'pkcs1', 'pkcs8', 'sec1'"}. Received '${type}'`);
    }
    const [der] = wcall(21, d.der, +(d.type === "private"), type);
    if (format === "der") return Buffer.from(der);
    return pem(PEM_LABEL[d.type][type], der);
  }

  toString() {
    return "[object KeyObject]";
  }

  static from(key: { type?: string }): KeyObject {
    throw codeError(Error, "ERR_METHOD_NOT_IMPLEMENTED", "KeyObject.from(CryptoKey) is not supported in the playground");
  }
}
Object.defineProperty(KeyObject.prototype, Symbol.toStringTag, { value: "KeyObject", configurable: true });

const PEM_LABEL: Record<"public" | "private", Record<string, string>> = {
  public: { spki: "PUBLIC KEY", pkcs1: "RSA PUBLIC KEY" },
  private: { pkcs8: "PRIVATE KEY", pkcs1: "RSA PRIVATE KEY", sec1: "EC PRIVATE KEY" },
};

function unsupported(what: string) {
  return codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", `${what} is not supported in the playground`);
}

// Node's key objects are of these classes (their names show in errors and inspect).
class SecretKeyObject extends KeyObject {}
class PublicKeyObject extends KeyObject {}
class PrivateKeyObject extends KeyObject {}

function make(d: Asymmetric | Secret): KeyObject {
  const k = Object.create((d.type === "secret" ? SecretKeyObject : d.type === "public" ? PublicKeyObject : PrivateKeyObject).prototype) as KeyObject;
  DATA.set(k, d);
  return k;
}

/** The bytes of a secret key. */
export function secretBytes(k: KeyObject): Uint8Array {
  const d = DATA.get(k);
  if (d?.type !== "secret") throw codeError(TypeError, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", `Invalid key object type ${d?.type}, expected secret.`);
  return d.bytes;
}

export function createSecretKey(key: Data, encoding?: string): KeyObject {
  if (typeof key !== "string" && !(key instanceof ArrayBuffer) && !ArrayBuffer.isView(key)) {
    throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "key" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView.${received(key)}`);
  }
  return make({ type: "secret", bytes: bytes(key, encoding).slice() });
}

// ---- PEM and DER ----

function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

function ossl(code: string, message: string) {
  const e = codeError(Error, code, message) as Error & { reason?: string; library?: string };
  const m = /^error:[0-9a-fA-F]+:([^:]*):(?:[^:]*:)?([^:]*)$/.exec(message)!;
  [e.library, e.reason] = [m[1], m[2]];
  return e;
}

/** The first PEM block of `text`: its label and DER. */
function unpem(text: string): { label: string; der: Uint8Array; encrypted: boolean } {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!m) throw ossl("ERR_OSSL_PEM_NO_START_LINE", "error:0900006e:PEM routines:OPENSSL_internal:NO_START_LINE");
  const encrypted = /Proc-Type:\s*4,ENCRYPTED/.test(m[2]) || m[1] === "ENCRYPTED PRIVATE KEY";
  const body = m[2].split("\n").filter((l) => !l.includes(":")).join("").replace(/\s+/g, "");
  return { label: m[1], der: new Uint8Array(Buffer.from(body, "base64")), encrypted };
}

/** The children of the DER constructed value at `at`: [start of content, end]. */
function der(b: Uint8Array, at: number): { tag: number; start: number; end: number } {
  let n = b[at + 1];
  let start = at + 2;
  if (n & 0x80) {
    const len = n & 0x7f;
    n = 0;
    for (let i = 0; i < len; i++) n = n * 256 + b[start + i];
    start += len;
  }
  return { tag: b[at], start, end: start + n };
}

/** The SubjectPublicKeyInfo of an X.509 certificate (createPublicKey takes certificates too). */
function certificateSpki(b: Uint8Array): Uint8Array {
  const cert = der(b, 0);
  let tbs = der(b, cert.start);
  let at = tbs.start;
  if (b[at] === 0xa0) at = der(b, at).end; // version
  // serialNumber, signature, issuer, validity, subject
  for (let i = 0; i < 5; i++) at = der(b, at).end;
  return b.slice(at, der(b, at).end);
}

// ---- Import ----

type KeyOptions = { key?: unknown; format?: string; type?: string; passphrase?: unknown; encoding?: string; [other: string]: unknown };

const JWK_STRINGS = ["kty", "crv"];

function fromJwk(jwk: Record<string, unknown>): Uint8Array[] {
  const fields: (string | Uint8Array)[] = [];
  for (const [k, v] of Object.entries(jwk)) {
    if (typeof v !== "string") continue;
    fields.push(k, JWK_STRINGS.includes(k) ? v : unb64u(v));
  }
  return wcall(23, ...fields);
}

function fromWasm(f: Uint8Array[]): Asymmetric {
  const dec = new TextDecoder();
  return { type: f[0][0] ? "private" : "public", kty: dec.decode(f[1]) as Asymmetric["kty"], der: f[2], curve: dec.decode(f[3]), bits: new DataView(f[4].buffer, f[4].byteOffset).getUint32(0, true), e: f[5] };
}

const PEM_TYPE: Record<string, string> = { "PRIVATE KEY": "pkcs8", "RSA PRIVATE KEY": "pkcs1-private", "EC PRIVATE KEY": "sec1", "PUBLIC KEY": "spki", "RSA PUBLIC KEY": "pkcs1-public" };

function importKey(input: unknown, wantPrivate: boolean): KeyObject {

  if (input instanceof KeyObject) {
    const d = DATA.get(input)!;
    if (d.type === "secret" || (wantPrivate && d.type !== "private")) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "key" argument must be of type string, ArrayBuffer, Buffer, TypedArray, or DataView.${received(input)}`);
    return d.type === (wantPrivate ? "private" : "public") ? make({ ...d }) : make(fromWasm(wcall(20, d.der, 0, "pkcs8")));
  }
  let opts: KeyOptions;
  if (typeof input === "string" || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) opts = { key: input };
  else if (input && typeof input === "object") opts = input as KeyOptions;
  else throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "key" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey.${received(input)}`);
  if (opts.passphrase !== undefined && opts.format !== "jwk") throw unsupported("passphrase-protected keys");
  const format = opts.format ?? "pem";
  if (format === "jwk") {
    if (!opts.key || typeof opts.key !== "object") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "key.key" property must be of type object.${received(opts.key)}`);
    const k = fromWasm(fromJwk(opts.key as Record<string, unknown>));
    if (wantPrivate && k.type !== "private") throw codeError(TypeError, "ERR_CRYPTO_INVALID_JWK", "Invalid JWK data");
    return make(k);
  }
  if (typeof opts.key !== "string" && !(opts.key instanceof ArrayBuffer) && !ArrayBuffer.isView(opts.key)) {
    throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "key" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey.${received(opts.key)}`);
  }
  if (format === "der") {
    const type = opts.type;
    if (type !== "pkcs1" && type !== "pkcs8" && type !== "spki" && type !== "sec1") {
      throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.type' is invalid. Received ${type === undefined ? "undefined" : `'${type}'`}`);
    }
    return make(fromWasm(wcall(20, bytes(opts.key as Data, opts.encoding), +wantPrivate, type)));
  }
  if (format !== "pem") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.format' must be one of: 'der', 'pem', 'jwk'. Received '${format}'`);
  const text = typeof opts.key === "string" ? opts.key : new TextDecoder().decode(bytes(opts.key as Data));
  const { label, der: body, encrypted } = unpem(text);
  if (encrypted) throw unsupported("passphrase-protected keys");
  if (label === "CERTIFICATE" && !wantPrivate) return make(fromWasm(wcall(20, certificateSpki(body), 0, "spki")));
  const type = PEM_TYPE[label];
  // A private key's parser looks only for private labels.
  if (wantPrivate && label !== "PRIVATE KEY" && label !== "RSA PRIVATE KEY" && label !== "EC PRIVATE KEY") throw ossl("ERR_OSSL_PEM_NO_START_LINE", "error:0900006e:PEM routines:OPENSSL_internal:NO_START_LINE");
  if (!type) throw ossl("ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported");

  return make(fromWasm(wcall(20, body, +wantPrivate, type)));
}

export const createPrivateKey = (key: unknown) => importKey(key, true);
export const createPublicKey = (key: unknown) => importKey(key, false);

// ---- Export as JWK ----

function exportJwk(d: Asymmetric): object {
  const f = wcall(22, d.der, +(d.type === "private"));
  const dec = new TextDecoder();
  const jwk: Record<string, string> = {};
  for (let i = 0; i < f.length; i += 2) {
    const k = dec.decode(f[i]);
    jwk[k] = JWK_STRINGS.includes(k) ? dec.decode(f[i + 1]) : b64u(f[i + 1]);
  }
  return jwk;
}

// ---- Generation ----

type Encodings = { publicKeyEncoding?: { type?: string; format?: string }; privateKeyEncoding?: { type?: string; format?: string; cipher?: string; passphrase?: Data } };
type GenerateOptions = Encodings & { modulusLength?: number; publicExponent?: number; namedCurve?: string };

function generate(type: string, options: GenerateOptions = {}): { publicKey: unknown; privateKey: unknown } {
  if (typeof type !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "type" argument must be of type string.${received(type)}`);
  if (options === null || typeof options !== "object") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options" argument must be of type object.${received(options)}`);
  let f: Uint8Array[];
  if (type === "rsa") {
    const bits = options.modulusLength;
    if (typeof bits !== "number") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.modulusLength" property must be of type number.${received(bits)}`);
    const e = options.publicExponent ?? 0x10001;
    f = wcall(24, "rsa", bits, new Uint8Array(Buffer.from(e.toString(16).padStart(8, "0"), "hex")));
  } else if (type === "ec") {
    if (typeof options.namedCurve !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.namedCurve" property must be of type string.${received(options.namedCurve)}`);
    f = wcall(24, "ec", options.namedCurve);
  } else if (type === "ed25519") f = wcall(24, "ed25519");
  else throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'type' must be a supported key type. Received '${type}'`);
  const priv = make(fromWasm(f));
  const pub = make(fromWasm(wcall(20, f[2], 0, "pkcs8")));
  const out = (k: KeyObject, enc?: { type?: string; format?: string }) => (enc ? k.export(enc) : k);
  return { publicKey: out(pub, options.publicKeyEncoding), privateKey: out(priv, options.privateKeyEncoding) };
}

export const generateKeyPairSync = generate;

export function generateKeyPair(type: string, options: GenerateOptions | ((e: Error | null, ...k: unknown[]) => void), callback?: (e: Error | null, publicKey?: unknown, privateKey?: unknown) => void) {
  if (typeof options === "function") [options, callback] = [{}, options as typeof callback];
  if (typeof callback !== "function") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "callback" argument must be of type function.${received(callback)}`);
  const cb = callback;
  // Made now (the work is synchronous in the module) and delivered later, as an asynchronous API does.
  let result: { publicKey: unknown; privateKey: unknown } | undefined;
  let error: Error | undefined;
  try {
    result = generate(type, options as GenerateOptions);
  } catch (e) {
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_INVALID_ARG")) throw e;
    error = e as Error;
  }
  setTimeout(() => (error ? cb(error) : cb(null, result!.publicKey, result!.privateKey)), 0);
}
(generateKeyPair as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (type: string, options?: GenerateOptions) =>
  new Promise((resolve, reject) => generateKeyPair(type, options ?? {}, (e, publicKey, privateKey) => (e ? reject(e) : resolve({ publicKey, privateKey }))));

export function generateKeySync(type: string, options: { length: number }): KeyObject {
  if (type !== "hmac" && type !== "aes") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'type' must be a supported key type. Received '${type}'`);
  const b = new Uint8Array(options.length / 8);
  for (let i = 0; i < b.length; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536));
  return createSecretKey(b);
}

export function generateKey(type: string, options: { length: number }, callback: (e: Error | null, key?: KeyObject) => void) {
  const key = generateKeySync(type, options);
  setTimeout(() => callback(null, key), 0);
}

// ---- Sign and verify ----

export const constants = {
  RSA_PKCS1_PADDING: 1,
  RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_X931_PADDING: 5,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1,
  RSA_PSS_SALTLEN_MAX_SIGN: -2,
  RSA_PSS_SALTLEN_AUTO: -2,
};

const HASH_NAMES = ["sha1", "sha224", "sha256", "sha384", "sha512"];

/** Node's names for a digest in a signature algorithm (`RSA-SHA256`, `sha256WithRSAEncryption`, `ecdsa-with-SHA384`, `SHA-512`) as the module's. */
function digestName(algorithm: unknown, kty: Asymmetric["kty"]): string {
  if (kty === "ed25519" && algorithm !== null && algorithm !== undefined) throw ossl("ERR_OSSL_EVP_COMMAND_NOT_SUPPORTED", "error:06000065:public key routines:OPENSSL_internal:COMMAND_NOT_SUPPORTED");
  if (algorithm === null || algorithm === undefined) {
    // No algorithm: Ed25519 signs the message itself, the others use SHA-256.
    return kty === "ed25519" ? "" : "sha256";
  }
  if (typeof algorithm !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "algorithm" argument must be of type string.${received(algorithm)}`);
  const n = algorithm.toLowerCase().replace(/^rsa-/, "").replace(/withrsaencryption$/, "").replace(/^ecdsa-with-/, "").replace(/^sha-(\d)/, "sha$1");
  return n;
}

type Keyish = unknown;

function keyAndOptions(key: Keyish, wantPrivate: boolean): { key: KeyObject; opts: { padding?: number; saltLength?: number; dsaEncoding?: string; oaepHash?: string; oaepLabel?: Data } } {
  if (key instanceof KeyObject) return { key, opts: {} };
  if (key && typeof key === "object" && !ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer)) {
    const o = key as KeyOptions & { padding?: number; saltLength?: number; dsaEncoding?: string; oaepHash?: string; oaepLabel?: Data };
    const k = o.key instanceof KeyObject ? importKey(o.key, wantPrivate) : importKey(o, wantPrivate);
    return { key: k, opts: o };
  }
  return { key: importKey(key, wantPrivate), opts: {} };
}

const publicOf = new WeakMap<KeyObject, Asymmetric>();

/** The key's public half (a private key's, derived once). */
function publicData(k: KeyObject): Asymmetric {
  const d = DATA.get(k) as Asymmetric;
  if (d.type === "public") return d;
  let p = publicOf.get(k);
  if (!p) publicOf.set(k, (p = fromWasm(wcall(20, d.der, 0, "pkcs8"))));
  return p;
}

function asymmetric(k: KeyObject, want: "private" | "public"): Asymmetric {
  const d = DATA.get(k);
  if (!d || d.type !== want) throw codeError(TypeError, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", `Invalid key object type ${d?.type}, expected ${want}.`);
  return d;
}

function signWith(algorithm: unknown, data: Uint8Array, key: Keyish): Buffer {
  const { key: k, opts } = keyAndOptions(key, true);
  const d = asymmetric(k, "private");
  const digest = digestName(algorithm, d.kty);
  if (d.kty !== "ed25519" && !HASH_NAMES.includes(digest)) throw codeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${algorithm}`);
  const [sig] = wcall(30, d.der, digest, opts.padding === constants.RSA_PKCS1_PSS_PADDING ? "pss" : "pkcs1", String(opts.saltLength ?? -2), data, +(opts.dsaEncoding === "ieee-p1363"));
  return Buffer.from(sig);
}

function verifyWith(algorithm: unknown, data: Uint8Array, key: Keyish, signature: Uint8Array): boolean {
  const { key: k, opts } = keyAndOptions(key, false);
  const d = publicData(k);
  const digest = digestName(algorithm, d.kty);
  if (d.kty !== "ed25519" && !HASH_NAMES.includes(digest)) throw codeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${algorithm}`);
  const [ok] = wcall(31, d.der, digest, opts.padding === constants.RSA_PKCS1_PSS_PADDING ? "pss" : "pkcs1", String(opts.saltLength ?? -2), data, signature, +(opts.dsaEncoding === "ieee-p1363"));
  return ok[0] === 1;
}

/** The result of a one-shot call as its callback form delivers it. */
function settle<T>(f: () => T, callback?: (e: Error | null, r?: T) => void): T | undefined {
  if (!callback) return f();
  let r: T | undefined;
  let error: Error | null = null;
  try {
    r = f();
  } catch (e) {
    error = e as Error;
  }
  setTimeout(() => (error ? callback(error) : callback(null, r)), 0);
}

export function sign(algorithm: unknown, data: Data, key: Keyish, callback?: (e: Error | null, sig?: Buffer) => void): Buffer | undefined {
  return settle(() => signWith(algorithm, bytes(data), key), callback);
}

export function verify(algorithm: unknown, data: Data, key: Keyish, signature: Data, callback?: (e: Error | null, ok?: boolean) => void): boolean | undefined {
  return settle(() => verifyWith(algorithm, bytes(data), key, bytes(signature)), callback);
}

const Writable = Stream.Writable as new (options?: object) => any;

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) (out.set(c, at), (at += c.length));
  return out;
}

class Signer extends Writable {
  #chunks: Uint8Array[] = [];
  readonly #algorithm: string;

  constructor(algorithm: string, options?: object) {
    super(options);
    if (typeof algorithm !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "algorithm" argument must be of type string.${received(algorithm)}`);
    if (!HASH_NAMES.includes(digestName(algorithm, "rsa"))) throw codeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${algorithm}`);
    this.#algorithm = algorithm;
  }

  update(data: Data, inputEncoding?: string): this {
    this.#chunks.push(bytes(data, inputEncoding).slice());
    return this;
  }

  _write(chunk: Data, encoding: string, callback: (e?: Error) => void) {
    this.update(chunk, encoding === "buffer" ? undefined : encoding);
    callback();
  }

  protected data() {
    return { algorithm: this.#algorithm, message: concat(this.#chunks) };
  }
}

export class Sign extends Signer {
  sign(privateKey: Keyish, outputEncoding?: string): Buffer | string {
    const { algorithm, message } = this.data();
    return encode(signWith(algorithm, message, privateKey), outputEncoding);
  }
}

export class Verify extends Signer {
  verify(object: Keyish, signature: Data, signatureEncoding?: string): boolean {
    const { algorithm, message } = this.data();
    return verifyWith(algorithm, message, object, bytes(signature, signatureEncoding));
  }
}

export const createSign = (algorithm: string, options?: object) => new Sign(algorithm, options);
export const createVerify = (algorithm: string, options?: object) => new Verify(algorithm, options);

// ---- RSA encryption ----

function rsaCrypt(encrypt: boolean, key: Keyish, data: Data): Buffer {
  const { key: k, opts } = keyAndOptions(key, !encrypt);
  const d = encrypt ? publicData(k) : asymmetric(k, "private");
  const padding = opts.padding ?? constants.RSA_PKCS1_OAEP_PADDING;
  if (!encrypt && padding === constants.RSA_PKCS1_PADDING) throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "RSA_PKCS1_PADDING is no longer supported for private decryption");
  if (padding !== constants.RSA_PKCS1_OAEP_PADDING && padding !== constants.RSA_PKCS1_PADDING) throw unsupported(`RSA padding ${padding}`);
  const hash = String(opts.oaepHash ?? "sha1").toLowerCase().replace(/^sha-(\d)/, "sha$1");
  const label = opts.oaepLabel === undefined ? new Uint8Array(0) : bytes(opts.oaepLabel);
  const [out] = wcall(encrypt ? 40 : 41, d.der, padding === constants.RSA_PKCS1_PADDING ? "pkcs1" : "oaep", hash, label, bytes(data));
  return Buffer.from(out);
}

export const publicEncrypt = (key: Keyish, data: Data) => rsaCrypt(true, key, data);
export const privateDecrypt = (key: Keyish, data: Data) => rsaCrypt(false, key, data);

export const privateEncrypt = () => {
  throw unsupported("crypto.privateEncrypt");
};
export const publicDecrypt = () => {
  throw unsupported("crypto.publicDecrypt");
};

export const getCurves = () => ["prime256v1", "secp256r1", "secp384r1"];


