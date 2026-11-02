import { Buffer } from "buffer";

export { Buffer };

// The `buffer` package predates "base64url" (its base64 decoder already accepts the URL alphabet).
const B = Buffer as unknown as { from: (...a: unknown[]) => unknown; isEncoding: (e: unknown) => boolean };
const { from, isEncoding } = B;
B.from = (v, a, b) => from.call(Buffer, v, v !== null && typeof v === "string" && a === "base64url" ? "base64" : a, b);
B.isEncoding = (e) => e === "base64url" || isEncoding(e);
const toString = Buffer.prototype.toString;
Buffer.prototype.toString = function (this: Buffer, enc?: BufferEncoding, ...rest: [number?, number?]) {
  if (enc !== ("base64url" as string)) return toString.call(this, enc, ...rest);
  return toString.call(this, "base64", ...rest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export default {
  Buffer,
  SlowBuffer: Buffer,
  kMaxLength: 2 ** 32,
  kStringMaxLength: 2 ** 29 - 24,
  INSPECT_MAX_BYTES: 50,
  constants: { MAX_LENGTH: 2 ** 32, MAX_STRING_LENGTH: 2 ** 29 - 24 },
  Blob,
  File,
  atob,
  btoa,
  isUtf8: (b: ArrayBufferView) => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b);
      return true;
    } catch {
      return false;
    }
  },
  isAscii: (b: ArrayBufferView) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength).every((x) => x < 128),
};
