// Byte and encoding helpers shared by node:crypto's parts (crypto.ts, cryptoCipher.ts, cryptoKeys.ts).
import { Buffer } from "buffer";
import { codeError } from "./errors";

export type Data = string | ArrayBufferView | ArrayBuffer;

export function bytes(data: Data, enc?: string): Uint8Array {
  if (typeof data === "string") return Uint8Array.from(strBuffer(data, enc));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
}

/** A string's bytes in `enc` (utf8 by default); `base64url` isn't in the Buffer package. */
export function strBuffer(s: string, enc?: string): Buffer {
  if (enc === "base64url") return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return Buffer.from(s, (enc as BufferEncoding) ?? "utf8");
}

export function encode(out: Uint8Array, enc?: string): string | Buffer {
  const b = Buffer.from(out);
  if (!enc || enc === "buffer") return b;
  if (enc === "base64url") return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b.toString(enc as BufferEncoding);
}

export const b64u = (b: Uint8Array) => encode(b, "base64url") as string;
export const unb64u = (s: string) => new Uint8Array(strBuffer(s, "base64url"));
