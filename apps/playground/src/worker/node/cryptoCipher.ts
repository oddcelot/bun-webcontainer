// `crypto.createCipheriv` / `createDecipheriv`: AES (ECB, CBC, CTR, CFB, OFB, GCM) and ChaCha20-Poly1305, run by
// crypto-wasm (cipher.rs) with Node's update/final, padding, AAD and auth tag handling, and as Node's, a Transform stream.
import { Buffer } from "buffer";
import { StringDecoder } from "string_decoder";
import { bytes, type Data } from "./cryptoBytes";
import { wcall } from "./cryptoWasm";
import { codeError } from "./errors";
import Stream from "./stream";
import { KeyObject, secretBytes } from "./cryptoKeys";

type Key = Data | KeyObject;
type Options = { authTagLength?: number; [stream: string]: unknown };

const SIZES = ["128", "192", "256"];
const MODES = ["cbc", "cfb", "ctr", "ecb", "gcm", "ofb"];
const AEAD = ["gcm", "chacha20-poly1305"];

/** Node's list (a subset of it: what the module implements). */
const CIPHERS = [...SIZES.flatMap((s) => MODES.map((m) => `aes-${s}-${m}`)), ...SIZES.map((s) => `aes${s}`), "chacha20-poly1305"].sort();

const arg = (name: string, v: unknown) =>
  codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey.${received(v)}`);

function received(v: unknown) {
  return v === null ? " Received null" : v === undefined ? " Received undefined" : typeof v === "object" ? " Received an instance of " + (v.constructor?.name ?? "Object") : ` Received type ${typeof v} (${String(v)})`;
}

function material(name: string, v: unknown, nullable = false): Uint8Array {
  if (v instanceof KeyObject) return secretBytes(v);
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (v === null && nullable) return new Uint8Array(0);
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return bytes(v as Data);
  throw arg(name, v);
}

const invalidState = (message = "Invalid state") => codeError(Error, "ERR_CRYPTO_INVALID_STATE", message);

class Cipher extends (Stream.Transform as new (options?: object) => any) {
  #h: number | undefined;
  #done = false;
  #tag: Buffer | undefined;
  #decoder: { enc: string; d: StringDecoder } | undefined;
  readonly #mode: string;
  readonly #encrypt: boolean;

  constructor(encrypt: boolean, algorithm: string, key: Key, iv: Data | null, options?: Options) {
    super(options as never);
    if (typeof algorithm !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "cipher" argument must be of type string.${received(algorithm)}`);
    this.#mode = algorithm.toLowerCase();
    this.#encrypt = encrypt;
    const aead = this.#mode === "chacha20-poly1305" || this.#mode.endsWith("-gcm");
    const tagLength = options?.authTagLength;
    if (tagLength !== undefined && aead && !(this.#mode.endsWith("-gcm") ? [4, 8, 12, 13, 14, 15, 16] : [16]).includes(tagLength)) {
      throw codeError(TypeError, "ERR_CRYPTO_INVALID_AUTH_TAG", `Invalid authentication tag length: ${tagLength}`);
    }
    const [h] = wcall(1, this.#mode, material("key", key), material("iv", iv, true), +encrypt, aead ? (tagLength ?? 0) : 0);
    this.#h = new DataView(h.buffer).getUint32(0, true);
  }

  #out(b: Uint8Array, outputEncoding?: string): Buffer | string {
    if (!outputEncoding || outputEncoding === "buffer") return Buffer.from(b);
    // A string output holds back a character (or base64 group) a later update completes, as Node's StringDecoder does.
    if (this.#decoder?.enc !== outputEncoding) this.#decoder = { enc: outputEncoding, d: new StringDecoder(outputEncoding as BufferEncoding) };
    return this.#decoder.d.write(Buffer.from(b));
  }

  update(data: Data, inputEncoding?: string | null, outputEncoding?: string): Buffer | string {
    if (typeof data !== "string" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.${received(data)}`);
    }
    if (this.#done) throw new Error("Trying to add data in unsupported state");
    const [out] = wcall(2, this.#handle(), bytes(data, inputEncoding ?? undefined));
    return this.#out(out, outputEncoding);
  }

  final(outputEncoding?: string): Buffer | string {
    if (this.#done) throw invalidState();
    this.#done = true;
    try {
      const [out, tag] = wcall(3, this.#handle());
      if (this.#encrypt) this.#tag = Buffer.from(tag);
      const last = this.#out(out, outputEncoding);
      if (typeof last === "string" && this.#decoder) return last + this.#decoder.d.end();
      return last;
    } finally {
      wcall(7, this.#handle());
    }
  }

  #handle() {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, this.#h!, true);
    return b;
  }

  setAutoPadding(autoPadding = true): this {
    try {
      wcall(6, this.#handle(), +!!autoPadding);
    } catch {
      // Only the block modes pad; the others ignore it.
    }
    return this;
  }

  setAAD(buffer: Data, options?: { plaintextLength?: number; encoding?: string }): this {
    try {
      wcall(4, this.#handle(), bytes(buffer, options?.encoding));
    } catch {
      throw new Error("Unsupported state");
    }
    return this;
  }

  getAuthTag(): Buffer {
    if (!this.#encrypt || !this.#done || !this.#tag || !AEAD.some((m) => this.#mode.endsWith(m))) throw invalidState("Invalid state for operation getAuthTag");
    return this.#tag;
  }

  setAuthTag(tag: Data, encoding?: string): this {
    const t = bytes(tag, encoding);
    const ok = this.#mode.endsWith("-gcm") ? [4, 8, 12, 13, 14, 15, 16].includes(t.length) : t.length === 16;
    if (this.#encrypt || this.#done || !AEAD.some((m) => this.#mode.endsWith(m))) throw invalidState("Invalid state for operation setAuthTag");
    if (!ok) throw codeError(TypeError, "ERR_CRYPTO_INVALID_AUTH_TAG", `Invalid authentication tag length: ${t.length}`);
    wcall(5, this.#handle(), t);
    return this;
  }

  _transform(chunk: Data, encoding: string, callback: (e?: Error | null, d?: Buffer) => void) {
    try {
      callback(null, this.update(chunk, encoding === "buffer" ? undefined : encoding) as Buffer);
    } catch (e) {
      callback(e as Error);
    }
  }

  _flush(callback: (e?: Error | null, d?: Buffer) => void) {
    try {
      callback(null, this.final() as Buffer);
    } catch (e) {
      callback(e as Error);
    }
  }
}

export class Cipheriv extends Cipher {
  constructor(algorithm: string, key: Key, iv: Data | null, options?: Options) {
    super(true, algorithm, key, iv, options);
  }
}

export class Decipheriv extends Cipher {
  constructor(algorithm: string, key: Key, iv: Data | null, options?: Options) {
    super(false, algorithm, key, iv, options);
  }
}

export const createCipheriv = (algorithm: string, key: Key, iv: Data | null, options?: Options) => new Cipheriv(algorithm, key, iv, options);
export const createDecipheriv = (algorithm: string, key: Key, iv: Data | null, options?: Options) => new Decipheriv(algorithm, key, iv, options);
export const getCiphers = () => [...CIPHERS];

